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

describe("SES identity", () => {
  // SES identity verification is account+region scoped, not
  // CloudFormation-stack scoped -- creating it in both stacks would have
  // them fight over ownership of the same physical identity.
  it("is only created in the prod stack, never dev", () => {
    expect(devTemplate.findResources("AWS::SES::EmailIdentity")).toEqual({});
    expect(Object.keys(prodTemplate.findResources("AWS::SES::EmailIdentity"))).toHaveLength(1);
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
