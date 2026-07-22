# scenette

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL%20v3-blue.svg)](LICENSE)

A self-hosted, streamer-collaborative canvas overlay tool. Drag images/gifs/videos/audio/text onto a shared canvas; whatever intersects the fixed viewport rectangle goes live in an OBS browser source, in real time, for every trusted collaborator (streamer + invited mods).

Built as an open-source, AWS-hosted alternative to overlay tools that are moving behind a paywall.

## Status

Early scaffold — infrastructure and CI/CD are being stood up before feature code. See `docs/` for architecture and setup notes.

## Repo layout

```
infra/                  CDK app (TypeScript) — defines all AWS resources, parameterized per environment (dev/prod)
services/
  websocket-handlers/    Lambda handlers for the API Gateway WebSocket API ($connect / $disconnect / message routes)
  auth-broker/           Lambda-based OAuth2 broker unifying Twitch / YouTube / Discord sign-in
  retention-job/         Scheduled Lambda that garbage-collects unused media assets
apps/
  control-ui/            Streamer/mod-facing canvas editor
  browser-source/        The page OBS loads as a browser source; renders live viewport state independently of the control UI
.github/workflows/       CI (build/lint/synth on every push) + separate dev/prod deploy workflows via GitHub OIDC
```

## Environments

Single AWS account for now, split by CDK stack name: `Scenette-dev` and `Scenette-prod`, each with independent DynamoDB tables, S3 buckets, and API Gateway stages. Non-`main` pushes/PRs deploy `Scenette-dev`; merges to `main` deploy `Scenette-prod`. A future move to fully separate AWS accounts only requires re-pointing the OIDC role ARNs used by the deploy workflows — no stack rework.

## Deploying

Deploys run exclusively through GitHub Actions via OIDC-federated IAM roles — there are no long-lived AWS credentials anywhere in this repo or in GitHub secrets. See `.github/workflows/deploy-dev.yml` and `.github/workflows/deploy-prod.yml`.

Required one-time AWS setup (not automated, done directly in the console/CLI once):
1. Create the `scenette-dev-deploy` and `scenette-prod-deploy` IAM roles with an OIDC trust policy scoped to this repo (prod role additionally scoped to `ref:refs/heads/main` only).
2. Store their role ARNs as GitHub Actions **variables** (not secrets — they're not sensitive) `AWS_DEPLOY_ROLE_ARN_DEV` / `AWS_DEPLOY_ROLE_ARN_PROD`.
3. Provision OAuth app secrets (Twitch/YouTube/Discord client secrets) directly in AWS Secrets Manager per environment — never in GitHub, never in CDK code. CDK only references the secret name/ARN.

See `.env.example` for the runtime configuration each Lambda expects.

## License

AGPLv3 (see [LICENSE](LICENSE)). Chosen deliberately over plain GPLv3: since scenette is a hosted service rather than locally-run software, AGPLv3's network-use clause requires anyone who runs a modified version as their own service to make that modified source available too — not just people who redistribute copies of the code itself.
