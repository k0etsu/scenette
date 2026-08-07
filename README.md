# scenette

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL%20v3-blue.svg)](LICENSE)

A self-hosted, streamer-collaborative canvas overlay tool. Drag images/gifs/videos/audio/text onto a shared canvas; whatever intersects the fixed viewport rectangle goes live in an OBS browser source, in real time, for every trusted collaborator (streamer + invited mods).

Built as an open-source, AWS-hosted alternative to overlay tools that are moving behind a paywall.

## Status

Live — both environments are deployed via CDK and CI/CD:

- **dev** — https://dev.hanzomon.co (API `dev-api`, WS `dev-ws`, browser source `dev-obs`)
- **prod** — https://hanzomon.co (API `api`, WS `ws`, browser source `obs`)

Working today: username/password accounts with `HttpOnly` cookie sessions, real-time collaborative canvas (drag/zoom/pan, images/gifs/videos/audio), text and template-variable assets, a Twitch/YouTube stream-embed preview, invite-based mod access, owner-rotatable browser-source URLs, per-room storage quotas, and an admin announcement banner.

> **Prod caveat:** SES production access has not been granted for this AWS account, so the accounts service can only send verification email to SES-verified addresses. Because verifying an email is what creates a user's personal room, **room creation is effectively unavailable on prod** until sandbox access is lifted — the dashboard shows an announcement to that effect. Everything else (mod access to existing rooms, the canvas, the browser source) works. See "Deploying".

## Repo layout

```
infra/                   CDK app (TypeScript) — all AWS resources, parameterized per env (dev/prod)
packages/
  protocol/              Shared client/server message types + validation (geometry, assets, text style, variables)
  ws-client/             Reconnecting WebSocket client (survives API Gateway's 2h/idle limits), used by both apps
services/
  websocket-handlers/    Lambda handlers for the WebSocket API ($connect / $disconnect / message) — the live sync path
  accounts/              Username/password auth over the HTTP API: register/login (HttpOnly session cookie), room
                         membership + invites, and SES email verification (verifying an email creates that user's own
                         room; mods on someone else's room don't need to)
  upload-url/            Mints scoped, presigned S3 PUT URLs for media upload; enforces the per-room storage quota
  retention-job/         Scheduled Lambda that garbage-collects unused media assets
apps/
  control-ui/            Streamer/mod-facing canvas editor (plain TS + esbuild)
  browser-source/        The read-only page OBS loads; renders live viewport state independently of the control UI
.github/workflows/       CI (build/test/cdk synth on PRs) + separate dev/prod deploy workflows via GitHub OIDC
```

## Environments

One AWS account, split by CDK stack name — `Scenette-dev` and `Scenette-prod` — each with independent DynamoDB tables, S3 buckets, a DKIM'd SES sender identity, custom domains, and API Gateway stages. **Pushes to `dev` deploy `Scenette-dev`; merges to `main` deploy `Scenette-prod`.** Feature branches do **not** auto-deploy — deploy one on demand via the Actions "Run workflow" button (`workflow_dispatch`), so an unfinished branch can't overwrite the shared dev environment. Moving to fully separate AWS accounts later only requires re-pointing the OIDC role ARNs — no stack rework.

Each front end fetches `/config.json` (written next to the static build at deploy time) for this env's WebSocket/HTTP endpoints, so there's no build-time or query-param configuration in normal use. Sessions use an `HttpOnly; Secure; SameSite=Lax` cookie scoped to `.hanzomon.co`, named **per environment** (`scenette_session_dev` / `scenette_session_prod`) so dev and prod can share the domain without clobbering each other's login.

## Deploying

Deploys run exclusively through GitHub Actions via OIDC-federated IAM roles — there are no long-lived AWS credentials in this repo or in GitHub secrets. See `.github/workflows/deploy-dev.yml`, `deploy-prod.yml`, and the shared `deploy.yml` they both call (npm ci → build → test → `cdk deploy`).

Required one-time AWS setup (done once by hand — see `docs/aws-setup.md`):
1. Create the `scenette-dev-deploy` / `scenette-prod-deploy` IAM roles with an OIDC trust policy scoped to this repo. The prod role's trust is additionally scoped to the `environment:prod` subject claim, and the "prod" GitHub Environment has a deployment-branch policy restricting it to `main` — so no branch other than `main` can obtain a prod deploy token.
2. Store the role ARNs as GitHub Actions **variables** (not secrets — they're not sensitive) `AWS_DEPLOY_ROLE_ARN_DEV` / `AWS_DEPLOY_ROLE_ARN_PROD`, plus `AWS_REGION`.
3. **Request SES production access** (AWS Support Center → Create case → SES sending limits) for the account/region this deploys to. New SES accounts start in sandbox mode and can only send to verified recipient addresses, so real users can't receive their verification email — which is why prod room creation is currently gated (see Status). This is an account+region-level setting, independent of any stack deploy. (Each env's DKIM'd sender identity — `hanzomon.co` for prod, `dev.hanzomon.co` for dev — is provisioned automatically by that env's own CDK stack; this step only lifts the account-wide sandbox restriction.)

`docs/deploy-cookie-auth.md` covers the rollout specifics for the cookie-auth + email-verification changes. See `.env.example` for the configuration each Lambda expects when a handler is invoked locally against real AWS resources (deployed Lambdas get these wired directly by CDK).

## License

AGPLv3 (see [LICENSE](LICENSE)).
