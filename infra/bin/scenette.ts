#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { ScenetteStack } from "../lib/scenette-stack";

const app = new cdk.App();
const region = process.env.CDK_DEFAULT_REGION ?? "us-east-1";
const account = process.env.CDK_DEFAULT_ACCOUNT;

new ScenetteStack(app, "Scenette-dev", {
  envName: "dev",
  env: { account, region },
});

new ScenetteStack(app, "Scenette-prod", {
  envName: "prod",
  env: { account, region },
});
