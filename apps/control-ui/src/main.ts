import {
  AssetAddMessage,
  ServerMessage,
  DEFAULT_TEXT_STYLE,
  DEFAULT_CLOCK_FORMAT,
  ClockFields,
  computeClockDisplay,
  localTimezone,
  extractYoutubeVideoId,
} from "@scenette/protocol";
import { ResilientConnection } from "@scenette/ws-client";
import { CanvasView, MIN_ASSET_SIZE } from "./canvas";
import { Sidebar } from "./sidebar";
import { SoundPanel } from "./sound";
import { ConnectedUsersPanel } from "./connectedUsers";
import { VariablesPanel } from "./variablesPanel";
import { uploadFile, uploadFromUrl, UploadResult } from "./upload";
import { UploadIndicator } from "./uploadIndicator";
import { loadConfig } from "./config";
import { AccessModal } from "./accessModal";
import { SettingsModal } from "./settingsModal";
import { YoutubeUrlModal } from "./youtubeUrlModal";
import { RoomPicker } from "./roomPicker";
import { StreamPreviewPanel } from "./streamPreview";
import { measureTextBoxSize } from "./textMeasure";
import {
  register,
  login,
  checkSession,
  onSessionExpired,
  logout,
  redeemInvite,
  resendVerification,
  listRooms,
  fetchAnnouncement,
  getRoomOwner,
  getBrowserSourceKey,
  regenerateBrowserSourceKey,
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
const uploadIndicatorEl = document.getElementById("upload-indicator");
const manageAccessButton = document.getElementById("manage-access-button");
const accessModalEl = document.getElementById("access-modal");
const settingsModalEl = document.getElementById("settings-modal");
const copyBrowserSourceButton = document.getElementById("copy-browser-source-button");
const regenerateBrowserSourceButton = document.getElementById("regenerate-browser-source-button");
const dashboardButton = document.getElementById("dashboard-button");
const statusEl = document.getElementById("status");

const contextMenu = document.getElementById("context-menu");
const contextMenuTextButton = document.getElementById("context-menu-text");
const contextMenuMediaButton = document.getElementById("context-menu-media");
const contextMenuClockButton = document.getElementById("context-menu-clock");
const contextMenuYoutubeButton = document.getElementById("context-menu-youtube");
const youtubeUrlModalEl = document.getElementById("youtube-url-modal");

if (
  !loginView || !appView || !loginForm || !usernameInput || !emailInput || !passwordInput || !loginHint ||
  !loginSubmitButton || !loginModeToggle || !loginToggleText ||
  !loginError || !loginMessage || !roomPickerViewEl ||
  !canvasContainer || !canvasInner || !objectsPanel || !propertiesPanel || !streamPreviewPanelEl ||
  !streamPreviewOverlayEl || !streamPreviewBorderEl || !streamSettingsModalEl || !soundPanelEl || !connectedUsersPanelEl ||
  !variablesPanelEl || !uploadInput || !uploadIndicatorEl || !manageAccessButton || !accessModalEl || !settingsModalEl ||
  !copyBrowserSourceButton || !dashboardButton || !statusEl || !contextMenu ||
  !contextMenuTextButton || !contextMenuMediaButton || !contextMenuClockButton ||
  !contextMenuYoutubeButton || !youtubeUrlModalEl
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

// How often to re-check the session while logged in. Each check slides the
// session TTL and re-issues the cookie server-side (keeping a long-open tab's
// cookie alive within any browser lifetime cap), and a 401 back from it is
// what detects a lapsed session and bounces the user to login -- so this also
// bounds how long object edits can silently no-op against an anonymous-
// downgraded WebSocket before the user is told to re-auth.
const SESSION_POLL_INTERVAL_MS = 2 * 60 * 1000;

// module-level `let`s so teardownCurrentRoom() has one thing to null out
// and the toolbar/context-menu handlers below (bound once, not per room)
// have one thing to read the *current* room's state from.
interface RoomSession {
  roomId: string;
  // True when this is the signed-in user's own room. Gates owner-only UI
  // (e.g. copying the browser-source URL) so a mod can't lift the OBS URL
  // for a room that isn't theirs.
  isOwner: boolean;
  // Username of the room's owner, for the header ("<owner>'s room"). Resolved
  // async for a mod-access room; the current user's own name when it's theirs.
  ownerName: string;
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
  // Set true once the first room:snapshot of this session has been fed to the
  // stream-preview panel via enterRoom() (a one-time reset of local-only view
  // toggles -- embed/interactive/opacity). Later snapshots go through the
  // seq-guarded applySettings() instead, so periodic polls and reconnects
  // don't keep re-resetting those toggles. See the room:snapshot case.
  streamPreviewEntered?: boolean;
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

// A plain-text paste with no accompanying file item -- used to catch a
// pasted image URL (e.g. copied via a browser's "Copy image address", or
// the URL text a "Copy image" sometimes leaves alongside its flattened png).
// Deliberately narrow: only a single bare http(s) URL and nothing else, so
// pasting an arbitrary sentence or multi-line text never gets mistaken for
// an upload attempt.
// True while the paste's actual target is a normal text-entry surface (an
// <input>/<textarea>, or a contentEditable element -- e.g. a text asset
// mid inline-edit, or the YouTube URL modal's own field) -- the global
// paste handler below must leave those alone entirely. Without this, pasting
// a URL into any such field also (incorrectly) created a canvas asset from
// the very same paste, since the window-level listener fires regardless of
// focus -- most visibly as two identical youtube assets when pasting into
// the "Add YouTube" modal's input, whose own submit already creates one.
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;
}

function extractMediaUrl(clipboardData: DataTransfer | null | undefined): string | undefined {
  const text = (clipboardData?.getData("text/uri-list") || clipboardData?.getData("text/plain"))?.trim();
  if (!text || /\s/.test(text)) return undefined;
  try {
    const url = new URL(text);
    return url.protocol === "http:" || url.protocol === "https:" ? text : undefined;
  } catch {
    return undefined;
  }
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

  // Bounce back to the login screen the moment the session is gone. Reloading
  // re-runs main(), whose checkSession() now 401s and falls through to
  // promptLogin -- reusing the existing logout-reload path rather than tearing
  // the logged-in view down by hand. Idempotent: a burst of 401s (e.g. the
  // poll and an in-flight action together) only navigates once.
  let reauthing = false;
  function forceReauth(): void {
    if (reauthing) return;
    reauthing = true;
    teardownCurrentRoom();
    window.location.href = window.location.pathname;
  }
  // Registered only now (post-login) so a 401 during the login flow itself --
  // e.g. wrong credentials -- doesn't trigger a reauth reload.
  onSessionExpired(forceReauth);
  // Periodic session check: drives the server-side sliding renewal above and,
  // on a 401, invokes forceReauth via onSessionExpired.
  const sessionPollTimer = setInterval(() => {
    void checkSession(httpApiUrl).catch(() => {
      // Network blip -- ignore; a real logout comes back as a 401, not a throw.
    });
  }, SESSION_POLL_INTERVAL_MS);
  window.addEventListener("beforeunload", () => clearInterval(sessionPollTimer));

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
    const roomPicker = new RoomPicker(roomPickerViewEl!, {
      onLogout: () => {
        void logout(httpApiUrl).then(() => {
          window.location.href = window.location.pathname;
        });
      },
      onSettings: () =>
        settingsModal.open(httpApiUrl, session!.email, () => {
          // The dashboard was rendered from the session fetched at login --
          // refetch so a newly-verified email's room shows up without
          // requiring a manual reload (personalRoomId/emailVerified only
          // change server-side here, never client-side).
          void checkSession(httpApiUrl).then((fresh) => {
            if (fresh) session = fresh;
            void showDashboardView();
          });
        }),
    });
    // Show the dashboard shell immediately, then fill it in -- otherwise the
    // room view just blanks out for the duration of the listRooms fetch,
    // which reads as a lag when clicking "Dashboard". The announcement is
    // fetched alongside the rooms so neither blocks the other.
    roomPicker.showLoading();
    const [rooms, announcement] = await Promise.all([
      listRooms(httpApiUrl),
      fetchAnnouncement(httpApiUrl),
    ]);
    const roomId = await roomPicker.pickRoom(rooms, session!.personalRoomId, {
      hasEmail: Boolean(session!.email),
      onResend: () => {
        // Feedback goes into the dashboard's own prompt -- the toolbar status
        // bar (statusEl) lives in the room view, which is hidden here.
        const setSub = (t: string) => {
          const sub = roomPickerViewEl!.querySelector(".room-picker-verify-sub");
          if (sub) sub.textContent = t;
        };
        setSub("Sending…");
        void resendVerification(httpApiUrl)
          .then(() => setSub("Verification email sent — check your inbox, then reload."))
          .catch((err) => setSub(`Couldn't send the email: ${err instanceof Error ? err.message : String(err)}`));
      },
    }, announcement);
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

  function createClockAsset(): void {
    if (!current) return;
    // Defaults to a live time-of-day clock in the viewer's own timezone.
    const clock: ClockFields = {
      clockMode: "clock",
      clockTimezone: localTimezone(),
      clockFormat: DEFAULT_CLOCK_FORMAT,
      clockRunning: true,
    };
    // Size the box to the initial rendered time up front (same as text), so it
    // appears already fitted rather than self-correcting on the first tick.
    const { width, height } = measureTextBoxSize(computeClockDisplay(clock, Date.now()), DEFAULT_TEXT_STYLE, MIN_ASSET_SIZE);
    const viewport = current.canvas.getViewport();
    const pos = current.createPosition ?? {
      x: viewport.x + viewport.width / 2 - width / 2,
      y: viewport.y + viewport.height / 2 - height / 2,
    };
    current.createPosition = undefined;

    current.connection.send({
      action: "asset:add",
      roomId: current.roomId,
      asset: { assetId: crypto.randomUUID(), type: "clock", x: pos.x, y: pos.y, width, height, ...clock },
    });
  }

  // No upload, no server round-trip for the video itself -- same shape as
  // createTextAsset/createClockAsset above, not placeUploadedAsset's
  // UploadResult-based path. There's no natural size to measure the way an
  // uploaded file has (nothing is fetched here), so this defaults to a
  // fixed 16:9 box matching the embed's own native 1280x720 ratio (see
  // canvas.ts's YOUTUBE_NATIVE_WIDTH).
  function createYoutubeAsset(videoId: string): void {
    if (!current) return;
    const width = 480;
    const height = 270;
    const viewport = current.canvas.getViewport();
    const pos = current.createPosition ??
      current.canvas.getCursorWorldPosition() ?? {
        x: viewport.x + viewport.width / 2 - width / 2,
        y: viewport.y + viewport.height / 2 - height / 2,
      };
    current.createPosition = undefined;

    current.connection.send({
      action: "asset:add",
      roomId: current.roomId,
      asset: {
        assetId: crypto.randomUUID(),
        type: "youtube",
        x: pos.x,
        y: pos.y,
        width,
        height,
        youtubeVideoId: videoId,
        // Matches the existing upload convention (see placeUploadedAsset) --
        // starts paused rather than autoplaying immediately into the room.
        paused: true,
      },
    });
  }

  contextMenuTextButton!.addEventListener("click", () => {
    contextMenu!.style.display = "none";
    createTextAsset();
  });

  function triggerMediaUpload(): void {
    uploadInput!.click();
  }

  // Like the context-menu wiring above: bound to a static element that
  // persists across room switches, so created exactly once.
  const uploadIndicator = new UploadIndicator(uploadIndicatorEl!);

  // Shared by both upload paths below (a real file, or bytes fetched
  // server-side from a pasted URL) -- once an UploadResult exists, placing
  // it on the canvas is identical either way.
  function placeUploadedAsset(result: UploadResult): void {
    if (!current) return;
    const { roomId, canvas, connection } = current;
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
  }

  async function handleUpload(file: File): Promise<void> {
    if (!current) return;
    const { roomId } = current;
    const indicator = uploadIndicator.begin(file);
    try {
      placeUploadedAsset(await uploadFile(httpApiUrl, roomId, file));
      indicator.succeed();
    } catch (err) {
      indicator.fail(err instanceof Error ? err.message : String(err));
    }
  }

  // The paste-a-URL path: a browser's "Copy image" flattens an animated gif
  // to a static png before the page ever sees it (that's the OS/browser
  // clipboard's own conversion, not something a page can opt out of), so a
  // pasted URL with no accompanying file is fetched by the server instead,
  // preserving the original bytes.
  async function handleUploadFromUrl(sourceUrl: string): Promise<void> {
    if (!current) return;
    const { roomId } = current;
    const indicator = uploadIndicator.beginFromUrl(sourceUrl);
    try {
      placeUploadedAsset(await uploadFromUrl(httpApiUrl, roomId, sourceUrl, assetsDomain));
      indicator.succeed();
    } catch (err) {
      indicator.fail(err instanceof Error ? err.message : String(err));
    }
  }

  uploadInput!.addEventListener("change", () => {
    const file = uploadInput!.files?.[0];
    if (file) void handleUpload(file);
    uploadInput!.value = "";
  });

  window.addEventListener("paste", (event) => {
    if (isEditableTarget(event.target)) return;
    const file = Array.from(event.clipboardData?.items ?? [])
      .find((item) => item.kind === "file")
      ?.getAsFile();
    if (file) {
      void handleUpload(file);
      return;
    }
    const pastedUrl = extractMediaUrl(event.clipboardData);
    if (!pastedUrl) return;
    // Checked before the generic upload-from-url path -- a YouTube page
    // isn't a downloadable media file, so fetching it server-side the way
    // an image/gif URL is would just fail.
    const videoId = extractYoutubeVideoId(pastedUrl);
    if (videoId) {
      createYoutubeAsset(videoId);
    } else {
      void handleUploadFromUrl(pastedUrl);
    }
  });

  contextMenuMediaButton!.addEventListener("click", () => {
    contextMenu!.style.display = "none";
    triggerMediaUpload();
  });

  const youtubeUrlModal = new YoutubeUrlModal(youtubeUrlModalEl!);
  contextMenuYoutubeButton!.addEventListener("click", () => {
    contextMenu!.style.display = "none";
    youtubeUrlModal.open((videoId) => createYoutubeAsset(videoId));
  });

  contextMenuClockButton!.addEventListener("click", () => {
    contextMenu!.style.display = "none";
    createClockAsset();
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
    if (!current || !current.isOwner) return;
    try {
      // The URL is keyed on the room's opaque obsKey (owner-only), not its
      // roomId -- fetched fresh here rather than embedded, so it stays
      // owner-gated end to end.
      const obsKey = await getBrowserSourceKey(httpApiUrl, current.roomId);
      const url = `${browserSourceUrl}/?obs=${encodeURIComponent(obsKey)}`;
      try {
        await navigator.clipboard.writeText(url);
        statusEl!.textContent = "browser source URL copied to clipboard";
      } catch {
        // Clipboard API can be denied (e.g. insecure context, permissions) --
        // fall back to showing the URL directly so it's still usable.
        statusEl!.textContent = `copy failed, URL: ${url}`;
      }
    } catch (err) {
      statusEl!.textContent = `couldn't get browser source URL: ${err instanceof Error ? err.message : String(err)}`;
    }
  });

  regenerateBrowserSourceButton!.addEventListener("click", async () => {
    if (!current || !current.isOwner) return;
    // Destructive: the current URL stops working immediately, so confirm first.
    if (
      !window.confirm(
        "Regenerate the browser source URL? The current URL will stop working immediately and must be replaced in OBS."
      )
    ) {
      return;
    }
    try {
      const obsKey = await regenerateBrowserSourceKey(httpApiUrl, current.roomId);
      const url = `${browserSourceUrl}/?obs=${encodeURIComponent(obsKey)}`;
      try {
        await navigator.clipboard.writeText(url);
        statusEl!.textContent = "browser source URL regenerated and copied — update it in OBS";
      } catch {
        statusEl!.textContent = `browser source URL regenerated — update it in OBS: ${url}`;
      }
    } catch (err) {
      statusEl!.textContent = `couldn't regenerate browser source URL: ${err instanceof Error ? err.message : String(err)}`;
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
  // An account's owned room is always exactly its own personalRoomId --
  // invite redemption only ever grants "mod" access to someone else's room
  // (see accounts/store.ts), never "owner" -- so this comparison alone is
  // enough to know ownership for every entry path (dashboard pick, deep
  // link, invite redemption) with no extra membership lookup needed.
  const isOwner = roomId === session.personalRoomId;
  streamPreviewPanel.setIsOwner(isOwner);

  // Owner-only room controls. Managing access (members/invites) and the
  // browser-source URL are all owner-gated server-side too -- hiding the
  // buttons for a mod just avoids dead-end clicks into 403s.
  manageAccessButton!.style.display = isOwner ? "" : "none";
  copyBrowserSourceButton!.style.display = isOwner ? "" : "none";
  regenerateBrowserSourceButton!.style.display = isOwner ? "" : "none";

  // Header shows whose room this is. Known immediately when it's the current
  // user's own; resolved async for a mod-access room.
  const setRoomHeader = (owner: string) => {
    statusEl!.textContent = `${owner}'s room`;
  };
  setRoomHeader(isOwner ? session.username : "…");
  if (!isOwner) {
    void getRoomOwner(httpApiUrl, roomId)
      .then((owner) => {
        if (current?.roomId === roomId && owner) {
          current.ownerName = owner;
          setRoomHeader(owner);
        }
      })
      .catch(() => {
        /* leave the placeholder -- not worth surfacing a header lookup failure */
      });
  }

  const room: RoomSession = {
    roomId,
    isOwner,
    ownerName: isOwner ? session.username : "",
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
        // Selecting an asset clears any variable selection/highlight so only
        // one thing is ever focused in the properties card at a time.
        if (assetId) variablesPanel.setSelectedKey(undefined);
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
    onVariableSet: (key, type, value) => room.connection.send({ action: "variable:set", roomId, key, type, value }),
    onVariableDelete: (key) => room.connection.send({ action: "variable:delete", roomId, key }),
    // Rename = create-under-the-new-key + delete-the-old (the key is identity).
    // Skipped if the new key already exists; the card is re-selected on the new
    // key either way so the user stays on the variable they were editing.
    onVariableRename: (oldKey, newKey) => {
      const existing = variablesPanel.get(oldKey);
      if (!existing) return;
      if (variablesPanel.get(newKey)) {
        sidebar.selectVariable(existing); // collision -- revert to the old key
        return;
      }
      const renamed = { ...existing, key: newKey };
      room.connection.send({ action: "variable:set", roomId, key: newKey, type: existing.type, value: existing.value });
      room.connection.send({ action: "variable:delete", roomId, key: oldKey });
      // Rename in place so the row keeps its position (delete+append would move
      // it to the bottom). The old key's later variable:deleted echo is a no-op.
      variablesPanel.renameKey(oldKey, newKey, renamed);
      variablesPanel.setSelectedKey(newKey);
      sidebar.selectVariable(renamed);
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
    // Selecting a variable focuses it in the shared properties card; clear any
    // canvas asset selection so only one thing is ever "selected" at a time.
    onSelect: (variable) => {
      canvas.selectAsset(undefined);
      sidebar.selectVariable(variable);
      variablesPanel.setSelectedKey(variable.key);
    },
    // Instant-create a default variable (no form/confirm), then select it in
    // the card for immediate editing/renaming.
    onAdd: () => {
      const key = variablesPanel.nextNewVariableKey();
      const created = { key, type: "number" as const, value: "0", createdAt: new Date().toISOString() };
      room.connection.send({ action: "variable:set", roomId, key, type: "number", value: "0" });
      variablesPanel.upsertVariable(created); // optimistic; server echo confirms
      variablesPanel.setSelectedKey(key);
      canvas.selectAsset(undefined);
      sidebar.selectVariable(created);
    },
    onDelete: (key) => room.connection.send({ action: "variable:delete", roomId, key }),
    onSet: (key, type, value) => room.connection.send({ action: "variable:set", roomId, key, type, value }),
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
          sidebar.setStorageQuota(message.storageQuotaBytes);
          soundPanel.setGlobalVolume(message.globalVolume, message.globalVolumeSeq);
          // First snapshot of this room session uses enterRoom (not
          // applySettings): this panel is a singleton that survives every
          // room switch, so a plain seq-guarded apply would compare this
          // room's stored seq against whatever this browser last applied in
          // the PREVIOUS room, silently rejecting the new room's real
          // settings as "stale" whenever that happened to be lower. But
          // enterRoom also RESETS the local-only view toggles (embed /
          // interactive / opacity), so it must run exactly once per entry --
          // NOT on every periodic room:snapshot poll (line ~583), which would
          // keep unchecking the user's embed toggle and tearing down the
          // iframe a few seconds after they set it. Later snapshots (polls,
          // reconnects) use the seq-guarded applySettings, which leaves those
          // local toggles alone. See streamPreview.ts's enterRoom() /
          // applySettings() doc comments.
          if (room.streamPreviewEntered) {
            streamPreviewPanel.applySettings(message.streamPreviewSettings, message.streamPreviewSettingsSeq);
          } else {
            streamPreviewPanel.enterRoom(message.streamPreviewSettings, message.streamPreviewSettingsSeq);
            room.streamPreviewEntered = true;
          }
          canvas.setVariables(Object.fromEntries(message.variables.map((v) => [v.key, v])));
          variablesPanel.setVariables(message.variables);
          // Keep the properties card's variable (if any) in sync with the
          // authoritative snapshot -- refresh its value or drop it if deleted.
          sidebar.reconcileVariables(message.variables);
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
          sidebar.refreshVariable(message.variable);
          break;
        case "variable:deleted":
          variablesPanel.removeVariable(message.key);
          canvas.removeVariable(message.key);
          sidebar.onVariableDeleted(message.key);
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
      youtubeVideoId: source.youtubeVideoId,
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
