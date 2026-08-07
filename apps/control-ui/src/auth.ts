// Auth is cookie-based: the server sets an HttpOnly session cookie on
// register/login (and clears it on logout / account deletion), so there is no
// token for page JS to read or store -- every request just opts into sending
// the cookie with `credentials: "include"`.

export interface SessionInfo {
  username: string;
  // Undefined until the account verifies an email -- an account only owns a
  // room once verified. Mods on someone else's room never get one.
  personalRoomId?: string;
  email?: string;
  emailVerified: boolean;
}

// Sent on every request so the HttpOnly session cookie rides along
// (cross-subdomain, same-site).
const withCredentials: RequestInit = { credentials: "include" };

// Called whenever the server reports the session is gone (any authed request
// returning 401, or the periodic session poll finding no session). The app
// registers a handler that bounces the user to the login screen -- object
// edits go over the WebSocket, which silently downgrades a lapsed session to
// an anonymous read-only socket and drops writes with no error, so without
// this nothing surfaces until the user manually reloads.
let sessionExpiredHandler: (() => void) | undefined;
export function onSessionExpired(handler: () => void): void {
  sessionExpiredHandler = handler;
}
function notifySessionExpired(): void {
  sessionExpiredHandler?.();
}

async function parseJsonOrThrow(res: Response): Promise<any> {
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) notifySessionExpired();
  if (!res.ok) throw new Error(data.error ?? `Request failed: ${res.status}`);
  return data;
}

function toSessionInfo(data: any): SessionInfo {
  return {
    username: data.username,
    personalRoomId: data.personalRoomId,
    email: data.email,
    emailVerified: data.emailVerified ?? false,
  };
}

export async function register(
  httpApiUrl: string,
  username: string,
  email: string | undefined,
  password: string
): Promise<SessionInfo> {
  const res = await fetch(`${httpApiUrl}/auth/register`, {
    ...withCredentials,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, email, password }),
  });
  return toSessionInfo(await parseJsonOrThrow(res));
}

export async function login(httpApiUrl: string, username: string, password: string): Promise<SessionInfo> {
  const res = await fetch(`${httpApiUrl}/auth/login`, {
    ...withCredentials,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  return toSessionInfo(await parseJsonOrThrow(res));
}

// Returns null (rather than throwing) on any invalid/expired/missing session —
// callers use this purely to decide "show the login form or not."
export async function checkSession(httpApiUrl: string): Promise<SessionInfo | null> {
  const res = await fetch(`${httpApiUrl}/auth/session`, withCredentials);
  // 401 is a definitive "logged out" -- fire the handler so an active session
  // that lapsed mid-use kicks to login. Other non-ok statuses (e.g. a
  // transient 5xx) are treated as "unknown", not logged-out, so a blip doesn't
  // eject the user. A network error rejects the fetch (handled by callers).
  if (res.status === 401) notifySessionExpired();
  if (!res.ok) return null;
  return toSessionInfo(await res.json());
}

// Re-sends the verification email for the account's current pending email
// (responds 200 regardless, to avoid leaking account state).
export async function resendVerification(httpApiUrl: string): Promise<void> {
  const res = await fetch(`${httpApiUrl}/auth/resend-verification`, { ...withCredentials, method: "POST" });
  await parseJsonOrThrow(res);
}

export async function logout(httpApiUrl: string): Promise<void> {
  // Best-effort — the server clears the cookie; nothing to clean up locally.
  await fetch(`${httpApiUrl}/auth/logout`, { ...withCredentials, method: "POST" }).catch(() => {});
}

// Admin-managed dashboard announcement (an S3-backed message, editable
// without a redeploy). Returns null when there's nothing to show or the
// fetch fails -- the dashboard simply omits the banner in that case.
export async function fetchAnnouncement(httpApiUrl: string): Promise<string | null> {
  try {
    const res = await fetch(`${httpApiUrl}/announcement`, withCredentials);
    if (!res.ok) return null;
    const data = await res.json();
    return typeof data.message === "string" ? data.message : null;
  } catch {
    return null;
  }
}

export interface RoomMembership {
  roomId: string;
  role: "owner" | "mod";
  ownerUsername?: string;
}

export async function listRooms(httpApiUrl: string): Promise<RoomMembership[]> {
  const res = await fetch(`${httpApiUrl}/auth/rooms`, withCredentials);
  const data = await parseJsonOrThrow(res);
  return data.rooms;
}

// The owner of a room the caller is a member of -- for the room header.
export async function getRoomOwner(httpApiUrl: string, roomId: string): Promise<string | undefined> {
  const res = await fetch(`${httpApiUrl}/auth/rooms/${encodeURIComponent(roomId)}/owner`, withCredentials);
  const data = await parseJsonOrThrow(res);
  return data.ownerUsername;
}

// Owner-only: the opaque key used to build the browser-source URL.
export async function getBrowserSourceKey(httpApiUrl: string, roomId: string): Promise<string> {
  const res = await fetch(`${httpApiUrl}/auth/rooms/${encodeURIComponent(roomId)}/obs-url`, withCredentials);
  const data = await parseJsonOrThrow(res);
  return data.obsKey;
}

// Owner-only: rotate the key, invalidating any previously-shared URL.
export async function regenerateBrowserSourceKey(httpApiUrl: string, roomId: string): Promise<string> {
  const res = await fetch(`${httpApiUrl}/auth/rooms/${encodeURIComponent(roomId)}/obs-url`, {
    ...withCredentials,
    method: "POST",
  });
  const data = await parseJsonOrThrow(res);
  return data.obsKey;
}

export interface Member {
  accountId: string;
  roomId: string;
  role: "owner" | "mod";
}

export async function listMembers(httpApiUrl: string, roomId: string): Promise<Member[]> {
  const res = await fetch(`${httpApiUrl}/auth/rooms/${encodeURIComponent(roomId)}/members`, withCredentials);
  const data = await parseJsonOrThrow(res);
  return data.members;
}

export async function revokeMember(httpApiUrl: string, roomId: string, username: string): Promise<void> {
  const res = await fetch(
    `${httpApiUrl}/auth/rooms/${encodeURIComponent(roomId)}/members/${encodeURIComponent(username)}`,
    { ...withCredentials, method: "DELETE" }
  );
  await parseJsonOrThrow(res);
}

export interface Invite {
  inviteToken: string;
  createdAt: string;
}

export async function createInvite(httpApiUrl: string, roomId: string): Promise<Invite> {
  const res = await fetch(`${httpApiUrl}/auth/rooms/${encodeURIComponent(roomId)}/invites`, {
    ...withCredentials,
    method: "POST",
  });
  return parseJsonOrThrow(res);
}

export async function listInvites(httpApiUrl: string, roomId: string): Promise<Invite[]> {
  const res = await fetch(`${httpApiUrl}/auth/rooms/${encodeURIComponent(roomId)}/invites`, withCredentials);
  const data = await parseJsonOrThrow(res);
  return data.invites;
}

export async function revokeInvite(httpApiUrl: string, roomId: string, inviteToken: string): Promise<void> {
  const res = await fetch(
    `${httpApiUrl}/auth/rooms/${encodeURIComponent(roomId)}/invites/${encodeURIComponent(inviteToken)}`,
    { ...withCredentials, method: "DELETE" }
  );
  await parseJsonOrThrow(res);
}

// Called after the invitee is already logged in (registering/logging in is
// a separate step handled by the normal login form) -- attaches their
// account to the invite's room as a mod. Returns the roomId so the caller
// can navigate straight there.
export async function redeemInvite(httpApiUrl: string, inviteToken: string): Promise<{ roomId: string }> {
  const res = await fetch(`${httpApiUrl}/auth/invites/${encodeURIComponent(inviteToken)}/redeem`, {
    ...withCredentials,
    method: "POST",
  });
  return parseJsonOrThrow(res);
}

export async function changePassword(httpApiUrl: string, currentPassword: string, newPassword: string): Promise<void> {
  const res = await fetch(`${httpApiUrl}/auth/change-password`, {
    ...withCredentials,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ currentPassword, newPassword }),
  });
  await parseJsonOrThrow(res);
}

// Empty string clears the account's stored email.
export async function changeEmail(httpApiUrl: string, email: string): Promise<void> {
  const res = await fetch(`${httpApiUrl}/auth/change-email`, {
    ...withCredentials,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  await parseJsonOrThrow(res);
}

// Irreversible -- wipes every room the account owns (assets, S3 objects,
// memberships, invites), its own membership on any room it's only a mod on
// elsewhere, every session, and the account itself. The server clears the
// session cookie in its response.
export async function deleteAccount(httpApiUrl: string, password: string): Promise<void> {
  const res = await fetch(`${httpApiUrl}/auth/account`, {
    ...withCredentials,
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  await parseJsonOrThrow(res);
}
