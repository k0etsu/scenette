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
});

describe("email verification removed", () => {
  // Email verification (and its SES dependency) was removed to keep
  // registration/testing simple without needing SES set up -- neither the
  // SES identity nor the email-verifications table should exist anymore.
  it("creates no SES::EmailIdentity in either stack", () => {
    expect(devTemplate.findResources("AWS::SES::EmailIdentity")).toEqual({});
    expect(prodTemplate.findResources("AWS::SES::EmailIdentity")).toEqual({});
  });

  it("creates no email-verifications DynamoDB table", () => {
    const tables = devTemplate.findResources("AWS::DynamoDB::Table");
    const names = Object.values(tables).map((t: any) => t.Properties?.TableName);
    expect(names).not.toContain("scenette-dev-email-verifications");
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

  it("no longer registers the removed /auth/verify or /auth/resend-verification routes", () => {
    const routes = devTemplate.findResources("AWS::ApiGatewayV2::Route");
    const routeKeys = Object.values(routes).map((r: any) => r.Properties?.RouteKey);
    expect(routeKeys).not.toContain("GET /auth/verify");
    expect(routeKeys).not.toContain("POST /auth/resend-verification");
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
