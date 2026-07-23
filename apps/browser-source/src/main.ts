import { ServerMessage } from "@scenette/protocol";
import { ResilientConnection } from "@scenette/ws-client";
import { Renderer } from "./render";

// OBS browser sources are configured with a fully-qualified URL including
// query params — no build-time config needed, everything comes from the URL
// the streamer pastes into their browser source settings.
const params = new URLSearchParams(window.location.search);
const roomId = params.get("roomId");
const wsUrl = params.get("wsUrl");

const root = document.getElementById("viewport-root");
if (!root) throw new Error("Missing #viewport-root element");

if (!roomId || !wsUrl) {
  root.textContent = "scenette browser source: missing roomId or wsUrl query parameter";
} else {
  const renderer = new Renderer(root);

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
