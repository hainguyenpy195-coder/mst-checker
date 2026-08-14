export const APP_SESSION_COOKIE = "mst_checker_session";
const SESSION_TTL_SECONDS = 8 * 60 * 60;

export type AppRole = "admin" | "readonly";

type SessionPayload = {
  username: string;
  issuedAt: number;
  expiresAt: number;
};

export type AuthenticatedSession = SessionPayload & {
  role: AppRole;
};

type ConfiguredAccount = {
  username: string;
  password: string;
  role: AppRole;
};

function toBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function fromBase64Url(value: string) {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((value.length + 3) % 4);
  const binary = atob(base64);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function encodeText(value: string) {
  return toBase64Url(new TextEncoder().encode(value));
}

function decodeText(value: string) {
  return new TextDecoder().decode(fromBase64Url(value));
}

function getSessionSecret() {
  return process.env.APP_SESSION_SECRET ?? "";
}

function getConfiguredAccounts(): ConfiguredAccount[] {
  return [
    {
      username: process.env.APP_LOGIN_USERNAME ?? "",
      password: process.env.APP_LOGIN_PASSWORD ?? "",
      role: "admin" as const,
    },
    {
      username: process.env.APP_READONLY_USERNAME ?? "",
      password: process.env.APP_READONLY_PASSWORD ?? "",
      role: "readonly" as const,
    },
  ].filter((account) => Boolean(account.username && account.password));
}

function findConfiguredAccount(username: string) {
  return getConfiguredAccounts().find((account) => account.username === username) ?? null;
}

export function getConfiguredLogin() {
  return {
    username: process.env.APP_LOGIN_USERNAME ?? "",
    password: process.env.APP_LOGIN_PASSWORD ?? "",
  };
}

export function isValidLogin(username: string, password: string) {
  return getConfiguredAccounts().some((account) => account.username === username && account.password === password);
}

export function isAdminSession(session: AuthenticatedSession | null | undefined) {
  return session?.role === "admin";
}

export const READ_ONLY_FORBIDDEN_MESSAGE = "Tài khoản readonly chỉ được xem và tra cứu dữ liệu.";

async function importSigningKey() {
  const secret = getSessionSecret();
  if (!secret) throw new Error("APP_SESSION_SECRET is not configured");
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function createSessionToken(username: string) {
  const issuedAt = Date.now();
  const payload: SessionPayload = {
    username,
    issuedAt,
    expiresAt: issuedAt + SESSION_TTL_SECONDS * 1000,
  };
  const encodedPayload = encodeText(JSON.stringify(payload));
  const key = await importSigningKey();
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(encodedPayload));
  return `${encodedPayload}.${toBase64Url(new Uint8Array(signature))}`;
}

export async function verifySessionToken(token: string | undefined): Promise<AuthenticatedSession | null> {
  if (!token) return null;
  const [encodedPayload, encodedSignature] = token.split(".");
  if (!encodedPayload || !encodedSignature) return null;

  try {
    const key = await importSigningKey();
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      fromBase64Url(encodedSignature),
      new TextEncoder().encode(encodedPayload),
    );
    if (!valid) return null;

    const payload = JSON.parse(decodeText(encodedPayload)) as SessionPayload;
    if (!payload.username || !payload.expiresAt || payload.expiresAt <= Date.now()) return null;
    const account = findConfiguredAccount(payload.username);
    if (!account) return null;
    return { ...payload, role: account.role };
  } catch {
    return null;
  }
}

export function getCookieValue(cookieHeader: string | null, cookieName: string) {
  if (!cookieHeader) return undefined;
  const prefix = `${cookieName}=`;
  const cookie = cookieHeader.split(";").map((part) => part.trim()).find((part) => part.startsWith(prefix));
  return cookie ? decodeURIComponent(cookie.slice(prefix.length)) : undefined;
}

export async function authenticateRequest(request: Request) {
  return verifySessionToken(getCookieValue(request.headers.get("cookie"), APP_SESSION_COOKIE));
}

export const sessionCookieOptions = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: SESSION_TTL_SECONDS,
};
