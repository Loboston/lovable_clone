import type { JWTPayload } from "./types";

const ALG = "HS256";
const TTL_SEC = 60 * 60 * 24 * 7; // 7 days

function base64UrlEncode(data: ArrayBuffer): string {
  const bytes = new Uint8Array(data);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(str: string): Uint8Array {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  const binary = atob(str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function hashPassword(password: string, salt: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(salt + password);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return base64UrlEncode(hash);
}

export async function verifyPassword(
  password: string,
  storedHash: string,
  salt: string
): Promise<boolean> {
  const hash = await hashPassword(password, salt);
  return hash === storedHash;
}

export function randomId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function createJWT(
  payload: Omit<JWTPayload, "iat" | "exp">,
  secret: string
): Promise<string> {
  const encoder = new TextEncoder();
  const header = { alg: ALG, typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const body: JWTPayload = { ...payload, iat: now, exp: now + TTL_SEC };

  const headerB64 = base64UrlEncode(encoder.encode(JSON.stringify(header)).buffer as ArrayBuffer);
  const bodyB64 = base64UrlEncode(encoder.encode(JSON.stringify(body)).buffer as ArrayBuffer);
  const message = `${headerB64}.${bodyB64}`;

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const msgBytes = encoder.encode(message);
  const sig = await crypto.subtle.sign("HMAC", key, msgBytes);
  const sigB64 = base64UrlEncode(sig as ArrayBuffer);
  return `${message}.${sigB64}`;
}

export async function verifyJWT(
  token: string,
  secret: string
): Promise<JWTPayload | null> {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [headerB64, bodyB64, sigB64] = parts;
    const message = `${headerB64}.${bodyB64}`;
    const encoder = new TextEncoder();

    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"]
    );

    const sig = base64UrlDecode(sigB64);
    const msgBytes = encoder.encode(message);
    const valid = await crypto.subtle.verify("HMAC", key, sig, msgBytes);
    if (!valid) return null;

    const bodyJson = atob(bodyB64.replace(/-/g, "+").replace(/_/g, "/"));
    const body = JSON.parse(bodyJson) as JWTPayload;
    const now = Math.floor(Date.now() / 1000);
    if (body.exp != null && body.exp < now) return null;
    if (body.sub && body.email) return body;
    return null;
  } catch {
    return null;
  }
}

export function getBearerToken(request: Request): string | null {
  const auth = request.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) return null;
  return auth.slice(7).trim();
}
