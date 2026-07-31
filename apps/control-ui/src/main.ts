import { AssetAddMessage, ServerMessage } from "@scenette/protocol";
import { ResilientConnection } from "@scenette/ws-client";
import { CanvasView } from "./canvas";
import { Sidebar } from "./sidebar";
import { SoundPanel } from "./sound";
import { ConnectedUsersPanel } from "./connectedUsers";
import { VariablesPanel } from "./variablesPanel";
import { uploadFile } from "./upload";
import { loadConfig } from "./config";
import { AccessModal } from "./accessModal";
import { RoomPicker } from "./roomPicker";
import {
  register,
  login,
  checkSession,
  logout,
  redeemInvite,
  getStoredToken,
  resendVerification,
  listRooms,
  UnverifiedEmailError,
  SessionInfo,
} from "./auth";

const loginView = document.getElementById("login-view");
const appView = document.getElementById("app-view");
const loginForm = document.getElementById("login-form") as HTMLFormElement | null;
const usernameInput = document.getElementById("login-username") as HTMLInputElement | null;
const emailInput = document.getElementById("login-email") as HTMLInputElement | null;
const passwordInput = document.getElementById("login-password") as HTMLInputElement | null;
const registerButton = document.getElementById("register-button");
const loginError = document.getElementById("login-error");
const loginMessage = document.getElementById("login-message");
const resendVerificationButton = document.getElementById("resend-verification-button");
const roomPickerViewEl = document.getElementById("room-picker-view");

const canvasContainer = document.getElementById("canvas-container");
const objectsPanel = document.getElementById("objects-panel");
const propertiesPanel = document.getElementById("properties-panel");
const soundPanelEl = document.getElementById("sound-panel");
const connectedUsersPanelEl = document.getElementById("connected-users-panel");
const variablesPanelEl = document.getElementById("variables-panel");
const uploadInput = document.getElementById("upload-input") as HTMLInputElement | null;
const addTextButton = document.getElementById("add-text-button");
const manageAccessButton = document.getElementById("manage-access-button");
const accessModalEl = document.getElementById("access-modal");
const copyBrowserSourceButton = document.getElementById("copy-browser-source-button");
const logoutButton = document.getElementById("logout-button");
const statusEl = document.getElementById("status");

const contextMenu = document.getElementById("context-menu");
const contextMenuTextButton = document.getElementById("context-menu-text");
const contextMenuMediaButton = document.getElementById("context-menu-media");

if (
  !loginView || !appView || !loginForm || !usernameInput || !emailInput || !passwordInput || !registerButton ||
  !loginError || !loginMessage || !resendVerificationButton || !roomPickerViewEl ||
  !canvasContainer || !objectsPanel || !propertiesPanel || !soundPanelEl || !connectedUsersPanelEl ||
  !variablesPanelEl || !uploadInput || !addTextButton || !manageAccessButton || !accessModalEl ||
  !copyBrowserSourceButton || !logoutButton || !statusEl || !contextMenu || !contextMenuTextButton ||
  !contextMenuMediaButton
) {
  throw new Error("Missing required DOM elements");
}

async function main(): Promise<void> {
  const { wsUrl, httpApiUrl, assetsDomain, browserSourceUrl } = await loadConfig();

  let session = await checkSession(httpApiUrl);
  if (!session) {
    session = await promptLogin(httpApiUrl);
  }

  // A visit via a shared invite link (?invite=TOKEN) -- redeem it now that
  // we're definitely logged in (creating an account, if this was a new
  // user, already happened via the normal register+verify+login flow
  // above) and land in that room instead of the account's own personal
  // room. Rewrites the URL to the resolved roomId either way, so
  // startApp()'s own `params.get("roomId")` read below picks it up without
  // needing its own invite-awareness.
  const params = new URLSearchParams(window.location.search);
  const inviteToken = params.get("invite");
  if (inviteToken) {
    try {
      const { roomId } = await redeemInvite(httpApiUrl, inviteToken);
      params.set("roomId", roomId);
    } catch (err) {
      statusEl!.textContent = `Invite redemption failed: ${err instanceof Error ? err.message : String(err)}`;
    }
    params.delete("invite");
    window.history.replaceState(null, "", `${window.location.pathname}${params.toString() ? "?" + params.toString() : ""}`);
  }

  loginView!.style.display = "none";

  // No explicit room requested (a bare visit, not a bookmarked/shared link
  // and not an invite redemption just above) -- previously this always
  // defaulted straight into the account's own room, which left no way to
  // reach a room this account only has mod access to except via a link.
  // Only bother asking when there's actually a choice to make.
  if (!params.get("roomId")) {
    const rooms = await listRooms(httpApiUrl);
    if (rooms.length > 1) {
      const roomPicker = new RoomPicker(roomPickerViewEl!);
      const roomId = await roomPicker.pickRoom(rooms, session.personalRoomId);
      params.set("roomId", roomId);
      window.history.replaceState(null, "", `${window.location.pathname}?${params.toString()}`);
    }
  }

  appView!.style.display = "flex";
  startApp(wsUrl, httpApiUrl, assetsDomain, browserSourceUrl, session);
}

function promptLogin(httpApiUrl: string): Promise<SessionInfo> {
  return new Promise((resolve) => {
    loginForm!.addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        loginError!.textContent = "";
        loginMessage!.textContent = "";
        resendVerificationButton!.style.display = "none";
        const session = await login(httpApiUrl, usernameInput!.value, passwordInput!.value);
        resolve(session);
      } catch (err) {
        if (err instanceof UnverifiedEmailError) {
          loginError!.textContent = "Check your email and click the verification link before logging in.";
          resendVerificationButton!.style.display = "block";
        } else {
          loginError!.textContent = err instanceof Error ? err.message : String(err);
        }
      }
    });

    registerButton!.addEventListener("click", async () => {
      try {
        loginError!.textContent = "";
        loginMessage!.textContent = "";
        resendVerificationButton!.style.display = "none";
        const result = await register(httpApiUrl, usernameInput!.value, emailInput!.value, passwordInput!.value);
        // Deliberately does NOT resolve() -- registering no longer logs you
        // in. The account exists but login stays blocked until the
        // verification email's link is clicked.
        loginMessage!.textContent = result.message;
        passwordInput!.value = "";
      } catch (err) {
        loginError!.textContent = err instanceof Error ? err.message : String(err);
      }
    });

    resendVerificationButton!.addEventListener("click", async () => {
      try {
        loginError!.textContent = "";
        await resendVerification(httpApiUrl, usernameInput!.value);
        loginMessage!.textContent = "Verification email sent. Check your inbox.";
      } catch (err) {
        loginError!.textContent = err instanceof Error ? err.message : String(err);
      }
    });
  });
}

function startApp(
  wsUrl: string,
  httpApiUrl: string,
  assetsDomain: string,
  browserSourceUrl: string,
  session: SessionInfo
): void {
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

  // Where the next text/media asset created via the toolbar (viewport
  // center) vs. the right-click context menu / sidebar "+" button should land.
  let createPosition: { x: number; y: number } | undefined;

  const canvas = new CanvasView(
    canvasContainer!,
    {
      onAssetMove: (assetId, x, y, seq) => {
        connection.send({ action: "asset:move", roomId, assetId, x, y, seq });
      },
      onAssetResize: (assetId, x, y, width, height, seq) => {
        connection.send({ action: "asset:resize", roomId, assetId, x, y, width, height, seq });
      },
      onAssetPatch: (assetId, patch, seq) => {
        connection.send({ action: "asset:update", roomId, assetId, patch, seq });
      },
      onAssetDelete: (assetId) => {
        connection.send({ action: "asset:delete", roomId, assetId });
      },
      onContextMenu: (worldX, worldY, screenX, screenY) => {
        createPosition = { x: worldX, y: worldY };
        showContextMenu(screenX, screenY);
      },
      onSelectionChange: (assetId) => {
        sidebar.setSelected(assetId);
      },
    },
    assetsDomain
  );

  // canvas.patchAsset/setAssetPosition/setAssetSize all apply their change
  // to canvas's own local state immediately (optimistic, same as a mouse
  // drag) -- but the sidebar has its own separate copy of asset data for
  // rendering the objects list/properties panel, which otherwise wouldn't
  // reflect that change until the server's broadcast round-trips back.
  // Without this, a fast second click (e.g. double-toggling hidden) reads
  // stale sidebar data and can send the same value twice instead of
  // actually toggling.
  const sidebar = new Sidebar(objectsPanel!, propertiesPanel!, {
    onSelect: (assetId) => canvas.selectAsset(assetId),
    onToggleHidden: (assetId, hidden) => {
      canvas.patchAsset(assetId, { hidden });
      syncSidebarFromCanvas(assetId);
    },
    onToggleLocked: (assetId, locked) => {
      canvas.patchAsset(assetId, { locked });
      syncSidebarFromCanvas(assetId);
    },
    onDelete: (assetId) => connection.send({ action: "asset:delete", roomId, assetId }),
    onDuplicate: (assetId) => duplicateAsset(assetId),
    onPatch: (assetId, patch) => {
      canvas.patchAsset(assetId, patch);
      syncSidebarFromCanvas(assetId);
    },
    onMove: (assetId, x, y) => {
      canvas.setAssetPosition(assetId, x, y);
      syncSidebarFromCanvas(assetId);
    },
    onResize: (assetId, width, height) => {
      canvas.setAssetSize(assetId, width, height);
      syncSidebarFromCanvas(assetId);
    },
    onCreateClick: () => {
      const rect = objectsPanel!.getBoundingClientRect();
      createPosition = undefined; // sidebar-triggered creates default to viewport center
      showContextMenu(rect.right + 4, rect.top);
    },
  });

  function showContextMenu(screenX: number, screenY: number): void {
    contextMenu!.style.left = `${screenX}px`;
    contextMenu!.style.top = `${screenY}px`;
    contextMenu!.style.display = "block";
  }

  document.addEventListener("mousedown", (event) => {
    if (contextMenu!.style.display !== "none" && !contextMenu!.contains(event.target as Node)) {
      contextMenu!.style.display = "none";
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") contextMenu!.style.display = "none";
  });

  const soundPanel = new SoundPanel(soundPanelEl!, {
    onGlobalVolumeChange: (globalVolume, seq) => {
      connection.send({ action: "room:setGlobalVolume", roomId, globalVolume, seq });
    },
    onMultipliersChanged: (globalVolume, localVolume) => {
      canvas.setVolumeMultipliers(globalVolume, localVolume);
    },
  });

  const connectedUsersPanel = new ConnectedUsersPanel(connectedUsersPanelEl!, {
    onRefresh: () => connection.send({ action: "room:snapshot:request", roomId }),
  });

  const variablesPanel = new VariablesPanel(variablesPanelEl!, {
    onSet: (key, type, value) => connection.send({ action: "variable:set", roomId, key, type, value }),
    onDelete: (key) => connection.send({ action: "variable:delete", roomId, key }),
  });

  const connection = new ResilientConnection({
    wsUrl,
    roomId,
    token: getStoredToken() ?? undefined,
    onOpen: () => {
      connection.send({ action: "room:snapshot:request", roomId });
    },
    onMessage: (message: ServerMessage) => {
      switch (message.type) {
        case "room:snapshot":
          canvas.setViewport({ roomId, ...message.viewport });
          canvas.setAssets(message.assets);
          sidebar.setAssets(message.assets);
          soundPanel.setGlobalVolume(message.globalVolume, message.globalVolumeSeq);
          canvas.setVariables(Object.fromEntries(message.variables.map((v) => [v.key, v])));
          variablesPanel.setVariables(message.variables);
          connectedUsersPanel.setPresence(message.presence);
          break;
        case "asset:added":
          canvas.upsert(message.asset);
          sidebar.upsertAsset(message.asset);
          break;
        case "asset:moved":
          canvas.applyRemoteMove(message.assetId, message.x, message.y, message.rotation, message.visible, message.seq);
          syncSidebarFromCanvas(message.assetId);
          break;
        case "asset:resized":
          canvas.applyRemoteResize(
            message.assetId,
            message.x,
            message.y,
            message.width,
            message.height,
            message.visible,
            message.seq
          );
          syncSidebarFromCanvas(message.assetId);
          break;
        case "asset:updated":
          canvas.applyRemoteUpdate(message.assetId, message.patch, message.visible, message.seq);
          syncSidebarFromCanvas(message.assetId);
          break;
        case "asset:deleted":
          canvas.remove(message.assetId);
          sidebar.removeAsset(message.assetId);
          break;
        case "room:globalVolumeChanged":
          soundPanel.setGlobalVolume(message.globalVolume, message.seq);
          break;
        case "variable:updated":
          variablesPanel.upsertVariable(message.variable);
          canvas.upsertVariable(message.variable);
          break;
        case "variable:deleted":
          variablesPanel.removeVariable(message.key);
          canvas.removeVariable(message.key);
          break;
        case "presence:joined":
          connectedUsersPanel.addPresence(message.entry);
          break;
        case "presence:left":
          connectedUsersPanel.removePresence(message.username, message.connectedAt);
          break;
        case "error":
          console.error("scenette server error:", message.message);
          break;
      }
    },
  });

  // asset:moved/resized/updated broadcasts only carry the changed fields,
  // not the full asset -- read back whatever canvas ended up applying
  // (already merged) rather than duplicating that merge logic here.
  function syncSidebarFromCanvas(assetId: string): void {
    const asset = canvas.get(assetId);
    if (asset) sidebar.upsertAsset(asset);
  }

  connection.start();

  function createTextAsset(): void {
    const text = window.prompt("Text content:");
    if (!text) return;

    const width = 200;
    const height = 50;
    const viewport = canvas.getViewport();
    const pos = createPosition ?? {
      x: viewport.x + viewport.width / 2 - width / 2,
      y: viewport.y + viewport.height / 2 - height / 2,
    };
    createPosition = undefined;

    connection.send({
      action: "asset:add",
      roomId,
      asset: {
        assetId: crypto.randomUUID(),
        type: "text",
        x: pos.x,
        y: pos.y,
        width,
        height,
        text,
      },
    });
  }

  addTextButton!.addEventListener("click", createTextAsset);
  contextMenuTextButton!.addEventListener("click", () => {
    contextMenu!.style.display = "none";
    createTextAsset();
  });

  function triggerMediaUpload(): void {
    uploadInput!.click();
  }

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

  contextMenuMediaButton!.addEventListener("click", () => {
    contextMenu!.style.display = "none";
    triggerMediaUpload();
  });

  function duplicateAsset(assetId: string): void {
    const source = canvas.get(assetId);
    if (!source) return;
    const offset = 20;
    const asset: AssetAddMessage["asset"] = {
      assetId: crypto.randomUUID(),
      type: source.type,
      x: source.x + offset,
      y: source.y + offset,
      width: source.width,
      height: source.height,
      rotation: source.rotation,
      zIndex: source.zIndex,
      s3Key: source.s3Key,
      text: source.text,
      opacity: source.opacity,
      blur: source.blur,
      flipX: source.flipX,
      flipY: source.flipY,
      locked: false, // a duplicate of a locked asset shouldn't itself start locked and unmovable
      hidden: source.hidden,
      loop: source.loop,
      muted: source.muted,
      volume: source.volume,
      paused: source.paused,
    };
    connection.send({ action: "asset:add", roomId, asset });
    // Select the new copy, not the original -- matches standard duplicate
    // behavior (Figma, PowerPoint, etc.) so an immediate follow-up edit or
    // delete applies to the copy. Safe to select before the asset:added
    // broadcast round-trips: canvas/sidebar both tolerate selecting an ID
    // that doesn't have an entry yet and pick it up once upsert() runs.
    canvas.selectAsset(asset.assetId);
  }

  const accessModal = new AccessModal(accessModalEl!);
  manageAccessButton!.addEventListener("click", () => {
    accessModal.open(httpApiUrl, roomId).catch((err) => {
      statusEl!.textContent = `Failed to load room access: ${err instanceof Error ? err.message : String(err)}`;
    });
  });

  copyBrowserSourceButton!.addEventListener("click", async () => {
    const url = `${browserSourceUrl}/?roomId=${encodeURIComponent(roomId)}`;
    try {
      await navigator.clipboard.writeText(url);
      statusEl!.textContent = "browser source URL copied to clipboard";
    } catch (err) {
      // Clipboard API can be denied (e.g. insecure context, permissions) --
      // fall back to showing the URL directly so it's still usable.
      statusEl!.textContent = `copy failed, URL: ${url}`;
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
      const pos = createPosition ?? {
        x: viewport.x + viewport.width / 2 - result.width / 2,
        y: viewport.y + viewport.height / 2 - result.height / 2,
      };
      createPosition = undefined;

      connection.send({
        action: "asset:add",
        roomId,
        asset: {
          assetId: result.assetId,
          type: result.type,
          x: pos.x,
          y: pos.y,
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
