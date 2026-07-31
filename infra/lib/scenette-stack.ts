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
import * as ses from "aws-cdk-lib/aws-ses";
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
    // Listing/revoking a room's current mods (see AccountsFn's
    // GET/DELETE /auth/rooms/{roomId}/members) needs "all memberships for
    // this room" -- the base table's key schema only supports "all
    // memberships for this account".
    membershipsTable.addGlobalSecondaryIndex({
      indexName: "byRoom",
      partitionKey: { name: "roomId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "accountId", type: dynamodb.AttributeType.STRING },
    });

    const invitesTable = new dynamodb.Table(this, "InvitesTable", {
      tableName: `scenette-${envName}-invites`,
      partitionKey: { name: "inviteToken", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy,
    });
    // Listing a room's pending invites (see AccountsFn's
    // GET /auth/rooms/{roomId}/invites) needs "all invites for this room" --
    // redemption itself still goes straight to the base table by token.
    invitesTable.addGlobalSecondaryIndex({
      indexName: "byRoom",
      partitionKey: { name: "roomId", type: dynamodb.AttributeType.STRING },
    });

    // Username/password accounts, gated by email verification (see
    // AccountsFn below) -- the one and only auth path, not a stopgap for
    // something else. Session tokens are opaque (crypto.randomUUID, not
    // signed) and looked up against this table, so logout/expiry is just a
    // row delete/TTL — no signing secret to manage.
    const accountsTable = new dynamodb.Table(this, "AccountsTable", {
      tableName: `scenette-${envName}-accounts`,
      partitionKey: { name: "username", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy,
    });

    const sessionsTable = new dynamodb.Table(this, "SessionsTable", {
      tableName: `scenette-${envName}-sessions`,
      partitionKey: { name: "sessionToken", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "ttl",
      removalPolicy,
    });

    // Opaque email-verification tokens, same shape/rationale as
    // SessionsTable -- a 24h TTL means a stale/unused link just silently
    // expires rather than needing explicit cleanup.
    const emailVerificationsTable = new dynamodb.Table(this, "EmailVerificationsTable", {
      tableName: `scenette-${envName}-email-verifications`,
      partitionKey: { name: "token", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "ttl",
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

    const controlUiDomain = envName === "prod" ? HANZOMON_ZONE_NAME : `dev.${HANZOMON_ZONE_NAME}`;
    const browserSourceDomain =
      envName === "prod" ? `obs.${HANZOMON_ZONE_NAME}` : `dev-obs.${HANZOMON_ZONE_NAME}`;

    const hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, "HostedZone", {
      hostedZoneId: HANZOMON_ZONE_ID,
      zoneName: HANZOMON_ZONE_NAME,
    });

    // ---- Email (SES) ----
    //
    // SES identity verification is account+region scoped, not
    // CloudFormation-stack scoped -- creating this construct in both
    // Scenette-dev and Scenette-prod would have both stacks fight over
    // ownership of the same physical SES identity. Verified once, only when
    // deploying prod (which already owns the hanzomon.co apex domain for its
    // own CloudFront distribution); both envs share the one verified domain
    // and just use a different From-address local-part, since verifying a
    // domain in SES authorizes sending from any address @ that domain.
    if (envName === "prod") {
      new ses.EmailIdentity(this, "MailIdentity", {
        identity: ses.Identity.publicHostedZone(hostedZone),
      });
    }
    const verificationFromAddress = envName === "prod" ? `noreply@${HANZOMON_ZONE_NAME}` : `dev-noreply@${HANZOMON_ZONE_NAME}`;
    const mailIdentityArn = `arn:aws:ses:${this.region}:${this.account}:identity/${HANZOMON_ZONE_NAME}`;

    // ---- WebSocket API ----

    // 256MB rather than the 128MB default: Lambda's init-phase CPU scales
    // with configured memory, so this directly cuts cold-start latency on
    // these three -- they're on the critical path for how responsive a
    // drag/pan/resize feels the moment a room's connections go cold (no
    // traffic for ~5-15 min). At this workload's invocation volume the cost
    // delta is negligible; it's not a real cost/latency trade-off here.
    const connectFn = new lambdaNode.NodejsFunction(this, "ConnectFn", {
      entry: path.join(__dirname, "../../services/websocket-handlers/src/connect.ts"),
      runtime: lambda.Runtime.NODEJS_22_X,
      memorySize: 256,
      environment: {
        CONNECTIONS_TABLE: connectionsTable.tableName,
        SESSIONS_TABLE: sessionsTable.tableName,
        MEMBERSHIPS_TABLE: membershipsTable.tableName,
      },
    });
    // Read+write: still writes its own connection row, but also needs read
    // access for broadcastToRoom's Query (announcing presence:joined to
    // everyone else already in the room). Read-only on sessionsTable/
    // membershipsTable -- it only ever resolves a token to a username and
    // checks (never grants/revokes) membership.
    connectionsTable.grantReadWriteData(connectFn);
    sessionsTable.grantReadData(connectFn);
    membershipsTable.grantReadData(connectFn);

    const disconnectFn = new lambdaNode.NodejsFunction(this, "DisconnectFn", {
      entry: path.join(__dirname, "../../services/websocket-handlers/src/disconnect.ts"),
      runtime: lambda.Runtime.NODEJS_22_X,
      memorySize: 256,
      environment: { CONNECTIONS_TABLE: connectionsTable.tableName },
    });
    // Read+write: now reads the departing connection's row (for its
    // username/roomId) before deleting it, and broadcastToRoom's Query needs
    // read access too (announcing presence:left).
    connectionsTable.grantReadWriteData(disconnectFn);

    const messageFn = new lambdaNode.NodejsFunction(this, "MessageFn", {
      entry: path.join(__dirname, "../../services/websocket-handlers/src/message.ts"),
      runtime: lambda.Runtime.NODEJS_22_X,
      memorySize: 256,
      environment: {
        CONNECTIONS_TABLE: connectionsTable.tableName,
        ASSETS_TABLE: assetsTable.tableName,
        ROOMS_TABLE: roomsTable.tableName,
        ASSETS_BUCKET: assetsBucket.bucketName,
      },
    });
    connectionsTable.grantReadWriteData(messageFn);
    assetsTable.grantReadWriteData(messageFn);
    roomsTable.grantReadWriteData(messageFn);
    // Read (HeadObject, to server-verify an uploaded asset's byte size for
    // the storage quota) + delete (asset:delete removes the S3 object once
    // nothing else still references it) -- never write, this Lambda never
    // uploads anything itself.
    assetsBucket.grantRead(messageFn);
    assetsBucket.grantDelete(messageFn);

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
    // connect/disconnect now also broadcast presence:joined/presence:left
    // (via PostToConnection), not just messageFn's asset broadcasts.
    webSocketApi.grantManageConnections(connectFn);
    webSocketApi.grantManageConnections(disconnectFn);

    const httpApi = new apigwv2.HttpApi(this, "HttpApi", {
      apiName: `scenette-${envName}-http`,
      corsPreflight: {
        // TODO: same as the S3 bucket's CORS above — restrict to the deployed
        // control-ui origin once it's hosted somewhere with a known domain.
        allowOrigins: ["*"],
        // DELETE (revoke invite/member) is a non-"simple" cross-origin
        // method -- the browser always preflights it first, and without it
        // listed here that preflight fails, silently blocking every revoke
        // request client-side with a CORS error before it ever reaches API
        // Gateway.
        allowMethods: [apigwv2.CorsHttpMethod.GET, apigwv2.CorsHttpMethod.POST, apigwv2.CorsHttpMethod.DELETE],
        allowHeaders: ["*"],
      },
    });

    // ---- Upload URL (HTTP API) ----

    // Adjustable per-room cap on total (deduplicated-by-s3Key) stored bytes
    // -- same for dev/prod since there's no cost-driven reason to differ.
    // See upload-url/src/index.ts for why this is enforced coarsely
    // (already-over-quota blocks further uploads) rather than precisely.
    const ROOM_STORAGE_QUOTA_BYTES = 500 * 1024 * 1024; // 500 MB

    const uploadUrlFn = new lambdaNode.NodejsFunction(this, "UploadUrlFn", {
      entry: path.join(__dirname, "../../services/upload-url/src/index.ts"),
      runtime: lambda.Runtime.NODEJS_22_X,
      environment: {
        ASSETS_BUCKET: assetsBucket.bucketName,
        ASSETS_TABLE: assetsTable.tableName,
        SESSIONS_TABLE: sessionsTable.tableName,
        MEMBERSHIPS_TABLE: membershipsTable.tableName,
        ROOM_STORAGE_QUOTA_BYTES: String(ROOM_STORAGE_QUOTA_BYTES),
      },
    });
    // Write-only on the bucket — this Lambda only ever needs to mint
    // presigned PUT URLs, never to read or list what's already there.
    // Read-only on assets/sessions/memberships -- sums existing usage for
    // the quota check and resolves+checks the caller's membership, same as
    // ConnectFn/MessageFn.
    assetsBucket.grantPut(uploadUrlFn);
    assetsTable.grantReadData(uploadUrlFn);
    sessionsTable.grantReadData(uploadUrlFn);
    membershipsTable.grantReadData(uploadUrlFn);

    httpApi.addRoutes({
      path: "/assets/upload-url",
      methods: [apigwv2.HttpMethod.GET],
      integration: new apigwv2Integrations.HttpLambdaIntegration(
        "UploadUrlIntegration",
        uploadUrlFn
      ),
    });

    // ---- Accounts (lightweight username/password auth, HTTP API) ----

    const accountsFn = new lambdaNode.NodejsFunction(this, "AccountsFn", {
      entry: path.join(__dirname, "../../services/accounts/src/index.ts"),
      runtime: lambda.Runtime.NODEJS_22_X,
      environment: {
        ACCOUNTS_TABLE: accountsTable.tableName,
        SESSIONS_TABLE: sessionsTable.tableName,
        MEMBERSHIPS_TABLE: membershipsTable.tableName,
        EMAIL_VERIFICATIONS_TABLE: emailVerificationsTable.tableName,
        INVITES_TABLE: invitesTable.tableName,
        VERIFICATION_FROM_ADDRESS: verificationFromAddress,
        HTTP_API_URL: httpApi.apiEndpoint,
      },
    });
    accountsTable.grantReadWriteData(accountsFn);
    sessionsTable.grantReadWriteData(accountsFn);
    membershipsTable.grantReadWriteData(accountsFn);
    emailVerificationsTable.grantReadWriteData(accountsFn);
    invitesTable.grantReadWriteData(accountsFn);
    // Least-privilege: only this one verified identity, never any other
    // address/domain in the account.
    accountsFn.addToRolePolicy(
      new cdk.aws_iam.PolicyStatement({
        actions: ["ses:SendEmail", "ses:SendRawEmail"],
        resources: [mailIdentityArn],
      })
    );

    const accountsIntegration = new apigwv2Integrations.HttpLambdaIntegration(
      "AccountsIntegration",
      accountsFn
    );
    httpApi.addRoutes({
      path: "/auth/register",
      methods: [apigwv2.HttpMethod.POST],
      integration: accountsIntegration,
    });
    httpApi.addRoutes({
      path: "/auth/login",
      methods: [apigwv2.HttpMethod.POST],
      integration: accountsIntegration,
    });
    // Opened directly (a link clicked in the verification email), not
    // fetched via JS -- returns an HTML confirmation page rather than JSON.
    httpApi.addRoutes({
      path: "/auth/verify",
      methods: [apigwv2.HttpMethod.GET],
      integration: accountsIntegration,
    });
    httpApi.addRoutes({
      path: "/auth/resend-verification",
      methods: [apigwv2.HttpMethod.POST],
      integration: accountsIntegration,
    });
    httpApi.addRoutes({
      path: "/auth/logout",
      methods: [apigwv2.HttpMethod.POST],
      integration: accountsIntegration,
    });
    httpApi.addRoutes({
      path: "/auth/session",
      methods: [apigwv2.HttpMethod.GET],
      integration: accountsIntegration,
    });
    httpApi.addRoutes({
      path: "/auth/rooms",
      methods: [apigwv2.HttpMethod.GET],
      integration: accountsIntegration,
    });
    httpApi.addRoutes({
      path: "/auth/rooms/{roomId}/members",
      methods: [apigwv2.HttpMethod.GET],
      integration: accountsIntegration,
    });
    httpApi.addRoutes({
      path: "/auth/rooms/{roomId}/members/{username}",
      methods: [apigwv2.HttpMethod.DELETE],
      integration: accountsIntegration,
    });
    httpApi.addRoutes({
      path: "/auth/rooms/{roomId}/invites",
      methods: [apigwv2.HttpMethod.POST, apigwv2.HttpMethod.GET],
      integration: accountsIntegration,
    });
    httpApi.addRoutes({
      path: "/auth/rooms/{roomId}/invites/{inviteToken}",
      methods: [apigwv2.HttpMethod.DELETE],
      integration: accountsIntegration,
    });
    httpApi.addRoutes({
      path: "/auth/invites/{inviteToken}/redeem",
      methods: [apigwv2.HttpMethod.POST],
      integration: accountsIntegration,
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
    // Runtime config written alongside the static build output — the app
    // fetches /config.json on load instead of requiring wsUrl/httpApiUrl as
    // manual query params, since those values are only known once this
    // stack's own WebSocket/HTTP APIs exist (i.e. right here, at deploy
    // time), not at the app's build time.
    //
    // cacheControl: without this, S3 sends no caching header at all, which
    // browsers still cache heuristically — a tab left open (or even just
    // reopened) across a deploy can keep running the previous main.js
    // indefinitely with no visible sign anything's stale. "no-cache" forces
    // a revalidation request on every load rather than disabling caching
    // outright, so a deploy takes effect on next visit without needing a
    // manual hard refresh.
    const noCache = [s3deploy.CacheControl.noCache(), s3deploy.CacheControl.mustRevalidate()];
    new s3deploy.BucketDeployment(this, "ControlUiDeployment", {
      sources: [
        s3deploy.Source.asset(path.join(__dirname, "../../apps/control-ui/dist")),
        s3deploy.Source.jsonData("config.json", {
          wsUrl: webSocketStage.url,
          httpApiUrl: httpApi.apiEndpoint,
          assetsDomain: assetsDistribution.distributionDomainName,
          browserSourceUrl: `https://${browserSourceDomain}`,
        }),
      ],
      destinationBucket: controlUiBucket,
      distribution: controlUiDistribution,
      distributionPaths: ["/*"],
      cacheControl: noCache,
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
      sources: [
        s3deploy.Source.asset(path.join(__dirname, "../../apps/browser-source/dist")),
        s3deploy.Source.jsonData("config.json", {
          wsUrl: webSocketStage.url,
          assetsDomain: assetsDistribution.distributionDomainName,
        }),
      ],
      destinationBucket: browserSourceBucket,
      distribution: browserSourceDistribution,
      distributionPaths: ["/*"],
      cacheControl: noCache,
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
