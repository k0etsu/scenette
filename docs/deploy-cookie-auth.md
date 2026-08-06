# Deploying the cookie-auth + email-verification change

This change (PR: security hardening) alters two things that are **not** safe to
land with a blind `cdk deploy`, because they involve ACM certificate
replacement, API Gateway custom domains, cross-stack SES, and a one-way CORS
transition. Follow this order.

## Why the extra care

- **CORS is not freely reversible.** Cookie auth requires
  `allowCredentials: true` with an **exact** origin. API Gateway rejects
  `allowCredentials: true` combined with `allowOrigins: ["*"]`. So a stack that
  is on `{ origin: "*" }` cannot be updated straight to
  `{ exact-origin, credentials: true }` and back again unless **both** sides
  always set `allowCredentials` explicitly. The cookie branch sets it `true`
  explicitly; the pre-cookie (`dev`/`main`) CORS block must set
  `allowCredentials: false` explicitly, or the revert `UPDATE_FAILED`s.
- **Custom domains + cert are slow.** Adding `api.`/`ws.` as cert SANs replaces
  the ACM cert (needs DNS validation) and re-associates both CloudFront
  distributions. Expect **15–30+ min** for the first deploy and for any revert,
  not the usual ~3 min. This is normal; do not cancel (cancelling the GitHub
  Action does not stop the CloudFormation update anyway).
- **SES: sender identity vs. sandbox are two different things.**
  - The DKIM'd *sender identity* is created per-env by that env's own stack
    (prod verifies `hanzomon.co`, dev verifies `dev.hanzomon.co`) — no
    prod-first dependency. The first deploy of an env registers the identity
    and writes its DKIM CNAMEs into the hosted zone; SES validates them within
    minutes.
  - *Sandbox mode* (which restricts sending to verified **recipients**) is an
    **account + region-level** setting, lifted once via an AWS Support request.
    It has nothing to do with deploying any stack. Until it's lifted, add the
    recipient addresses you want to test with as verified identities in the SES
    console.
- **Shared dev auto-deploy.** `deploy-dev.yml` now auto-deploys **only** the
  `dev` branch; deploy a feature branch to dev **deliberately** via the Actions
  "Run workflow" button, never by pushing the branch.

## One-time prerequisites

1. **Merge the workflow guardrail** (this PR's `deploy-dev.yml` change) to `dev`
   and `main` so no feature branch can auto-deploy the shared dev stack.
2. **Make the pre-cookie CORS explicit** on `dev`/`main` so reverts stay legal:
   in `infra/lib/scenette-stack.ts`, the `corsPreflight` block with
   `allowOrigins: ["*"]` must also set `allowCredentials: false,`.
3. **Request SES production access** for the region (Support → SES sending
   limits) — an account-level, one-time step. Until granted, SES only mails
   recipients you've verified in the SES console (fine for testing). Not tied
   to any deploy; each env registers its own sender identity on first deploy.

## Deploying the change

5. Merge/deploy the change to **dev** (merge to `dev`, or workflow_dispatch the
   branch). The first deploy is slow (cert/CloudFront) — let it finish.
6. Verify end-to-end on `dev.hanzomon.co`:
   - Register (no email) → dashboard shows "verify your email to get a room";
     no room exists yet.
   - Add an email → receive SES mail → click the link → room appears; owner WS
     connect works.
   - Invite a mod → the (unverified) mod can use that room but has no room of
     their own.
   - Confirm login/register set an `HttpOnly` cookie, authed `fetch`es work
     cross-subdomain with `credentials: "include"`, and the WS handshake
     authenticates from the cookie (no `?token=` in the URL).
   - Delete an account → tables + S3 + verification rows cleaned, cookie cleared.
7. **Promote to prod**: merge `dev` → `main`; `Scenette-prod` deploys.

## If a deploy fails on the CORS rule

Symptom: `UPDATE_FAILED` — *"allow-credentials is not supported if
'allow-origin' is *"*. Fix: set the target CORS `allowCredentials` explicitly
(see prerequisite 2), or, as a one-off unblock, toggle
Access-Control-Allow-Credentials **off** on the live `scenette-<env>-http` API
in the console, then re-run the deploy.
