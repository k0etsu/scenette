import { ServerMessage } from "@scenette/protocol";
import { ResilientConnection } from "@scenette/ws-client";
import { Renderer } from "./render";

const root = document.getElementById("viewport-root");
if (!root) throw new Error("Missing #viewport-root element");

// Self-heals any delta message that lost its seq race and got silently
// dropped server-side (see roomState.ts's per-asset conditional write) -- a
// periodic full-state re-fetch guarantees convergence within one interval
// regardless of whether any specific asset:move/resize/update ever arrives.
// Browser-source has no local optimistic state of its own (see Renderer),
// so reusing the exact room:snapshot path here is safe with no additional
// guarding, and cheap enough at this app's scale (one Lambda invocation +
// one small DynamoDB query per tick, no room broadcast) to run this often.
const SNAPSHOT_POLL_INTERVAL_MS = 1000;

async function main(): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  // The shareable OBS URL carries an opaque, owner-only `obs` key -- never the
  // roomId itself -- so a mod (who knows the roomId) can't reconstruct it. We
  // exchange it for the roomId we actually need to connect.
  const obsKey = params.get("obs");
  if (!obsKey) {
    root!.textContent = "scenette browser source: missing obs query parameter";
    return;
  }

  // wsUrl/httpApiUrl/assetsDomain come from the deployed infra's /config.json
  // (baked in at deploy time, since none exist until this stack's own APIs /
  // assets CloudFront distribution do) unless explicitly overridden via query
  // params for local testing.
  const config = await fetchConfig();
  const wsUrl = params.get("wsUrl") ?? config?.wsUrl;
  const httpApiUrl = params.get("httpApiUrl") ?? config?.httpApiUrl;
  const assetsDomain = params.get("assetsDomain") ?? config?.assetsDomain;
  if (!wsUrl || !httpApiUrl || !assetsDomain) {
    root!.textContent = "scenette browser source: missing wsUrl/httpApiUrl/assetsDomain (no query param and /config.json unavailable)";
    return;
  }

  const roomId = await resolveObsKey(httpApiUrl, obsKey);
  if (!roomId) {
    root!.textContent = "scenette browser source: this browser source URL is invalid or has been revoked";
    return;
  }

  const renderer = new Renderer(root!, assetsDomain);
  let pollTimer: ReturnType<typeof setInterval> | undefined;

  const connection = new ResilientConnection({
    wsUrl,
    roomId,
    onOpen: () => {
      // Covers both the first connect and every later reconnect — a fresh
      // connection has no server-side memory of this client, so always
      // re-request the current state rather than assume anything survived.
      connection.send({ action: "room:snapshot:request", roomId });

      // (Re-)armed here rather than started once outside onOpen -- onOpen
      // already fires on every reconnect (proactive swap or drop/retry), so
      // arming from inside it guarantees no two overlapping intervals can
      // ever run across a reconnect, and the first poll after a fresh
      // connection always waits a full interval rather than piling up right
      // behind the immediate request just above.
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = setInterval(() => {
        connection.send({ action: "room:snapshot:request", roomId });
      }, SNAPSHOT_POLL_INTERVAL_MS);
    },
    onMessage: (message: ServerMessage) => {
      switch (message.type) {
        case "room:snapshot":
          renderer.setViewport({ roomId, ...message.viewport });
          renderer.setAssets(message.assets);
          renderer.setGlobalVolume(message.globalVolume, message.globalVolumeSeq);
          renderer.setVariables(Object.fromEntries(message.variables.map((v) => [v.key, v])));
          break;
        case "asset:added":
          renderer.upsert(message.asset);
          break;
        case "asset:moved": {
          // The server only sends the delta, not the full asset — merge it into
          // what's already rendered rather than requiring a full asset payload
          // on every move (these fire continuously during a drag).
          //
          // browser-source has no local prediction of its own (unlike
          // control-ui, which renders its own drag instantly) -- it's
          // entirely at the mercy of message delivery order. WebSocket
          // messages for rapid successive edits aren't guaranteed to
          // arrive/process in order, so without this seq check a
          // late-arriving stale update would visibly render as the asset
          // jumping backward to an old position before "catching up" again.
          const existing = renderer.get(message.assetId);
          if (existing && message.seq >= existing.seq) {
            renderer.upsert({
              ...existing,
              x: message.x,
              y: message.y,
              rotation: message.rotation,
              visible: message.visible,
              seq: message.seq,
            });
          }
          break;
        }
        case "asset:resized": {
          const existing = renderer.get(message.assetId);
          if (existing && message.seq >= existing.seq) {
            renderer.upsert({
              ...existing,
              x: message.x,
              y: message.y,
              width: message.width,
              height: message.height,
              visible: message.visible,
              seq: message.seq,
            });
          }
          break;
        }
        case "asset:updated": {
          const existing = renderer.get(message.assetId);
          if (existing && message.seq >= existing.seq) {
            renderer.upsert({ ...existing, ...message.patch, visible: message.visible, seq: message.seq });
          }
          break;
        }
        case "asset:deleted":
          renderer.remove(message.assetId);
          break;
        case "asset:stopped":
          renderer.stop(message.assetId);
          break;
        case "asset:seeked":
          renderer.seek(message.assetId, message.positionSeconds);
          break;
        case "room:globalVolumeChanged":
          renderer.setGlobalVolume(message.globalVolume, message.seq);
          break;
        case "variable:updated":
          renderer.upsertVariable(message.variable);
          break;
        case "variable:deleted":
          renderer.removeVariable(message.key);
          break;
        case "error":
          console.error("scenette server error:", message.message);
          break;
      }
    },
  });

  connection.start();
}

async function fetchConfig(): Promise<{ wsUrl?: string; httpApiUrl?: string; assetsDomain?: string } | undefined> {
  try {
    const res = await fetch("/config.json");
    if (!res.ok) return undefined;
    return await res.json();
  } catch {
    return undefined;
  }
}

// Exchanges the opaque obs key for the roomId to connect with. Returns
// undefined for an unknown/revoked key.
async function resolveObsKey(httpApiUrl: string, obsKey: string): Promise<string | undefined> {
  try {
    const res = await fetch(`${httpApiUrl}/rooms/resolve?obs=${encodeURIComponent(obsKey)}`);
    if (!res.ok) return undefined;
    const data = (await res.json()) as { roomId?: string };
    return data.roomId;
  } catch {
    return undefined;
  }
}

main();
