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

aws iam attach-role-policy \
  --role-name scenette-dev-deploy \
  --policy-arn arn:aws:iam::aws:policy/AdministratorAccess  # TODO: replace with a scoped CDK deploy policy once the stack stabilizes
```

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

aws iam attach-role-policy \
  --role-name scenette-prod-deploy \
  --policy-arn arn:aws:iam::aws:policy/AdministratorAccess  # TODO: same as above — scope down before real users depend on prod
```

**Note:** `AdministratorAccess` is a placeholder to unblock the first `cdk
deploy`. Before this handles real traffic, replace it with a policy scoped to
exactly what CDK needs to manage this stack's resource types (CloudFormation,
Lambda, DynamoDB, S3, CloudFront, API Gateway, EventBridge, IAM
PassRole/CreateRole limited to this stack's Lambda execution roles, and
Secrets Manager read-only on `scenette/<env>/oauth/*`).

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
