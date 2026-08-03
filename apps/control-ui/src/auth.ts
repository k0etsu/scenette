const SESSION_TOKEN_KEY = "scenette.sessionToken";

export interface SessionInfo {
  username: string;
  // Undefined until the account verifies an email -- an account only owns a
  // room once verified. Mods on someone else's room never get one.
  personalRoomId?: string;
  email?: string;
  emailVerified: boolean;
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

// email is optional -- there's no verification step to gate on, it's kept
// purely as an optional contact field a user can set later via
// changeEmail().
export async function register(
  httpApiUrl: string,
  username: string,
  email: string | undefined,
  password: string
): Promise<SessionInfo> {
  const res = await fetch(`${httpApiUrl}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, email, password }),
  });
  const data = await parseJsonOrThrow(res);
  storeToken(data.sessionToken);
  return {
    username: data.username,
    personalRoomId: data.personalRoomId,
    email: data.email,
    emailVerified: data.emailVerified ?? false,
  };
}

export async function login(httpApiUrl: string, username: string, password: string): Promise<SessionInfo> {
  const res = await fetch(`${httpApiUrl}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const data = await parseJsonOrThrow(res);
  storeToken(data.sessionToken);
  return {
    username: data.username,
    personalRoomId: data.personalRoomId,
    email: data.email,
    emailVerified: data.emailVerified ?? false,
  };
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
  return {
    username: data.username,
    personalRoomId: data.personalRoomId,
    email: data.email,
    emailVerified: data.emailVerified ?? false,
  };
}

// Re-sends the verification email for the account's current pending email
// (responds 200 regardless, to avoid leaking account state).
export async function resendVerification(httpApiUrl: string): Promise<void> {
  const res = await fetch(`${httpApiUrl}/auth/resend-verification`, {
    method: "POST",
    headers: authHeaders(),
  });
  await parseJsonOrThrow(res);
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

export async function changePassword(httpApiUrl: string, currentPassword: string, newPassword: string): Promise<void> {
  const res = await fetch(`${httpApiUrl}/auth/change-password`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ currentPassword, newPassword }),
  });
  await parseJsonOrThrow(res);
}

// Empty string clears the account's stored email.
export async function changeEmail(httpApiUrl: string, email: string): Promise<void> {
  const res = await fetch(`${httpApiUrl}/auth/change-email`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  await parseJsonOrThrow(res);
}

// Irreversible -- wipes every room the account owns (assets, S3 objects,
// memberships, invites), its own membership on any room it's only a mod on
// elsewhere, every session, and the account itself. Clears the local token
// afterward, same as logout().
export async function deleteAccount(httpApiUrl: string, password: string): Promise<void> {
  const res = await fetch(`${httpApiUrl}/auth/account`, {
    method: "DELETE",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  await parseJsonOrThrow(res);
  clearStoredToken();
}
