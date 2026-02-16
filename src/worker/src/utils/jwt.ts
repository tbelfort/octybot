/**
 * JWT utilities using Web Crypto API (HS256)
 * Zero dependencies — runs natively on Cloudflare Workers.
 */

const WORDS = [
  "WOLF", "BEAR", "HAWK", "LYNX", "LION", "DEER", "FROG", "DUCK",
  "CRAB", "DOVE", "MOLE", "SEAL", "WREN", "HARE", "NEWT", "TOAD",
  "CROW", "LARK", "MOTH", "WASP", "PIKE", "BASS", "CLAM", "GOAT",
  "BULL", "MARE", "SWAN", "PUMA", "KITE", "IBIS", "ORCA", "YETI",
];

function base64url(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(str: string): Uint8Array {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  const enc = new TextEncoder();
  return crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

export interface JWTPayload {
  sub: string; // device_id
  type: string; // "agent" | "pwa"
  iat: number;
  exp: number;
}

export async function signJWT(
  payload: Omit<JWTPayload, "iat" | "exp">,
  secret: string,
  expiresInDays = 30
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const fullPayload: JWTPayload = {
    ...payload,
    iat: now,
    exp: now + expiresInDays * 86400,
  };

  const enc = new TextEncoder();
  const header = base64url(enc.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const body = base64url(enc.encode(JSON.stringify(fullPayload)));
  const data = `${header}.${body}`;

  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));

  return `${data}.${base64url(sig)}`;
}

export async function verifyJWT(
  token: string,
  secret: string
): Promise<JWTPayload | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const [header, body, sig] = parts;
  const key = await hmacKey(secret);
  const enc = new TextEncoder();

  const sigBytes = base64urlDecode(sig);
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    sigBytes.buffer as ArrayBuffer,
    enc.encode(`${header}.${body}`)
  );

  if (!valid) return null;

  const payload = JSON.parse(
    new TextDecoder().decode(base64urlDecode(body))
  ) as JWTPayload;

  if (payload.exp < Math.floor(Date.now() / 1000)) return null;

  return payload;
}

export function generatePairingCode(): string {
  const word = WORDS[Math.floor(Math.random() * WORDS.length)];
  const num = String(Math.floor(1000 + Math.random() * 9000));
  return `${word}-${num}`;
}
