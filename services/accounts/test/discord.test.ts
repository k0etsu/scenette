import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";

const ssmMock = mockClient(SSMClient);

// Fresh module import per test -- discord.ts caches the client secret at
// module scope across warm Lambda invocations (see getClientSecret), which
// would otherwise leak between tests that need to observe an uncached fetch.
async function freshDiscordModule() {
  vi.resetModules();
  return import("../src/discord");
}

beforeEach(() => {
  ssmMock.reset();
  vi.unstubAllGlobals();
});

describe("buildAuthorizeUrl", () => {
  it("builds Discord's authorize URL with the identify scope and given state", async () => {
    const { buildAuthorizeUrl } = await freshDiscordModule();
    const url = new URL(buildAuthorizeUrl("state123"));
    expect(url.origin + url.pathname).toBe("https://discord.com/api/oauth2/authorize");
    expect(url.searchParams.get("client_id")).toBe("test-discord-client-id");
    expect(url.searchParams.get("redirect_uri")).toBe("https://api.test.example.com/auth/discord/callback");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe("identify");
    expect(url.searchParams.get("state")).toBe("state123");
  });
});

describe("exchangeCodeForUser", () => {
  it("exchanges the code for a token, then fetches and returns the Discord identity", async () => {
    ssmMock.on(GetParameterCommand).resolves({ Parameter: { Value: JSON.stringify({ clientId: "cid", clientSecret: "shh" }) } });
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "https://discord.com/api/oauth2/token") {
        return new Response(JSON.stringify({ access_token: "atok" }), { status: 200 });
      }
      if (url === "https://discord.com/api/users/@me") {
        return new Response(JSON.stringify({ id: "d1", username: "alice#disc" }), { status: 200 });
      }
      throw new Error(`Unexpected fetch to ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { exchangeCodeForUser } = await freshDiscordModule();
    const user = await exchangeCodeForUser("authcode");
    expect(user).toEqual({ id: "d1", username: "alice#disc" });

    const userFetchCall = fetchMock.mock.calls.find(([url]) => url === "https://discord.com/api/users/@me");
    expect(userFetchCall?.[1]).toMatchObject({ headers: { Authorization: "Bearer atok" } });

    // Requests decryption -- this is a SecureString parameter.
    const paramCall = ssmMock.commandCalls(GetParameterCommand)[0];
    expect(paramCall.args[0].input).toMatchObject({ WithDecryption: true });
  });

  it("throws when the token exchange fails", async () => {
    ssmMock.on(GetParameterCommand).resolves({ Parameter: { Value: JSON.stringify({ clientId: "cid", clientSecret: "shh" }) } });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("bad request", { status: 400 }))
    );

    const { exchangeCodeForUser } = await freshDiscordModule();
    await expect(exchangeCodeForUser("badcode")).rejects.toThrow(/Discord token exchange failed/);
  });

  it("throws when the Discord client parameter has no value", async () => {
    ssmMock.on(GetParameterCommand).resolves({});
    const { exchangeCodeForUser } = await freshDiscordModule();
    await expect(exchangeCodeForUser("authcode")).rejects.toThrow(/no value/);
  });

  it("throws when the parameter JSON has no clientSecret field", async () => {
    ssmMock.on(GetParameterCommand).resolves({ Parameter: { Value: JSON.stringify({ clientId: "cid" }) } });
    const { exchangeCodeForUser } = await freshDiscordModule();
    await expect(exchangeCodeForUser("authcode")).rejects.toThrow(/no clientSecret field/);
  });
});
