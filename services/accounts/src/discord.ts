import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";

const ssm = new SSMClient({});

const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID!;
const DISCORD_REDIRECT_URI = process.env.DISCORD_REDIRECT_URI!;
const DISCORD_CLIENT_PARAM_NAME = process.env.DISCORD_CLIENT_PARAM_NAME!;

export interface DiscordUser {
  id: string;
  username: string;
}

// Cached across warm invocations -- the secret doesn't change mid-Lambda-
// lifetime, and it saves an SSM round trip on every sign-in. Stored as a
// key/value JSON SecureString parameter (clientId + clientSecret) rather
// than a plain string -- only clientSecret is read here, since clientId
// isn't actually sensitive and is already supplied separately via
// DISCORD_CLIENT_ID (a plain, synchronously-available env var that
// buildAuthorizeUrl needs without an async parameter fetch).
let cachedClientSecret: string | undefined;
async function getClientSecret(): Promise<string> {
  if (cachedClientSecret) return cachedClientSecret;
  const { Parameter } = await ssm.send(
    new GetParameterCommand({ Name: DISCORD_CLIENT_PARAM_NAME, WithDecryption: true })
  );
  if (!Parameter?.Value) throw new Error("Discord client parameter has no value");
  const { clientSecret } = JSON.parse(Parameter.Value) as { clientSecret?: string };
  if (!clientSecret) throw new Error("Discord client parameter JSON has no clientSecret field");
  cachedClientSecret = clientSecret;
  return cachedClientSecret;
}

export function buildAuthorizeUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    redirect_uri: DISCORD_REDIRECT_URI,
    response_type: "code",
    scope: "identify",
    state,
  });
  return `https://discord.com/api/oauth2/authorize?${params}`;
}

// Exchanges the authorization code for an access token, then fetches the
// caller's Discord identity with it. `identify` scope only -- no email, no
// guild membership -- since having a Discord account at all is the trust
// signal this path relies on, not any particular server.
export async function exchangeCodeForUser(code: string): Promise<DiscordUser> {
  const clientSecret = await getClientSecret();
  const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: DISCORD_CLIENT_ID,
      client_secret: clientSecret,
      grant_type: "authorization_code",
      code,
      redirect_uri: DISCORD_REDIRECT_URI,
    }),
  });
  if (!tokenRes.ok) {
    throw new Error(`Discord token exchange failed: ${tokenRes.status} ${await tokenRes.text()}`);
  }
  const { access_token: accessToken } = (await tokenRes.json()) as { access_token: string };

  const userRes = await fetch("https://discord.com/api/users/@me", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!userRes.ok) {
    throw new Error(`Discord user fetch failed: ${userRes.status} ${await userRes.text()}`);
  }
  const user = (await userRes.json()) as { id: string; username: string };
  return { id: user.id, username: user.username };
}
