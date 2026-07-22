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
        "StringLike": { "token.actions.githubusercontent.com:sub": "repo:<owner>/scenette:*" }
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

## 3. Create the prod deploy role — scoped to `main` only

Trust policy (`trust-prod.json`) differs from dev in one line: the `sub`
condition is pinned to `refs/heads/main` specifically, so no other branch, PR,
or fork can ever assume this role, regardless of what the dev role's
credentials can do:

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
          "token.actions.githubusercontent.com:sub": "repo:<owner>/scenette:ref:refs/heads/main"
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
assume the two bootstrap roles the CDK CLI actually needs at deploy/synth time
(the CLI internally chains from `deploy-role` to `file-publishing-role` /
`image-publishing-role` / `cfn-exec-role` as needed — those don't need to be
listed here, only the two the calling identity assumes directly):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "sts:AssumeRole",
      "Resource": [
        "arn:aws:iam::<ACCOUNT_ID>:role/cdk-hnb659fds-deploy-role-<ACCOUNT_ID>-<REGION>",
        "arn:aws:iam::<ACCOUNT_ID>:role/cdk-hnb659fds-lookup-role-<ACCOUNT_ID>-<REGION>"
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

## 5. Provision OAuth app secrets in Secrets Manager (per environment)

Register OAuth apps with Twitch, Google (YouTube), and Discord, then store each
provider's client id/secret pair directly in Secrets Manager — never in
GitHub, never in CDK code:

```bash
aws secretsmanager create-secret \
  --name scenette/dev/oauth/twitch \
  --secret-string '{"clientId":"...","clientSecret":"..."}'
# repeat for youtube, discord, and for the prod/ prefix with prod app credentials
```
