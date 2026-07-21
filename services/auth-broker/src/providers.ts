export type ProviderName = "twitch" | "youtube" | "discord";

export interface ProviderConfig {
  name: ProviderName;
  authorizeUrl: string;
  tokenUrl: string;
  userInfoUrl: string;
  scope: string;
  // Secrets Manager secret name holding { clientId, clientSecret } for this
  // provider/environment. Never a literal value — CDK only ever wires the
  // Lambda's IAM permissions to read this ARN, never the secret contents.
  secretName: string;
}

// All three providers are treated uniformly by the broker (see plan: unified
// OAuth broker instead of Cognito, since Discord has no native OIDC support).
export function providerConfig(name: ProviderName, envName: string): ProviderConfig {
  switch (name) {
    case "twitch":
      return {
        name,
        authorizeUrl: "https://id.twitch.tv/oauth2/authorize",
        tokenUrl: "https://id.twitch.tv/oauth2/token",
        userInfoUrl: "https://api.twitch.tv/helix/users",
        scope: "user:read:email",
        secretName: `scenette/${envName}/oauth/twitch`,
      };
    case "youtube":
      return {
        name,
        authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
        tokenUrl: "https://oauth2.googleapis.com/token",
        userInfoUrl: "https://www.googleapis.com/oauth2/v3/userinfo",
        scope: "openid email profile",
        secretName: `scenette/${envName}/oauth/youtube`,
      };
    case "discord":
      return {
        name,
        authorizeUrl: "https://discord.com/api/oauth2/authorize",
        tokenUrl: "https://discord.com/api/oauth2/token",
        userInfoUrl: "https://discord.com/api/users/@me",
        scope: "identify email",
        secretName: `scenette/${envName}/oauth/discord`,
      };
  }
}
