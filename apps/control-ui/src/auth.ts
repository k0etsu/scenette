const SESSION_TOKEN_KEY = "scenette.sessionToken";

export interface SessionInfo {
  username: string;
  personalRoomId: string;
}

export function getStoredToken(): string | null {
  return window.localStorage.getItem(SESSION_TOKEN_KEY);
}

function storeToken(token: string): void {
  window.localStorage.setItem(SESSION_TOKEN_KEY, token);
}

export function clearStoredToken(): void {
  window.localStorage.removeItem(SESSION_TOKEN_KEY);
}

async function parseJsonOrThrow(res: Response): Promise<any> {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Request failed: ${res.status}`);
  return data;
}

// Thrown specifically by login() when the account exists and the password
// is correct, but the email hasn't been verified yet -- distinct from a
// generic Error so main.ts can offer a "resend verification email" action
// rather than just showing the message text.
export class UnverifiedEmailError extends Error {
  constructor(public readonly username: string) {
    super("Email not verified");
  }
}

export interface RegisterResult {
  username: string;
  personalRoomId: string;
  message: string;
}

// Deliberately does NOT return a SessionInfo / store a token -- registering
// no longer logs you in. The account is created but login is blocked until
// the verification email's link is clicked (see login() below).
export async function register(
  httpApiUrl: string,
  username: string,
  email: string,
  password: string
): Promise<RegisterResult> {
  const res = await fetch(`${httpApiUrl}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, email, password }),
  });
  return parseJsonOrThrow(res);
}

export async function login(httpApiUrl: string, username: string, password: string): Promise<SessionInfo> {
  const res = await fetch(`${httpApiUrl}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (data.unverified) throw new UnverifiedEmailError(username);
    throw new Error(data.error ?? `Request failed: ${res.status}`);
  }
  storeToken(data.sessionToken);
  return { username: data.username, personalRoomId: data.personalRoomId };
}

export async function resendVerification(httpApiUrl: string, username: string): Promise<void> {
  const res = await fetch(`${httpApiUrl}/auth/resend-verification`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username }),
  });
  await parseJsonOrThrow(res);
}

// Returns null (rather than throwing) on any invalid/expired/missing token —
// callers use this purely to decide "show the login form or not."
export async function checkSession(httpApiUrl: string): Promise<SessionInfo | null> {
  const token = getStoredToken();
  if (!token) return null;

  const res = await fetch(`${httpApiUrl}/auth/session`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    clearStoredToken();
    return null;
  }
  const data = await res.json();
  return { username: data.username, personalRoomId: data.personalRoomId };
}

export async function logout(httpApiUrl: string): Promise<void> {
  const token = getStoredToken();
  clearStoredToken();
  if (!token) return;
  await fetch(`${httpApiUrl}/auth/logout`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  }).catch(() => {
    // Best-effort — the local token is already cleared either way.
  });
}

export interface RoomMembership {
  roomId: string;
  role: "owner" | "mod";
  ownerUsername?: string;
}

export async function listRooms(httpApiUrl: string): Promise<RoomMembership[]> {
  const token = getStoredToken();
  if (!token) throw new Error("Not logged in");
  const res = await fetch(`${httpApiUrl}/auth/rooms`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await parseJsonOrThrow(res);
  return data.rooms;
}

function authHeaders(): Record<string, string> {
  const token = getStoredToken();
  if (!token) throw new Error("Not logged in");
  return { Authorization: `Bearer ${token}` };
}

export interface Member {
  accountId: string;
  roomId: string;
  role: "owner" | "mod";
}

export async function listMembers(httpApiUrl: string, roomId: string): Promise<Member[]> {
  const res = await fetch(`${httpApiUrl}/auth/rooms/${encodeURIComponent(roomId)}/members`, {
    headers: authHeaders(),
  });
  const data = await parseJsonOrThrow(res);
  return data.members;
}

export async function revokeMember(httpApiUrl: string, roomId: string, username: string): Promise<void> {
  const res = await fetch(
    `${httpApiUrl}/auth/rooms/${encodeURIComponent(roomId)}/members/${encodeURIComponent(username)}`,
    { method: "DELETE", headers: authHeaders() }
  );
  await parseJsonOrThrow(res);
}

export interface Invite {
  inviteToken: string;
  createdAt: string;
}

export async function createInvite(httpApiUrl: string, roomId: string): Promise<Invite> {
  const res = await fetch(`${httpApiUrl}/auth/rooms/${encodeURIComponent(roomId)}/invites`, {
    method: "POST",
    headers: authHeaders(),
  });
  return parseJsonOrThrow(res);
}

export async function listInvites(httpApiUrl: string, roomId: string): Promise<Invite[]> {
  const res = await fetch(`${httpApiUrl}/auth/rooms/${encodeURIComponent(roomId)}/invites`, {
    headers: authHeaders(),
  });
  const data = await parseJsonOrThrow(res);
  return data.invites;
}

export async function revokeInvite(httpApiUrl: string, roomId: string, inviteToken: string): Promise<void> {
  const res = await fetch(
    `${httpApiUrl}/auth/rooms/${encodeURIComponent(roomId)}/invites/${encodeURIComponent(inviteToken)}`,
    { method: "DELETE", headers: authHeaders() }
  );
  await parseJsonOrThrow(res);
}

// Called after the invitee is already logged in (registering/logging in is
// a separate step handled by the normal login form) -- attaches their
// account to the invite's room as a mod. Returns the roomId so the caller
// can navigate straight there.
export async function redeemInvite(httpApiUrl: string, inviteToken: string): Promise<{ roomId: string }> {
  const res = await fetch(`${httpApiUrl}/auth/invites/${encodeURIComponent(inviteToken)}/redeem`, {
    method: "POST",
    headers: authHeaders(),
  });
  return parseJsonOrThrow(res);
}
