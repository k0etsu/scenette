import { AssetAddMessage, ServerMessage, DEFAULT_TEXT_STYLE } from "@scenette/protocol";
import { ResilientConnection } from "@scenette/ws-client";
import { CanvasView, MIN_ASSET_SIZE } from "./canvas";
import { Sidebar } from "./sidebar";
import { SoundPanel } from "./sound";
import { ConnectedUsersPanel } from "./connectedUsers";
import { VariablesPanel } from "./variablesPanel";
import { uploadFile } from "./upload";
import { loadConfig } from "./config";
import { AccessModal } from "./accessModal";
import { SettingsModal } from "./settingsModal";
import { RoomPicker } from "./roomPicker";
import { StreamPreviewPanel } from "./streamPreview";
import { measureTextBoxSize } from "./textMeasure";
import {
  register,
  login,
  checkSession,
  logout,
  redeemInvite,
  resendVerification,
  listRooms,
  SessionInfo,
} from "./auth";

const loginView = document.getElementById("login-view");
const appView = document.getElementById("app-view");
const loginForm = document.getElementById("login-form") as HTMLFormElement | null;
const usernameInput = document.getElementById("login-username") as HTMLInputElement | null;
const emailInput = document.getElementById("login-email") as HTMLInputElement | null;
const passwordInput = document.getElementById("login-password") as HTMLInputElement | null;
const loginHint = document.getElementById("login-hint");
const loginSubmitButton = document.getElementById("login-submit-button");
const loginModeToggle = document.getElementById("login-mode-toggle");
const loginToggleText = document.getElementById("login-toggle-text");
const loginError = document.getElementById("login-error");
const loginMessage = document.getElementById("login-message");
const roomPickerViewEl = document.getElementById("room-picker-view");

const canvasContainer = document.getElementById("canvas-container");
const canvasInner = document.getElementById("canvas-inner");
const objectsPanel = document.getElementById("objects-panel");
const propertiesPanel = document.getElementById("properties-panel");
const streamPreviewPanelEl = document.getElementById("stream-preview-panel");
const streamPreviewOverlayEl = document.getElementById("stream-preview-overlay");
const streamPreviewBorderEl = document.getElementById("stream-preview-border");
const streamSettingsModalEl = document.getElementById("stream-settings-modal");
const soundPanelEl = document.getElementById("sound-panel");
const connectedUsersPanelEl = document.getElementById("connected-users-panel");
const variablesPanelEl = document.getElementById("variables-panel");
const uploadInput = document.getElementById("upload-input") as HTMLInputElement | null;
const manageAccessButton = document.getElementById("manage-access-button");
const accessModalEl = document.getElementById("access-modal");
const settingsModalEl = document.getElementById("settings-modal");
const copyBrowserSourceButton = document.getElementById("copy-browser-source-button");
const dashboardButton = document.getElementById("dashboard-button");
const statusEl = document.getElementById("status");

const contextMenu = document.getElementById("context-menu");
const contextMenuTextButton = document.getElementById("context-menu-text");
const contextMenuMediaButton = document.getElementById("context-menu-media");

if (
  !loginView || !appView || !loginForm || !usernameInput || !emailInput || !passwordInput || !loginHint ||
  !loginSubmitButton || !loginModeToggle || !loginToggleText ||
  !loginError || !loginMessage || !roomPickerViewEl ||
  !canvasContainer || !canvasInner || !objectsPanel || !propertiesPanel || !streamPreviewPanelEl ||
  !streamPreviewOverlayEl || !streamPreviewBorderEl || !streamSettingsModalEl || !soundPanelEl || !connectedUsersPanelEl ||
  !variablesPanelEl || !uploadInput || !manageAccessButton || !accessModalEl || !settingsModalEl ||
  !copyBrowserSourceButton || !dashboardButton || !statusEl || !contextMenu ||
  !contextMenuTextButton || !contextMenuMediaButton
) {
  throw new Error("Missing required DOM elements");
}

// Everything that lives for exactly one room at a time -- torn down and
// rebuilt on every room switch (Dashboard button, picking a different room,
// browser back/forward). Kept in one mutable holder rather than scattered
// Deliberately more conservative than browser-source's own poll (see that
// app's main.ts) -- cost here scales with concurrent collaborator tabs per
// room, not just one OBS source, and (unlike browser-source) a poll landing
// mid-edit carries real correctness risk without the guards in canvas.ts's
// setAssets. This is a slower defense-in-depth safety net for a
// *collaborator's* drift, not the primary (already near-real-time) sync
// path for this browser's own edits.
const SNAPSHOT_POLL_INTERVAL_MS = 5000;

// module-level `let`s so teardownCurrentRoom() has one thing to null out
// and the toolbar/context-menu handlers below (bound once, not per room)
// have one thing to read the *current* room's state from.
interface RoomSession {
  roomId: string;
  connection: ResilientConnection;
  canvas: CanvasView;
  sidebar: Sidebar;
  connectedUsersPanel: ConnectedUsersPanel;
  // Where the next text/media asset (context-menu "Text"/"Media") should
  // land -- world coords from a right-click, or undefined to default to
  // the viewport center.
  createPosition?: { x: number; y: number };
  // Periodic room:snapshot:request poll (see the connection's onOpen below)
  // -- self-heals any delta that lost its seq race against another message
  // and got silently dropped server-side. Cleared in teardownCurrentRoom()
  // so switching rooms doesn't leave a timer still polling a room this
  // connection has left.
  pollTimer?: ReturnType<typeof setInterval>;
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

  const settingsModal = new SettingsModal(settingsModalEl!);

  function setUrl(roomId: string | undefined, push: boolean): void {
    const next = new URLSearchParams();
    if (roomId) next.set("roomId", roomId);
    const url = `${window.location.pathname}${next.toString() ? "?" + next.toString() : ""}`;
    if (push) window.history.pushState(null, "", url);
    else window.history.replaceState(null, "", url);
  }

  function teardownCurrentRoom(): void {
    if (!current) return;
    if (current.pollTimer) clearInterval(current.pollTimer);
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
    current = enterRoom(wsUrl, httpApiUrl, assetsDomain, browserSourceUrl, session!, roomId, streamPreviewPanel);
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
      onSettings: () => settingsModal.open(httpApiUrl, session!.email),
    });
    const roomId = await roomPicker.pickRoom(rooms, session!.personalRoomId, {
      hasEmail: Boolean(session!.email),
      onResend: () => {
        void resendVerification(httpApiUrl)
          .then(() => {
            statusEl!.textContent = "Verification email sent — check your inbox, then reload.";
          })
          .catch((err) => {
            statusEl!.textContent = `Could not resend verification: ${err instanceof Error ? err.message : String(err)}`;
          });
      },
    });
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

  // ---- Context-menu wiring, bound exactly once for the whole page's
  // lifetime -- these target static DOM elements that persist across every
  // room switch. Each reads/writes the *current* room via the mutable
  // `current` holder above rather than closing over one room's state.

  function createTextAsset(): void {
    if (!current) return;
    const text = "New Text";

    // Measured up front (rather than a fixed placeholder size that only
    // self-corrects once the user first edits it) so the box already fits
    // "New Text" the instant it appears -- matches DEFAULT_TEXT_STYLE since
    // no per-asset style overrides exist yet for a brand-new asset.
    const { width, height } = measureTextBoxSize(text, DEFAULT_TEXT_STYLE, MIN_ASSET_SIZE);
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
      // createPosition (an explicit right-click "add media" here) wins when
      // set; otherwise this was triggered from the toolbar button or a
      // clipboard paste, neither of which has a click of its own to read a
      // position from -- fall back to wherever the mouse was last actually
      // over the canvas rather than always dropping the asset dead center.
      const pos = current.createPosition ??
        canvas.getCursorWorldPosition() ?? {
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
          // Starts paused rather than autoplaying immediately on upload --
          // a streamer placing a video/audio clip needs a moment to
          // position/size it before it's actually live for viewers, and
          // autoplaying it into an empty room (or over background audio)
          // the instant it lands was surprising. No-op for every other
          // asset type, which ignores `paused` entirely (no play/pause UI
          // is ever shown for them).
          paused: result.type === "video" || result.type === "audio" ? true : undefined,
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

  const streamPreviewPanel = new StreamPreviewPanel(
    streamPreviewPanelEl!,
    streamPreviewOverlayEl!,
    streamPreviewBorderEl!,
    streamSettingsModalEl!,
    canvasInner!,
    {
      // streamPreviewPanel is constructed once at app level and survives
      // every room switch (see its own class doc for why) -- reads the
      // mutable `current` fresh here rather than closing over one room's
      // connection, same pattern as the top-level context-menu handlers.
      onSettingsChange: (settings, seq) => {
        if (!current) return;
        current.connection.send({
          action: "room:setStreamPreviewSettings",
          roomId: current.roomId,
          settings,
          seq,
        });
      },
    }
  );

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

  // ---- Initial render: an explicit room requested (a bookmarked/shared
  // link, or the roomId just set after an invite redemption above) goes
  // straight there. Otherwise -- every bare login/visit -- always lands on
  // the dashboard first, regardless of how many rooms the account has, so
  // there's a consistent, predictable landing spot rather than sometimes
  // skipping straight into a room.
  const explicitRoomId = params.get("roomId");
  if (explicitRoomId) {
    goToRoom(explicitRoomId, false);
  } else {
    await showDashboardView();
  }
}

// Single form, toggled between "log in" and "create an account" rather than
// two always-visible buttons -- with both visible at once, pressing Enter
// in the password field was ambiguous (which one does it trigger?), and the
// register-only email field sitting between username and password broke
// the username -> password tab order for the far more common login case.
// Only the toggle link's click handler ever switches `mode`; the form's own
// submit handler just reads whatever `mode` currently is.
function promptLogin(httpApiUrl: string): Promise<SessionInfo> {
  return new Promise((resolve) => {
    let mode: "login" | "register" = "login";

    function applyMode(): void {
      const isRegister = mode === "register";
      emailInput!.style.display = isRegister ? "block" : "none";
      loginHint!.style.display = isRegister ? "block" : "none";
      loginSubmitButton!.textContent = isRegister ? "Create account" : "Log in";
      loginToggleText!.textContent = isRegister ? "Already have an account?" : "Don't have an account?";
      loginModeToggle!.textContent = isRegister ? "Log in" : "Create one";
      loginError!.textContent = "";
      loginMessage!.textContent = "";
    }

    applyMode(); // sync with mode's initial value, independent of the HTML's own static defaults

    loginModeToggle!.addEventListener("click", () => {
      mode = mode === "login" ? "register" : "login";
      applyMode();
    });

    loginForm!.addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        loginError!.textContent = "";
        loginMessage!.textContent = "";
        const session =
          mode === "login"
            ? await login(httpApiUrl, usernameInput!.value, passwordInput!.value)
            : // Registering logs straight in now -- no email verification step.
              await register(httpApiUrl, usernameInput!.value, emailInput!.value || undefined, passwordInput!.value);
        resolve(session);
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
  roomId: string,
  streamPreviewPanel: StreamPreviewPanel
): RoomSession {
  statusEl!.textContent = `room: ${roomId} (${session.username})`;

  // An account's owned room is always exactly its own personalRoomId --
  // invite redemption only ever grants "mod" access to someone else's room
  // (see accounts/store.ts), never "owner" -- so this comparison alone is
  // enough to know ownership for every entry path (dashboard pick, deep
  // link, invite redemption) with no extra membership lookup needed.
  streamPreviewPanel.setIsOwner(roomId === session.personalRoomId);

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
    canvasInner!,
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
      onAssetStop: (assetId) => {
        room.connection.send({ action: "asset:stop", roomId, assetId });
      },
      onContextMenu: (worldX, worldY, screenX, screenY) => {
        room.createPosition = { x: worldX, y: worldY };
        showContextMenu(screenX, screenY);
      },
      onSelectionChange: (assetId) => {
        room.sidebar.setSelected(assetId);
      },
      // The stream-preview overlay is a sibling of #canvas-inner, not a
      // child of it, so it survives room switches (CanvasView.dispose()
      // wipes #canvas-inner's contents, not its own container) -- see
      // streamPreview.ts and index.html.
      onViewportTransformChanged: (rect) => streamPreviewPanel.setScreenRect(rect),
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
    onTextEditBlur: (assetId) => canvas.flushPendingTextPatch(assetId),
    onStop: (assetId) => {
      canvas.stopAsset(assetId);
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
    // No token in the URL -- the browser sends the HttpOnly session cookie on
    // the WS upgrade handshake, and $connect reads it from there.
    onOpen: () => {
      connection.send({ action: "room:snapshot:request", roomId });

      // (Re-)armed here rather than started once outside onOpen -- onOpen
      // already fires on every reconnect (proactive swap or drop/retry), so
      // arming from inside it guarantees no two overlapping intervals can
      // ever run across a reconnect. Self-heals any delta that lost its seq
      // race against another message and got silently dropped server-side
      // (see roomState.ts's per-asset conditional write) -- see
      // canvas.ts's setAssets for the guards that keep this from clobbering
      // an in-progress local edit.
      if (room.pollTimer) clearInterval(room.pollTimer);
      room.pollTimer = setInterval(() => {
        connection.send({ action: "room:snapshot:request", roomId });
      }, SNAPSHOT_POLL_INTERVAL_MS);
    },
    onMessage: (message: ServerMessage) => {
      switch (message.type) {
        case "room:snapshot":
          canvas.setViewport({ roomId, ...message.viewport });
          canvas.setAssets(message.assets);
          // canvas.getAllAssets() (not message.assets directly) -- the
          // sidebar should only ever see whatever canvas actually decided
          // to accept after its own seq/dragging/inline-edit guards, not
          // the raw (potentially stale-for-an-in-flight-edit) snapshot.
          sidebar.setAssets(canvas.getAllAssets());
          soundPanel.setGlobalVolume(message.globalVolume, message.globalVolumeSeq);
          // enterRoom (not applySettings) -- this panel is a singleton that
          // survives every room switch, so a plain seq-guarded apply here
          // would compare this room's stored seq against whatever this
          // browser last applied in the PREVIOUS room, silently rejecting
          // the new room's real settings as "stale" whenever that happened
          // to be lower. See streamPreview.ts's enterRoom() doc comment.
          streamPreviewPanel.enterRoom(message.streamPreviewSettings, message.streamPreviewSettingsSeq);
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
        case "asset:stopped":
          canvas.applyRemoteStop(message.assetId);
          break;
        case "room:globalVolumeChanged":
          soundPanel.setGlobalVolume(message.globalVolume, message.seq);
          break;
        case "room:streamPreviewSettingsChanged":
          streamPreviewPanel.applySettings(message.settings, message.seq);
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
      name: source.name,
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
      fontFamily: source.fontFamily,
      fontSize: source.fontSize,
      fontWeight: source.fontWeight,
      textAlign: source.textAlign,
      textColor: source.textColor,
      backgroundColor: source.backgroundColor,
      backgroundAlpha: source.backgroundAlpha,
      shadowEnabled: source.shadowEnabled,
      shadowX: source.shadowX,
      shadowY: source.shadowY,
      shadowBlur: source.shadowBlur,
      shadowColor: source.shadowColor,
      outlineEnabled: source.outlineEnabled,
      outlineColor: source.outlineColor,
      outlineWidth: source.outlineWidth,
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
