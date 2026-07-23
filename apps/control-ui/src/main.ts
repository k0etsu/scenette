import { ServerMessage } from "@scenette/protocol";
import { ResilientConnection } from "@scenette/ws-client";
import { CanvasView } from "./canvas";
import { uploadFile } from "./upload";

const params = new URLSearchParams(window.location.search);
const roomId = params.get("roomId");
const wsUrl = params.get("wsUrl");
const httpApiUrl = params.get("httpApiUrl");

const canvasContainer = document.getElementById("canvas-container");
const uploadInput = document.getElementById("upload-input") as HTMLInputElement | null;
const addTextButton = document.getElementById("add-text-button");
const statusEl = document.getElementById("status");

if (!canvasContainer || !uploadInput || !addTextButton || !statusEl) {
  throw new Error("Missing required DOM elements");
}

if (!roomId || !wsUrl || !httpApiUrl) {
  statusEl.textContent = "Missing roomId, wsUrl, or httpApiUrl query parameter";
} else {
  statusEl.textContent = `room: ${roomId}`;

  const canvas = new CanvasView(canvasContainer, {
    onAssetMove: (assetId, x, y) => {
      connection.send({ action: "asset:move", roomId, assetId, x, y });
    },
    onAssetDelete: (assetId) => {
      connection.send({ action: "asset:delete", roomId, assetId });
    },
  });

  const connection = new ResilientConnection({
    wsUrl,
    roomId,
    onOpen: () => {
      connection.send({ action: "room:snapshot:request", roomId });
    },
    onMessage: (message: ServerMessage) => {
      switch (message.type) {
        case "room:snapshot":
          canvas.setViewport({ roomId, ...message.viewport });
          canvas.setAssets(message.assets);
          break;
        case "asset:added":
          canvas.upsert(message.asset);
          break;
        case "asset:moved": {
          // The sender already applied its own move optimistically (see
          // onAssetMove), but other collaborators' moves arrive only as
          // this broadcast — merge the delta into whatever's rendered.
          // Re-applying it on the sender's own client too is harmless
          // (idempotent), so there's no need to special-case "was this us".
          const existing = canvas.get(message.assetId);
          if (existing) {
            canvas.upsert({
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
          canvas.remove(message.assetId);
          break;
        case "error":
          console.error("scenette server error:", message.message);
          break;
      }
    },
  });

  connection.start();

  addTextButton.addEventListener("click", () => {
    const text = window.prompt("Text content:");
    if (!text) return;

    const viewport = canvas.getViewport();
    const width = 200;
    const height = 50;
    connection.send({
      action: "asset:add",
      roomId,
      asset: {
        assetId: crypto.randomUUID(),
        type: "text",
        x: viewport.x + viewport.width / 2 - width / 2,
        y: viewport.y + viewport.height / 2 - height / 2,
        width,
        height,
        text,
      },
    });
  });

  uploadInput.addEventListener("change", () => {
    const file = uploadInput.files?.[0];
    if (file) handleUpload(file);
    uploadInput.value = "";
  });

  window.addEventListener("paste", (event) => {
    const file = Array.from(event.clipboardData?.items ?? [])
      .find((item) => item.kind === "file")
      ?.getAsFile();
    if (file) handleUpload(file);
  });

  async function handleUpload(file: File): Promise<void> {
    if (!roomId || !httpApiUrl) return;
    statusEl!.textContent = `uploading ${file.name}...`;
    try {
      const result = await uploadFile(httpApiUrl, roomId, file);
      const viewport = canvas.getViewport();
      connection.send({
        action: "asset:add",
        roomId,
        asset: {
          assetId: result.assetId,
          type: result.type,
          x: viewport.x + viewport.width / 2 - result.width / 2,
          y: viewport.y + viewport.height / 2 - result.height / 2,
          width: result.width,
          height: result.height,
          s3Key: result.s3Key,
        },
      });
      statusEl!.textContent = `room: ${roomId}`;
    } catch (err) {
      statusEl!.textContent = `upload failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}
