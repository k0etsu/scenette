export interface RuntimeConfig {
  wsUrl: string;
  httpApiUrl: string;
  assetsDomain: string;
}

// The deployed infra writes /config.json alongside the static build output
// (see infra: BucketDeployment's jsonData source) with this env's actual
// WebSocket/HTTP API endpoints — baked in at deploy time, not build time,
// since those endpoints don't exist until the stack itself is deployed.
// Query params remain a manual override for local testing without a server.
export async function loadConfig(): Promise<RuntimeConfig> {
  const params = new URLSearchParams(window.location.search);

  // /config.json is still fetched even when all three are overridden via
  // query params, purely so a fetch failure surfaces immediately rather than
  // silently working today and breaking the moment an override is dropped.
  const res = await fetch("/config.json");
  if (!res.ok) throw new Error(`Failed to load /config.json: ${res.status}`);
  const config = (await res.json()) as Partial<RuntimeConfig>;

  const wsUrl = params.get("wsUrl") ?? config.wsUrl;
  const httpApiUrl = params.get("httpApiUrl") ?? config.httpApiUrl;
  const assetsDomain = params.get("assetsDomain") ?? config.assetsDomain;
  if (!wsUrl || !httpApiUrl || !assetsDomain) {
    throw new Error("Missing wsUrl/httpApiUrl/assetsDomain in /config.json and no query param override given");
  }
  return { wsUrl, httpApiUrl, assetsDomain };
}
