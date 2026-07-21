import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { providerConfig, ProviderName } from "./providers";

const secretsManager = new SecretsManagerClient({});
const ENV_NAME = process.env.SCENETTE_ENV!;

// Routes: GET /auth/{provider}/start, GET /auth/{provider}/callback
// TODO(v1): implement the full authorization-code exchange + session JWT
// issuance + account/membership upsert in DynamoDB. This scaffold wires the
// routing and secret-retrieval shape so the CDK stack and IAM permissions can
// be stood up and tested before the OAuth logic itself lands.
export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const provider = event.pathParameters?.provider as ProviderName | undefined;
  const step = event.pathParameters?.step;

  if (!provider || !["twitch", "youtube", "discord"].includes(provider)) {
    return { statusCode: 404, body: "Unknown provider" };
  }

  const config = providerConfig(provider, ENV_NAME);

  if (step === "start") {
    return {
      statusCode: 501,
      body: `TODO: redirect to ${config.authorizeUrl} with client_id from ${config.secretName}`,
    };
  }

  if (step === "callback") {
    const { code } = event.queryStringParameters ?? {};
    if (!code) {
      return { statusCode: 400, body: "Missing authorization code" };
    }

    // Retrieves the {clientId, clientSecret} pair at runtime — never baked
    // into code, env vars, or CDK templates.
    await secretsManager.send(
      new GetSecretValueCommand({ SecretId: config.secretName })
    );

    return {
      statusCode: 501,
      body: "TODO: exchange code, fetch user profile, upsert account, issue session JWT",
    };
  }

  return { statusCode: 404, body: "Unknown route" };
};
