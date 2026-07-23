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

export async function register(httpApiUrl: string, username: string, password: string): Promise<SessionInfo> {
  const res = await fetch(`${httpApiUrl}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const data = await parseJsonOrThrow(res);
  storeToken(data.sessionToken);
  return { username: data.username, personalRoomId: data.personalRoomId };
}

export async function login(httpApiUrl: string, username: string, password: string): Promise<SessionInfo> {
  const res = await fetch(`${httpApiUrl}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const data = await parseJsonOrThrow(res);
  storeToken(data.sessionToken);
  return { username: data.username, personalRoomId: data.personalRoomId };
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
