# One-time AWS setup (manual, not automated by CI)

These steps provision the trust relationship between GitHub Actions and AWS so
that deploys never need a stored AWS credential. Do this once per AWS account
before the first CI deploy runs. Replace `<owner>` with the actual GitHub org/user.

## 1. Register GitHub as an OIDC identity provider (once per AWS account)

```bash
aws iam create-open-id-connect-provider \
  --url https://token.actions.githubusercontent.com \
  --client-id-list sts.amazonaws.com \
  --thumbprint-list 6938fd4d98bab03faadb97b34396831e3780aea1
```

(Skip if this account already has this provider registered from another project.)

## 2. Create the dev deploy role

**Important — GitHub's `sub` claim format varies per account/repo.** Some
repos (this one included) get immutable owner/repo IDs baked into the
subject claim — `repo:<owner>@<owner_id>/<repo>@<repo_id>:...` — instead of
the plain `repo:<owner>/<repo>:...` form shown in GitHub's own docs. Don't
assume the plain form works; add a temporary debug step to the workflow that
decodes and prints the token before writing the trust policy (see "Verifying
the actual sub claim" below), then match what it actually prints. The
immutable-ID form is arguably better anyway — it keeps working across future
repo renames instead of needing the trust policy updated each time.

Trust policy (`trust-dev.json`) — allows any branch/PR/workflow *within this
repo* to assume the role, since dev is meant to be low-friction to deploy to
from any branch:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "Federated": "arn:aws:iam::<ACCOUNT_ID>:oidc-provider/token.actions.githubusercontent.com" },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" },
        "StringLike": { "token.actions.githubusercontent.com:sub": "repo:<owner>[@<owner_id>]/<repo>[@<repo_id>]:*" }
      }
    }
  ]
}
```

```bash
aws iam create-role \
  --role-name scenette-dev-deploy \
  --assume-role-policy-document file://trust-dev.json
```

Then grant it permission to assume the CDK bootstrap roles (see step 3.5 below) — **not** a broad managed policy like `AdministratorAccess`.

## 3. Create the prod deploy role — scoped to the `prod` environment + a branch policy

If the deploy job specifies `environment: prod` (recommended — it's what lets
you add required reviewers/wait timers on prod later), the `sub` claim
becomes `...:environment:prod` **instead of** a ref-based claim — the
environment name replaces the branch/ref info in the subject entirely. That
means scoping the trust policy to `ref:refs/heads/main` silently never
matches once a job declares an environment. Instead:

1. Scope the trust policy's `sub` condition to `...:environment:prod`.
2. Separately restrict *which branches can even reach that environment* using
   GitHub's own **deployment branch policy** on the `prod` environment
   (Settings → Environments → prod → Deployment branches → restrict to
   `main`). GitHub enforces this before the job's steps run at all, so it's
   not just a cosmetic restriction — a workflow run on any other branch never
   gets far enough to request an OIDC token for this environment.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "Federated": "arn:aws:iam::<ACCOUNT_ID>:oidc-provider/token.actions.githubusercontent.com" },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          "token.actions.githubusercontent.com:sub": "repo:<owner>[@<owner_id>]/<repo>[@<repo_id>]:environment:prod"
        }
      }
    }
  ]
}
```

```bash
aws iam create-role \
  --role-name scenette-prod-deploy \
  --assume-role-policy-document file://trust-prod.json

# Restrict the prod environment to the main branch only:
gh api -X PUT repos/<owner>/scenette/environments/prod \
  -F "deployment_branch_policy[protected_branches]=false" \
  -F "deployment_branch_policy[custom_branch_policies]=true"
gh api -X POST repos/<owner>/scenette/environments/prod/deployment-branch-policies \
  -f "name=main"
```

### Verifying the actual `sub` claim

Add this as a temporary step in the workflow (before the AWS credentials
step), push, read the logs, then delete it — it's how the immutable-ID format
above was discovered in the first place:

```yaml
- name: Debug OIDC token claims
  run: |
    TOKEN=$(curl -sS -H "Authorization: Bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=sts.amazonaws.com" | jq -r '.value')
    echo "$TOKEN" | cut -d. -f2 | base64 -d | jq .
```

## 3.5. Bootstrap CDK, then grant the deploy roles permission to assume the bootstrap roles

Run once per account/region, from an admin-privileged session (root, or an
admin IAM user/role — **not** the day-to-day `scenette-dev-deploy`/CI identity):

```bash
cd infra
npx cdk bootstrap aws://<ACCOUNT_ID>/<REGION>
```

This creates the `CDKToolkit` CloudFormation stack: a small, purpose-built set
of IAM roles (`cdk-hnb659fds-deploy-role-*`, `-file-publishing-role-*`,
`-image-publishing-role-*`, `-lookup-role-*`, `-cfn-exec-role-*`), an S3
staging bucket, and an ECR repo for container assets. This is CDK's own
standard bootstrap pattern — deliberately used **instead of** attaching
`AdministratorAccess` directly to the GitHub-facing roles.

Then grant `scenette-dev-deploy` and `scenette-prod-deploy` permission to
assume the bootstrap roles the CDK CLI assumes **directly** at deploy/synth
time. This is *not* a single chain through `deploy-role` — the CLI assumes
`deploy-role` (for the actual CloudFormation deploy, which itself invokes
`cfn-exec-role`), `lookup-role` (for context lookups like AZs), and
`file-publishing-role`/`image-publishing-role` (for uploading Lambda
code/template assets and container images) all independently. Missing any of
these produces a confusing failure — e.g. omitting `file-publishing-role`
fails asset publishing with `Bucket named '...' exists, but we dont have
access to it`, which reads like a bucket ownership problem but is actually
a missing AssumeRole permission:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "sts:AssumeRole",
      "Resource": [
        "arn:aws:iam::<ACCOUNT_ID>:role/cdk-hnb659fds-deploy-role-<ACCOUNT_ID>-<REGION>",
        "arn:aws:iam::<ACCOUNT_ID>:role/cdk-hnb659fds-lookup-role-<ACCOUNT_ID>-<REGION>",
        "arn:aws:iam::<ACCOUNT_ID>:role/cdk-hnb659fds-file-publishing-role-<ACCOUNT_ID>-<REGION>",
        "arn:aws:iam::<ACCOUNT_ID>:role/cdk-hnb659fds-image-publishing-role-<ACCOUNT_ID>-<REGION>"
      ]
    }
  ]
}
```

```bash
aws iam put-role-policy --role-name scenette-dev-deploy \
  --policy-name assume-cdk-bootstrap-roles --policy-document file://assume-cdk-dev.json
aws iam put-role-policy --role-name scenette-prod-deploy \
  --policy-name assume-cdk-bootstrap-roles --policy-document file://assume-cdk-prod.json
```

Result: neither GitHub-facing role has any direct permissions over your
account. They can only assume the CDK deploy/lookup roles, whose own
permissions (broad, by necessity — CloudFormation needs to manage arbitrary
resource types to deploy a stack) are themselves confined to what `cdk
bootstrap` wires up, not anything CI can expand on its own.

## 4. Store the role ARNs as GitHub Actions repo **variables** (not secrets)

Repo Settings → Secrets and variables → Actions → Variables:
- `AWS_DEPLOY_ROLE_ARN_DEV` = `arn:aws:iam::<ACCOUNT_ID>:role/scenette-dev-deploy`
- `AWS_DEPLOY_ROLE_ARN_PROD` = `arn:aws:iam::<ACCOUNT_ID>:role/scenette-prod-deploy`
- `AWS_REGION` = e.g. `us-east-1`

These are role ARNs, not credentials — safe to be plain (non-secret)
repo variables, and readable in workflow logs without exposing anything
exploitable.
