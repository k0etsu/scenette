import { describe, it, expect, beforeAll } from "vitest";
import * as cdk from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import { ScenetteStack } from "../lib/scenette-stack";

function synthTemplate(envName: "dev" | "prod"): Template {
  const app = new cdk.App();
  const stack = new ScenetteStack(app, `Test-${envName}`, {
    envName,
    env: { account: "123456789012", region: "us-east-1" },
  });
  return Template.fromStack(stack);
}

// CDK synth is genuinely expensive (assembling the full construct tree,
// bundling every Lambda) -- synthesized once per env and shared across
// every assertion below, rather than once per test.
let devTemplate: Template;
let prodTemplate: Template;

beforeAll(() => {
  devTemplate = synthTemplate("dev");
  prodTemplate = synthTemplate("prod");
}, 60_000);

describe("HTTP API CORS", () => {
  // Regression: DELETE (used by revoke invite/revoke member) is a
  // non-"simple" cross-origin method -- the browser always preflights it,
  // and without DELETE listed here that preflight silently fails, blocking
  // every revoke request client-side before it ever reaches API Gateway.
  // This looked exactly like an unresponsive button with no visible error.
  it("allows DELETE in the CORS preflight, alongside GET/POST", () => {
    devTemplate.hasResourceProperties("AWS::ApiGatewayV2::Api", {
      CorsConfiguration: Match.objectLike({
        AllowMethods: Match.arrayWith(["GET", "POST", "DELETE"]),
      }),
    });
  });

  it("uses credentialed CORS pinned to exact origins (not '*'), incl. browser-source", () => {
    devTemplate.hasResourceProperties("AWS::ApiGatewayV2::Api", {
      CorsConfiguration: Match.objectLike({
        AllowCredentials: true,
        AllowOrigins: Match.arrayWith(["https://dev.hanzomon.co", "https://dev-obs.hanzomon.co"]),
      }),
    });
  });
});

describe("browser-source URL obfuscation", () => {
  it("gives the rooms table a byObsKey GSI to resolve the opaque key", () => {
    devTemplate.hasResourceProperties("AWS::DynamoDB::Table", {
      TableName: "scenette-dev-rooms",
      GlobalSecondaryIndexes: Match.arrayWith([Match.objectLike({ IndexName: "byObsKey" })]),
    });
  });

  it("registers the owner, obs-url, and public resolve routes", () => {
    const routes = devTemplate.findResources("AWS::ApiGatewayV2::Route");
    const routeKeys = Object.values(routes).map((r: any) => r.Properties?.RouteKey);
    expect(routeKeys).toContain("GET /auth/rooms/{roomId}/owner");
    expect(routeKeys).toContain("GET /auth/rooms/{roomId}/obs-url");
    expect(routeKeys).toContain("POST /auth/rooms/{roomId}/obs-url"); // regenerate
    expect(routeKeys).toContain("GET /rooms/resolve");
  });
});

describe("cookie-based auth", () => {
  it("gives the HTTP and WS APIs custom domains under the zone (for a shared cookie)", () => {
    const domains = devTemplate.findResources("AWS::ApiGatewayV2::DomainName");
    const names = Object.values(domains).map((d: any) => d.Properties?.DomainName);
    expect(names).toContain("dev-api.hanzomon.co");
    expect(names).toContain("dev-ws.hanzomon.co");
  });

  it("scopes the session cookie to the whole zone via COOKIE_DOMAIN", () => {
    const functions = devTemplate.findResources("AWS::Lambda::Function");
    const accountsFn = Object.values(functions).find(
      (fn: any) => fn.Properties?.Environment?.Variables?.ACCOUNTS_TABLE
    ) as any;
    expect(accountsFn.Properties.Environment.Variables.COOKIE_DOMAIN).toBe(".hanzomon.co");
  });
});

describe("email verification (SES)", () => {
  // Each env owns its own DKIM'd identity (prod the apex, dev a subdomain) so
  // neither depends on the other being deployed.
  it("creates a per-env SES::EmailIdentity for the env's own (sub)domain", () => {
    prodTemplate.hasResourceProperties("AWS::SES::EmailIdentity", { EmailIdentity: "hanzomon.co" });
    devTemplate.hasResourceProperties("AWS::SES::EmailIdentity", { EmailIdentity: "dev.hanzomon.co" });
  });

  it("writes DKIM CNAME records into the hosted zone for the identity", () => {
    const cnames = Object.values(devTemplate.findResources("AWS::Route53::RecordSet")).filter(
      (r: any) => r.Properties?.Type === "CNAME"
    );
    expect(cnames.length).toBeGreaterThanOrEqual(3); // SES Easy DKIM = 3 CNAMEs
  });

  it("creates the email-verifications DynamoDB table with a ttl", () => {
    devTemplate.hasResourceProperties("AWS::DynamoDB::Table", {
      TableName: "scenette-dev-email-verifications",
      TimeToLiveSpecification: { AttributeName: "ttl", Enabled: true },
    });
  });

  it("grants AccountsFn ses:SendEmail and wires the verifications table + from-address", () => {
    const functions = devTemplate.findResources("AWS::Lambda::Function");
    const accountsFn = Object.values(functions).find(
      (fn: any) => fn.Properties?.Environment?.Variables?.ACCOUNTS_TABLE
    ) as any;
    const vars = accountsFn.Properties.Environment.Variables;
    expect(vars.EMAIL_VERIFICATIONS_TABLE).toBeTruthy();
    expect(vars.VERIFICATION_FROM_ADDRESS).toBe("noreply@dev.hanzomon.co");
    devTemplate.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({ Action: Match.arrayWith(["ses:SendEmail", "ses:SendRawEmail"]) }),
        ]),
      }),
    });
  });

  it("registers the /auth/verify and /auth/resend-verification routes", () => {
    const routes = devTemplate.findResources("AWS::ApiGatewayV2::Route");
    const routeKeys = Object.values(routes).map((r: any) => r.Properties?.RouteKey);
    expect(routeKeys).toContain("GET /auth/verify");
    expect(routeKeys).toContain("POST /auth/resend-verification");
  });
});

describe("DynamoDB GSIs the accounts routes depend on", () => {
  it("MembershipsTable has a byRoom GSI (for listing/revoking a room's members)", () => {
    devTemplate.hasResourceProperties("AWS::DynamoDB::Table", {
      TableName: "scenette-dev-memberships",
      GlobalSecondaryIndexes: Match.arrayWith([Match.objectLike({ IndexName: "byRoom" })]),
    });
  });

  it("InvitesTable has a byRoom GSI (for listing a room's pending invites)", () => {
    devTemplate.hasResourceProperties("AWS::DynamoDB::Table", {
      TableName: "scenette-dev-invites",
      GlobalSecondaryIndexes: Match.arrayWith([Match.objectLike({ IndexName: "byRoom" })]),
    });
  });
});

describe("durability & abuse hardening", () => {
  it("enables point-in-time recovery on durable tables in prod", () => {
    for (const name of ["accounts", "memberships", "rooms", "invites"]) {
      prodTemplate.hasResourceProperties("AWS::DynamoDB::Table", {
        TableName: `scenette-prod-${name}`,
        PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
      });
    }
  });

  it("leaves point-in-time recovery off in dev (throwaway, cost-saving)", () => {
    devTemplate.hasResourceProperties("AWS::DynamoDB::Table", {
      TableName: "scenette-dev-accounts",
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: false },
    });
  });

  it("gives the invites table a ttl so expired links are swept", () => {
    devTemplate.hasResourceProperties("AWS::DynamoDB::Table", {
      TableName: "scenette-dev-invites",
      TimeToLiveSpecification: { AttributeName: "ttl", Enabled: true },
    });
  });

  it("throttles both API stages against floods / cost amplification", () => {
    const stages = devTemplate.findResources("AWS::ApiGatewayV2::Stage");
    const throttled = Object.values(stages).filter(
      (s: any) =>
        s.Properties?.DefaultRouteSettings?.ThrottlingRateLimit === 100 &&
        s.Properties?.DefaultRouteSettings?.ThrottlingBurstLimit === 200
    );
    // Both the WebSocket stage and the HTTP API's default stage.
    expect(throttled.length).toBeGreaterThanOrEqual(2);
  });
});

describe("account-deletion cascade routes/permissions", () => {
  it("registers the change-password, change-email, and delete-account routes", () => {
    devTemplate.hasResourceProperties("AWS::ApiGatewayV2::Route", {
      RouteKey: "POST /auth/change-password",
    });
    devTemplate.hasResourceProperties("AWS::ApiGatewayV2::Route", {
      RouteKey: "POST /auth/change-email",
    });
    devTemplate.hasResourceProperties("AWS::ApiGatewayV2::Route", {
      RouteKey: "DELETE /auth/account",
    });
  });

  it("gives AccountsFn the ROOMS_TABLE/ASSETS_TABLE/ASSETS_BUCKET env vars its cascade needs", () => {
    const functions = devTemplate.findResources("AWS::Lambda::Function");
    // AccountsFn is the only Lambda with an ACCOUNTS_TABLE env var -- find
    // it that way rather than depending on its exact logical ID.
    const accountsFn = Object.values(functions).find(
      (fn: any) => fn.Properties?.Environment?.Variables?.ACCOUNTS_TABLE
    ) as any;
    expect(accountsFn).toBeTruthy();
    const vars = accountsFn.Properties.Environment.Variables;
    expect(vars.ROOMS_TABLE).toBeTruthy();
    expect(vars.ASSETS_TABLE).toBeTruthy();
    expect(vars.ASSETS_BUCKET).toBeTruthy();
  });
});
