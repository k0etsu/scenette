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

  // wsUrl comes from the deployed infra's /config.json (baked in at deploy
  // time, since it doesn't exist until this stack's own WebSocket API does)
  // unless explicitly overridden via query param for local testing.
  const wsUrl = params.get("wsUrl") ?? (await fetchConfiguredWsUrl());
  if (!wsUrl) {
    root!.textContent = "scenette browser source: missing wsUrl (no query param and /config.json unavailable)";
    return;
  }

  const renderer = new Renderer(root!);

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
          const existing = renderer.get(message.assetId);
          if (existing) {
            renderer.upsert({
              ...existing,
              x: message.x,
              y: message.y,
              rotation: message.rotation,
              visible: message.visible,
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

async function fetchConfiguredWsUrl(): Promise<string | undefined> {
  try {
    const res = await fetch("/config.json");
    if (!res.ok) return undefined;
    const config = (await res.json()) as { wsUrl?: string };
    return config.wsUrl;
  } catch {
    return undefined;
  }
}

main();
