import { ServerMessage } from "@scenette/protocol";
import { ResilientConnection } from "@scenette/ws-client";
import { CanvasView } from "./canvas";
import { uploadFile } from "./upload";
import { loadConfig } from "./config";
import { register, login, checkSession, logout, grantRoomAccess, SessionInfo } from "./auth";

const loginView = document.getElementById("login-view");
const appView = document.getElementById("app-view");
const loginForm = document.getElementById("login-form") as HTMLFormElement | null;
const usernameInput = document.getElementById("login-username") as HTMLInputElement | null;
const passwordInput = document.getElementById("login-password") as HTMLInputElement | null;
const registerButton = document.getElementById("register-button");
const loginError = document.getElementById("login-error");

const canvasContainer = document.getElementById("canvas-container");
const uploadInput = document.getElementById("upload-input") as HTMLInputElement | null;
const addTextButton = document.getElementById("add-text-button");
const grantAccessButton = document.getElementById("grant-access-button");
const logoutButton = document.getElementById("logout-button");
const statusEl = document.getElementById("status");

if (
  !loginView || !appView || !loginForm || !usernameInput || !passwordInput || !registerButton || !loginError ||
  !canvasContainer || !uploadInput || !addTextButton || !grantAccessButton || !logoutButton || !statusEl
) {
  throw new Error("Missing required DOM elements");
}

async function main(): Promise<void> {
  const { wsUrl, httpApiUrl, assetsDomain } = await loadConfig();

  let session = await checkSession(httpApiUrl);
  if (!session) {
    session = await promptLogin(httpApiUrl);
  }

  loginView!.style.display = "none";
  appView!.style.display = "block";
  startApp(wsUrl, httpApiUrl, assetsDomain, session);
}

function promptLogin(httpApiUrl: string): Promise<SessionInfo> {
  return new Promise((resolve) => {
    loginForm!.addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        loginError!.textContent = "";
        const session = await login(httpApiUrl, usernameInput!.value, passwordInput!.value);
        resolve(session);
      } catch (err) {
        loginError!.textContent = err instanceof Error ? err.message : String(err);
      }
    });

    registerButton!.addEventListener("click", async () => {
      try {
        loginError!.textContent = "";
        const session = await register(httpApiUrl, usernameInput!.value, passwordInput!.value);
        resolve(session);
      } catch (err) {
        loginError!.textContent = err instanceof Error ? err.message : String(err);
      }
    });
  });
}

function startApp(wsUrl: string, httpApiUrl: string, assetsDomain: string, session: SessionInfo): void {
  const params = new URLSearchParams(window.location.search);
  const roomId = params.get("roomId") ?? session.personalRoomId;

  if (!params.get("roomId")) {
    // Landed here with no explicit room (the common case: a bare visit to
    // the home page) — default to the account's own room and reflect that
    // in the URL so it's bookmarkable/shareable going forward.
    params.set("roomId", roomId);
    window.history.replaceState(null, "", `${window.location.pathname}?${params.toString()}`);
  }

  statusEl!.textContent = `room: ${roomId} (${session.username})`;

  const canvas = new CanvasView(
    canvasContainer!,
    {
      onAssetMove: (assetId, x, y) => {
        connection.send({ action: "asset:move", roomId, assetId, x, y });
      },
      onAssetDelete: (assetId) => {
        connection.send({ action: "asset:delete", roomId, assetId });
      },
    },
    assetsDomain
  );

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

  addTextButton!.addEventListener("click", () => {
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

  uploadInput!.addEventListener("change", () => {
    const file = uploadInput!.files?.[0];
    if (file) handleUpload(file);
    uploadInput!.value = "";
  });

  window.addEventListener("paste", (event) => {
    const file = Array.from(event.clipboardData?.items ?? [])
      .find((item) => item.kind === "file")
      ?.getAsFile();
    if (file) handleUpload(file);
  });

  grantAccessButton!.addEventListener("click", async () => {
    const grantee = window.prompt("Grant room access to username:");
    if (!grantee) return;
    try {
      await grantRoomAccess(httpApiUrl, roomId, grantee);
      statusEl!.textContent = `granted access to ${grantee}`;
    } catch (err) {
      statusEl!.textContent = `grant failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  });

  logoutButton!.addEventListener("click", async () => {
    await logout(httpApiUrl);
    window.location.href = window.location.pathname;
  });

  async function handleUpload(file: File): Promise<void> {
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
      statusEl!.textContent = `room: ${roomId} (${session.username})`;
    } catch (err) {
      statusEl!.textContent = `upload failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}

main().catch((err) => {
  document.body.textContent = `Failed to start: ${err instanceof Error ? err.message : String(err)}`;
});
