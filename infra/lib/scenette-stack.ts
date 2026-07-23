import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as lambdaNode from "aws-cdk-lib/aws-lambda-nodejs";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as apigwv2Integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as route53Targets from "aws-cdk-lib/aws-route53-targets";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import * as path from "path";

// hanzomon.co's Route 53 hosted zone — pinned by ID rather than looked up via
// HostedZone.fromLookup so `cdk synth`/`diff` don't need a live AWS lookup
// (and the extra IAM permissions/context caching that implies) on every run.
const HANZOMON_ZONE_ID = "Z06216423KUWM1AVEX4OA";
const HANZOMON_ZONE_NAME = "hanzomon.co";

export interface ScenetteStackProps extends cdk.StackProps {
  envName: "dev" | "prod";
}

// One CDK app synthesizes both Scenette-dev and Scenette-prod stacks from this
// same construct — see bin/scenette.ts. Every resource name is suffixed with
// envName so the two environments never share state, per the plan's
// "single account, stack-suffix split" decision.
export class ScenetteStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ScenetteStackProps) {
    super(scope, id, props);

    const { envName } = props;
    const removalPolicy =
      envName === "prod" ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY;

    // ---- DynamoDB tables ----

    const connectionsTable = new dynamodb.Table(this, "ConnectionsTable", {
      tableName: `scenette-${envName}-connections`,
      partitionKey: { name: "connectionId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "ttl",
      removalPolicy,
    });
    connectionsTable.addGlobalSecondaryIndex({
      indexName: "byRoom",
      partitionKey: { name: "roomId", type: dynamodb.AttributeType.STRING },
    });

    const roomsTable = new dynamodb.Table(this, "RoomsTable", {
      tableName: `scenette-${envName}-rooms`,
      partitionKey: { name: "roomId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy,
    });

    const membershipsTable = new dynamodb.Table(this, "MembershipsTable", {
      tableName: `scenette-${envName}-memberships`,
      partitionKey: { name: "accountId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "roomId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy,
    });

    const invitesTable = new dynamodb.Table(this, "InvitesTable", {
      tableName: `scenette-${envName}-invites`,
      partitionKey: { name: "inviteToken", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy,
    });

    // One item per placed asset: roomId+assetId as the key covers both the
    // "all assets in a room" access pattern (used by message.ts to build a
    // snapshot) and the "get one asset" pattern (move/delete) — no GSI needed.
    //
    // Deliberately no explicit `tableName` here (unlike the other tables):
    // CloudFormation refuses to plan an in-place replace for any resource
    // with a custom name — it's a static template-diff check, not a runtime
    // one, so it blocks even after the physical table is manually deleted.
    // This table's key schema is still likely to change during early
    // development, so it's left auto-named to avoid hitting that wall again;
    // every reference to it goes through the CDK token (assetsTable.tableName),
    // never a hardcoded string, so the actual name is irrelevant.
    const assetsTable = new dynamodb.Table(this, "AssetsTable", {
      partitionKey: { name: "roomId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "assetId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy,
    });

    // ---- Media storage (S3 + CloudFront) ----

    const assetsBucket = new s3.Bucket(this, "AssetsBucket", {
      bucketName: `scenette-${envName}-assets-${this.account}`,
      cors: [
        {
          allowedMethods: [s3.HttpMethods.PUT, s3.HttpMethods.GET],
          allowedOrigins: ["*"], // TODO: restrict to the deployed control-ui origin once known
          allowedHeaders: ["*"],
        },
      ],
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy,
      autoDeleteObjects: envName !== "prod",
    });

    const assetsDistribution = new cloudfront.Distribution(this, "AssetsDistribution", {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(assetsBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
    });

    // ---- WebSocket API ----

    const connectFn = new lambdaNode.NodejsFunction(this, "ConnectFn", {
      entry: path.join(__dirname, "../../services/websocket-handlers/src/connect.ts"),
      runtime: lambda.Runtime.NODEJS_22_X,
      environment: { CONNECTIONS_TABLE: connectionsTable.tableName },
    });
    connectionsTable.grantWriteData(connectFn);

    const disconnectFn = new lambdaNode.NodejsFunction(this, "DisconnectFn", {
      entry: path.join(__dirname, "../../services/websocket-handlers/src/disconnect.ts"),
      runtime: lambda.Runtime.NODEJS_22_X,
      environment: { CONNECTIONS_TABLE: connectionsTable.tableName },
    });
    connectionsTable.grantWriteData(disconnectFn);

    const messageFn = new lambdaNode.NodejsFunction(this, "MessageFn", {
      entry: path.join(__dirname, "../../services/websocket-handlers/src/message.ts"),
      runtime: lambda.Runtime.NODEJS_22_X,
      environment: {
        CONNECTIONS_TABLE: connectionsTable.tableName,
        ASSETS_TABLE: assetsTable.tableName,
        ROOMS_TABLE: roomsTable.tableName,
      },
    });
    connectionsTable.grantReadWriteData(messageFn);
    assetsTable.grantReadWriteData(messageFn);
    roomsTable.grantReadWriteData(messageFn);

    const webSocketApi = new apigwv2.WebSocketApi(this, "WebSocketApi", {
      apiName: `scenette-${envName}`,
      connectRouteOptions: {
        integration: new apigwv2Integrations.WebSocketLambdaIntegration(
          "ConnectIntegration",
          connectFn
        ),
      },
      disconnectRouteOptions: {
        integration: new apigwv2Integrations.WebSocketLambdaIntegration(
          "DisconnectIntegration",
          disconnectFn
        ),
      },
      defaultRouteOptions: {
        integration: new apigwv2Integrations.WebSocketLambdaIntegration(
          "MessageIntegration",
          messageFn
        ),
      },
    });

    const webSocketStage = new apigwv2.WebSocketStage(this, "WebSocketStage", {
      webSocketApi,
      stageName: envName,
      autoDeploy: true,
    });

    webSocketApi.grantManageConnections(messageFn);

    // ---- Auth broker (HTTP API) ----

    const authBrokerFn = new lambdaNode.NodejsFunction(this, "AuthBrokerFn", {
      entry: path.join(__dirname, "../../services/auth-broker/src/index.ts"),
      runtime: lambda.Runtime.NODEJS_22_X,
      environment: { SCENETTE_ENV: envName },
    });
    // Least-privilege: only allow reading this env's own OAuth secrets, never
    // the other environment's or anything else in Secrets Manager.
    authBrokerFn.addToRolePolicy(
      new cdk.aws_iam.PolicyStatement({
        actions: ["secretsmanager:GetSecretValue"],
        resources: [
          `arn:aws:secretsmanager:${this.region}:${this.account}:secret:scenette/${envName}/oauth/*`,
        ],
      })
    );
    membershipsTable.grantReadWriteData(authBrokerFn);

    const httpApi = new apigwv2.HttpApi(this, "HttpApi", {
      apiName: `scenette-${envName}-http`,
      corsPreflight: {
        // TODO: same as the S3 bucket's CORS above — restrict to the deployed
        // control-ui origin once it's hosted somewhere with a known domain.
        allowOrigins: ["*"],
        allowMethods: [apigwv2.CorsHttpMethod.GET, apigwv2.CorsHttpMethod.POST],
        allowHeaders: ["*"],
      },
    });
    httpApi.addRoutes({
      path: "/auth/{provider}/{step}",
      methods: [apigwv2.HttpMethod.GET],
      integration: new apigwv2Integrations.HttpLambdaIntegration(
        "AuthBrokerIntegration",
        authBrokerFn
      ),
    });

    // ---- Upload URL (HTTP API) ----

    const uploadUrlFn = new lambdaNode.NodejsFunction(this, "UploadUrlFn", {
      entry: path.join(__dirname, "../../services/upload-url/src/index.ts"),
      runtime: lambda.Runtime.NODEJS_22_X,
      environment: { ASSETS_BUCKET: assetsBucket.bucketName },
    });
    // Write-only — this Lambda only ever needs to mint presigned PUT URLs,
    // never to read or list what's already in the bucket.
    assetsBucket.grantPut(uploadUrlFn);

    httpApi.addRoutes({
      path: "/assets/upload-url",
      methods: [apigwv2.HttpMethod.GET],
      integration: new apigwv2Integrations.HttpLambdaIntegration(
        "UploadUrlIntegration",
        uploadUrlFn
      ),
    });

    // ---- Retention job ----

    const retentionFn = new lambdaNode.NodejsFunction(this, "RetentionFn", {
      entry: path.join(__dirname, "../../services/retention-job/src/index.ts"),
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.minutes(5),
      environment: {
        ASSETS_TABLE: assetsTable.tableName,
        ASSETS_BUCKET: assetsBucket.bucketName,
      },
    });
    assetsTable.grantReadWriteData(retentionFn);
    assetsBucket.grantDelete(retentionFn);

    new events.Rule(this, "RetentionSchedule", {
      schedule: events.Schedule.rate(cdk.Duration.hours(24)),
      targets: [new targets.LambdaFunction(retentionFn)],
    });

    // ---- Frontend hosting (control-ui + browser-source, custom domains) ----
    //
    // control-ui owns the apex/entry point; browser-source gets its own
    // subdomain. Per-room uniqueness is handled entirely by query params on
    // that one browser-source URL (?roomId=...&wsUrl=...) — there's no
    // per-room subdomain/path infra here by design.
    const controlUiDomain = envName === "prod" ? HANZOMON_ZONE_NAME : `dev.${HANZOMON_ZONE_NAME}`;
    const browserSourceDomain =
      envName === "prod" ? `obs.${HANZOMON_ZONE_NAME}` : `dev-obs.${HANZOMON_ZONE_NAME}`;

    const hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, "HostedZone", {
      hostedZoneId: HANZOMON_ZONE_ID,
      zoneName: HANZOMON_ZONE_NAME,
    });

    // One SAN certificate per env covering both domains — CloudFront requires
    // the certificate to live in us-east-1, which is where this stack already
    // deploys, so no cross-region certificate construct is needed.
    const certificate = new acm.Certificate(this, "FrontendCertificate", {
      domainName: controlUiDomain,
      subjectAlternativeNames: [browserSourceDomain],
      validation: acm.CertificateValidation.fromDns(hostedZone),
    });

    const controlUiBucket = new s3.Bucket(this, "ControlUiBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy,
      autoDeleteObjects: envName !== "prod",
    });
    const controlUiDistribution = new cloudfront.Distribution(this, "ControlUiDistribution", {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(controlUiBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
      defaultRootObject: "index.html",
      domainNames: [controlUiDomain],
      certificate,
    });
    new s3deploy.BucketDeployment(this, "ControlUiDeployment", {
      sources: [s3deploy.Source.asset(path.join(__dirname, "../../apps/control-ui/dist"))],
      destinationBucket: controlUiBucket,
      distribution: controlUiDistribution,
      distributionPaths: ["/*"],
    });

    const browserSourceBucket = new s3.Bucket(this, "BrowserSourceBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy,
      autoDeleteObjects: envName !== "prod",
    });
    const browserSourceDistribution = new cloudfront.Distribution(this, "BrowserSourceDistribution", {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(browserSourceBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
      defaultRootObject: "index.html",
      domainNames: [browserSourceDomain],
      certificate,
    });
    new s3deploy.BucketDeployment(this, "BrowserSourceDeployment", {
      sources: [s3deploy.Source.asset(path.join(__dirname, "../../apps/browser-source/dist"))],
      destinationBucket: browserSourceBucket,
      distribution: browserSourceDistribution,
      distributionPaths: ["/*"],
    });

    for (const [id, domain, distribution] of [
      ["ControlUi", controlUiDomain, controlUiDistribution],
      ["BrowserSource", browserSourceDomain, browserSourceDistribution],
    ] as const) {
      const target = route53.RecordTarget.fromAlias(new route53Targets.CloudFrontTarget(distribution));
      const recordName = domain === HANZOMON_ZONE_NAME ? undefined : domain.slice(0, -(HANZOMON_ZONE_NAME.length + 1));
      new route53.ARecord(this, `${id}AliasRecordA`, { zone: hostedZone, recordName, target });
      new route53.AaaaRecord(this, `${id}AliasRecordAAAA`, { zone: hostedZone, recordName, target });
    }

    // ---- Outputs ----

    new cdk.CfnOutput(this, "WebSocketUrl", {
      value: `${webSocketStage.url}`,
    });
    new cdk.CfnOutput(this, "HttpApiUrl", {
      value: httpApi.apiEndpoint,
    });
    new cdk.CfnOutput(this, "AssetsBucketName", {
      value: assetsBucket.bucketName,
    });
    new cdk.CfnOutput(this, "AssetsDistributionDomain", {
      value: assetsDistribution.distributionDomainName,
    });
    new cdk.CfnOutput(this, "ControlUiUrl", {
      value: `https://${controlUiDomain}`,
    });
    new cdk.CfnOutput(this, "BrowserSourceUrl", {
      value: `https://${browserSourceDomain}`,
    });
  }
}
