export interface RuntimeConfig {
  wsUrl: string;
  httpApiUrl: string;
}

// The deployed infra writes /config.json alongside the static build output
// (see infra: BucketDeployment's jsonData source) with this env's actual
// WebSocket/HTTP API endpoints — baked in at deploy time, not build time,
// since those endpoints don't exist until the stack itself is deployed.
// Query params remain a manual override for local testing without a server.
export async function loadConfig(): Promise<RuntimeConfig> {
  const params = new URLSearchParams(window.location.search);
  const overrideWs = params.get("wsUrl");
  const overrideHttp = params.get("httpApiUrl");
  if (overrideWs && overrideHttp) {
    return { wsUrl: overrideWs, httpApiUrl: overrideHttp };
  }

  const res = await fetch("/config.json");
  if (!res.ok) throw new Error(`Failed to load /config.json: ${res.status}`);
  const config = (await res.json()) as Partial<RuntimeConfig>;

  const wsUrl = overrideWs ?? config.wsUrl;
  const httpApiUrl = overrideHttp ?? config.httpApiUrl;
  if (!wsUrl || !httpApiUrl) {
    throw new Error("Missing wsUrl/httpApiUrl in /config.json and no query param override given");
  }
  return { wsUrl, httpApiUrl };
}
