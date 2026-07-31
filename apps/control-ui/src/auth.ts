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

export async function grantRoomAccess(httpApiUrl: string, roomId: string, granteeUsername: string): Promise<void> {
  const token = getStoredToken();
  if (!token) throw new Error("Not logged in");
  const res = await fetch(`${httpApiUrl}/auth/rooms/${encodeURIComponent(roomId)}/grant`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ username: granteeUsername }),
  });
  await parseJsonOrThrow(res);
}
