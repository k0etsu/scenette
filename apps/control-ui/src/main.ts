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
const dashboardButton = document.getElementById("dashboard-button");
const statusEl = document.getElementById("status");

const contextMenu = document.getElementById("context-menu");
const contextMenuTextButton = document.getElementById("context-menu-text");
const contextMenuMediaButton = document.getElementById("context-menu-media");

if (
  !loginView || !appView || !loginForm || !usernameInput || !emailInput || !passwordInput || !registerButton ||
  !loginError || !loginMessage || !resendVerificationButton || !roomPickerViewEl ||
  !canvasContainer || !objectsPanel || !propertiesPanel || !soundPanelEl || !connectedUsersPanelEl ||
  !variablesPanelEl || !uploadInput || !addTextButton || !manageAccessButton || !accessModalEl ||
  !copyBrowserSourceButton || !dashboardButton || !statusEl || !contextMenu ||
  !contextMenuTextButton || !contextMenuMediaButton
) {
  throw new Error("Missing required DOM elements");
}

// Everything that lives for exactly one room at a time -- torn down and
// rebuilt on every room switch (Dashboard button, picking a different room,
// browser back/forward). Kept in one mutable holder rather than scattered
// module-level `let`s so teardownCurrentRoom() has one thing to null out
// and the toolbar/context-menu handlers below (bound once, not per room)
// have one thing to read the *current* room's state from.
interface RoomSession {
  roomId: string;
  connection: ResilientConnection;
  canvas: CanvasView;
  sidebar: Sidebar;
  connectedUsersPanel: ConnectedUsersPanel;
  // Where the next text/media asset (toolbar button or context-menu "Text"/
  // "Media") should land -- world coords from a right-click, or undefined
  // to default to the viewport center.
  createPosition?: { x: number; y: number };
}

let current: RoomSession | undefined;

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
  // room.
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

  function setUrl(roomId: string | undefined, push: boolean): void {
    const next = new URLSearchParams();
    if (roomId) next.set("roomId", roomId);
    const url = `${window.location.pathname}${next.toString() ? "?" + next.toString() : ""}`;
    if (push) window.history.pushState(null, "", url);
    else window.history.replaceState(null, "", url);
  }

  function teardownCurrentRoom(): void {
    if (!current) return;
    current.connection.stop();
    current.canvas.dispose();
    current.sidebar.dispose();
    current.connectedUsersPanel.dispose();
    current = undefined;
  }

  function showRoomView(roomId: string): void {
    teardownCurrentRoom();
    roomPickerViewEl!.style.display = "none";
    appView!.style.display = "flex";
    current = enterRoom(wsUrl, httpApiUrl, assetsDomain, browserSourceUrl, session!, roomId);
  }

  // Always shows the picker, regardless of room count -- the "only show it
  // automatically when there's an actual choice" threshold only applies to
  // the very first render below, not to an explicit Dashboard visit.
  async function showDashboardView(): Promise<void> {
    teardownCurrentRoom();
    appView!.style.display = "none";
    const rooms = await listRooms(httpApiUrl);
    const roomPicker = new RoomPicker(roomPickerViewEl!, {
      onLogout: () => {
        void logout(httpApiUrl).then(() => {
          window.location.href = window.location.pathname;
        });
      },
    });
    const roomId = await roomPicker.pickRoom(rooms, session!.personalRoomId);
    // The user just made an explicit choice -- push so that a later "back"
    // returns to the dashboard rather than leaving the app entirely.
    setUrl(roomId, true);
    showRoomView(roomId);
  }

  function goToRoom(roomId: string, push: boolean): void {
    setUrl(roomId, push);
    showRoomView(roomId);
  }

  async function goToDashboard(push: boolean): Promise<void> {
    setUrl(undefined, push);
    await showDashboardView();
  }

  // Browser back/forward: the URL has already changed by the time this
  // fires, so this only ever reads it and re-renders -- it must never call
  // pushState/replaceState itself, or it'd fight the navigation that's
  // already in flight.
  window.addEventListener("popstate", () => {
    const roomId = new URLSearchParams(window.location.search).get("roomId");
    if (roomId) {
      showRoomView(roomId);
    } else {
      void showDashboardView();
    }
  });

  // ---- Toolbar / context-menu wiring, bound exactly once for the whole
  // page's lifetime -- these target static DOM elements that persist across
  // every room switch. Each reads/writes the *current* room via the mutable
  // `current` holder above rather than closing over one room's state.

  function createTextAsset(): void {
    if (!current) return;
    const text = window.prompt("Text content:");
    if (!text) return;

    const width = 200;
    const height = 50;
    const viewport = current.canvas.getViewport();
    const pos = current.createPosition ?? {
      x: viewport.x + viewport.width / 2 - width / 2,
      y: viewport.y + viewport.height / 2 - height / 2,
    };
    current.createPosition = undefined;

    current.connection.send({
      action: "asset:add",
      roomId: current.roomId,
      asset: { assetId: crypto.randomUUID(), type: "text", x: pos.x, y: pos.y, width, height, text },
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

  async function handleUpload(file: File): Promise<void> {
    if (!current) return;
    const { roomId, canvas, connection } = current;
    statusEl!.textContent = `uploading ${file.name}...`;
    try {
      const result = await uploadFile(httpApiUrl, roomId, file);
      const viewport = canvas.getViewport();
      const pos = current.createPosition ?? {
        x: viewport.x + viewport.width / 2 - result.width / 2,
        y: viewport.y + viewport.height / 2 - result.height / 2,
      };
      current.createPosition = undefined;

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
      statusEl!.textContent = `room: ${roomId} (${session!.username})`;
    } catch (err) {
      statusEl!.textContent = `upload failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  uploadInput!.addEventListener("change", () => {
    const file = uploadInput!.files?.[0];
    if (file) void handleUpload(file);
    uploadInput!.value = "";
  });

  window.addEventListener("paste", (event) => {
    const file = Array.from(event.clipboardData?.items ?? [])
      .find((item) => item.kind === "file")
      ?.getAsFile();
    if (file) void handleUpload(file);
  });

  contextMenuMediaButton!.addEventListener("click", () => {
    contextMenu!.style.display = "none";
    triggerMediaUpload();
  });

  const accessModal = new AccessModal(accessModalEl!);
  manageAccessButton!.addEventListener("click", () => {
    if (!current) return;
    accessModal.open(httpApiUrl, current.roomId).catch((err) => {
      statusEl!.textContent = `Failed to load room access: ${err instanceof Error ? err.message : String(err)}`;
    });
  });

  copyBrowserSourceButton!.addEventListener("click", async () => {
    if (!current) return;
    const url = `${browserSourceUrl}/?roomId=${encodeURIComponent(current.roomId)}`;
    try {
      await navigator.clipboard.writeText(url);
      statusEl!.textContent = "browser source URL copied to clipboard";
    } catch (err) {
      // Clipboard API can be denied (e.g. insecure context, permissions) --
      // fall back to showing the URL directly so it's still usable.
      statusEl!.textContent = `copy failed, URL: ${url}`;
    }
  });

  dashboardButton!.addEventListener("click", () => {
    void goToDashboard(true);
  });

  // ---- Initial render: no explicit room requested (a bare visit, not a
  // bookmarked/shared link and not an invite redemption just above)
  // defaults straight into the account's own room UNLESS it also has
  // access to other rooms, in which case there's an actual choice to make.
  const explicitRoomId = params.get("roomId");
  if (explicitRoomId) {
    goToRoom(explicitRoomId, false);
  } else {
    const rooms = await listRooms(httpApiUrl);
    if (rooms.length > 1) {
      await showDashboardView();
    } else {
      goToRoom(session.personalRoomId, false);
    }
  }
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

// Constructs everything scoped to a single room and wires it together.
// Callers (showRoomView above) are responsible for tearing down whatever
// room session preceded this one first.
function enterRoom(
  wsUrl: string,
  httpApiUrl: string,
  assetsDomain: string,
  browserSourceUrl: string,
  session: SessionInfo,
  roomId: string
): RoomSession {
  statusEl!.textContent = `room: ${roomId} (${session.username})`;

  const room: RoomSession = {
    roomId,
    // Assigned just below -- declared here so the callbacks that close
    // over `room` (canvas, sidebar) can reference the connection/canvas
    // that will exist by the time they're actually invoked.
    connection: undefined as unknown as ResilientConnection,
    canvas: undefined as unknown as CanvasView,
    sidebar: undefined as unknown as Sidebar,
    connectedUsersPanel: undefined as unknown as ConnectedUsersPanel,
  };

  const canvas = new CanvasView(
    canvasContainer!,
    {
      onAssetMove: (assetId, x, y, seq) => {
        room.connection.send({ action: "asset:move", roomId, assetId, x, y, seq });
      },
      onAssetResize: (assetId, x, y, width, height, seq) => {
        room.connection.send({ action: "asset:resize", roomId, assetId, x, y, width, height, seq });
      },
      onAssetPatch: (assetId, patch, seq) => {
        room.connection.send({ action: "asset:update", roomId, assetId, patch, seq });
      },
      onAssetDelete: (assetId) => {
        room.connection.send({ action: "asset:delete", roomId, assetId });
      },
      onContextMenu: (worldX, worldY, screenX, screenY) => {
        room.createPosition = { x: worldX, y: worldY };
        showContextMenu(screenX, screenY);
      },
      onSelectionChange: (assetId) => {
        room.sidebar.setSelected(assetId);
      },
    },
    assetsDomain
  );
  room.canvas = canvas;

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
    onDelete: (assetId) => room.connection.send({ action: "asset:delete", roomId, assetId }),
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
      room.createPosition = undefined; // sidebar-triggered creates default to viewport center
      showContextMenu(rect.right + 4, rect.top);
    },
  });
  room.sidebar = sidebar;

  const soundPanel = new SoundPanel(soundPanelEl!, {
    onGlobalVolumeChange: (globalVolume, seq) => {
      room.connection.send({ action: "room:setGlobalVolume", roomId, globalVolume, seq });
    },
    onMultipliersChanged: (globalVolume, localVolume) => {
      canvas.setVolumeMultipliers(globalVolume, localVolume);
    },
  });

  const connectedUsersPanel = new ConnectedUsersPanel(connectedUsersPanelEl!, {
    onRefresh: () => room.connection.send({ action: "room:snapshot:request", roomId }),
  });
  room.connectedUsersPanel = connectedUsersPanel;

  const variablesPanel = new VariablesPanel(variablesPanelEl!, {
    onSet: (key, type, value) => room.connection.send({ action: "variable:set", roomId, key, type, value }),
    onDelete: (key) => room.connection.send({ action: "variable:delete", roomId, key }),
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
  room.connection = connection;

  // asset:moved/resized/updated broadcasts only carry the changed fields,
  // not the full asset -- read back whatever canvas ended up applying
  // (already merged) rather than duplicating that merge logic here.
  function syncSidebarFromCanvas(assetId: string): void {
    const asset = canvas.get(assetId);
    if (asset) sidebar.upsertAsset(asset);
  }

  connection.start();

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
    room.connection.send({ action: "asset:add", roomId, asset });
    // Select the new copy, not the original -- matches standard duplicate
    // behavior (Figma, PowerPoint, etc.) so an immediate follow-up edit or
    // delete applies to the copy. Safe to select before the asset:added
    // broadcast round-trips: canvas/sidebar both tolerate selecting an ID
    // that doesn't have an entry yet and pick it up once upsert() runs.
    canvas.selectAsset(asset.assetId);
  }

  return room;
}

main().catch((err) => {
  document.body.textContent = `Failed to start: ${err instanceof Error ? err.message : String(err)}`;
});
