import { ServerMessage } from "@scenette/protocol";
import { ResilientConnection } from "@scenette/ws-client";
import { Renderer } from "./render";

const root = document.getElementById("viewport-root");
if (!root) throw new Error("Missing #viewport-root element");

async function main(): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  const roomId = params.get("roomId");
  if (!roomId) {
    root!.textContent = "scenette browser source: missing roomId query parameter";
    return;
  }

  // wsUrl/assetsDomain come from the deployed infra's /config.json (baked in
  // at deploy time, since neither exists until this stack's own WebSocket
  // API / assets CloudFront distribution do) unless explicitly overridden
  // via query params for local testing.
  const config = await fetchConfig();
  const wsUrl = params.get("wsUrl") ?? config?.wsUrl;
  const assetsDomain = params.get("assetsDomain") ?? config?.assetsDomain;
  if (!wsUrl || !assetsDomain) {
    root!.textContent = "scenette browser source: missing wsUrl/assetsDomain (no query param and /config.json unavailable)";
    return;
  }

  const renderer = new Renderer(root!, assetsDomain);

  const connection = new ResilientConnection({
    wsUrl,
    roomId,
    onOpen: () => {
      // Covers both the first connect and every later reconnect — a fresh
      // connection has no server-side memory of this client, so always
      // re-request the current state rather than assume anything survived.
      connection.send({ action: "room:snapshot:request", roomId });
    },
    onMessage: (message: ServerMessage) => {
      switch (message.type) {
        case "room:snapshot":
          renderer.setViewport({ roomId, ...message.viewport });
          renderer.setAssets(message.assets);
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
        case "asset:deleted":
          renderer.remove(message.assetId);
          break;
        case "error":
          console.error("scenette server error:", message.message);
          break;
      }
    },
  });

  connection.start();
}

async function fetchConfig(): Promise<{ wsUrl?: string; assetsDomain?: string } | undefined> {
  try {
    const res = await fetch("/config.json");
    if (!res.ok) return undefined;
    return await res.json();
  } catch {
    return undefined;
  }
}

main();
