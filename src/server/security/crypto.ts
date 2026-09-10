import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";
import { env } from "@/env";

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

// ---------------------------------------------------------------------------
// Password hashing
// ---------------------------------------------------------------------------

// scrypt from node:crypto rather than argon2/bcrypt: equally sound for this
// threat model and it needs no native build step on Windows.
// N=2^15 needs 128*N*r = 32 MiB, which is exactly Node's default maxmem ceiling,
// so maxmem is raised explicitly rather than softening the work factor.
const SCRYPT = {
  N: 2 ** 15,
  r: 8,
  p: 1,
  keyLength: 32,
  maxmem: 64 * 1024 * 1024,
} as const;

/** Produces `scrypt$N$r$p$saltHex$hashHex`. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, SCRYPT.keyLength, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: SCRYPT.maxmem,
  });
  return [
    "scrypt",
    SCRYPT.N,
    SCRYPT.r,
    SCRYPT.p,
    salt.toString("hex"),
    derived.toString("hex"),
  ].join("$");
}

export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, nRaw, rRaw, pRaw, saltHex, hashHex] = parts;
  const N = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) {
    return false;
  }
  const expected = Buffer.from(hashHex, "hex");
  const derived = await scrypt(password, Buffer.from(saltHex, "hex"), expected.length, {
    N,
    r,
    p,
    // Allow for a stored hash that used a larger work factor than today's default.
    maxmem: Math.max(SCRYPT.maxmem, 256 * N * r),
  });
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

// ---------------------------------------------------------------------------
// Opaque tokens
// ---------------------------------------------------------------------------

/** A URL-safe random token. Only its hash is ever persisted. */
export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function sha256Hex(input: Buffer | string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Constant-time string compare that tolerates length mismatch. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

// ---------------------------------------------------------------------------
// Authenticated encryption for stored platform sessions
// ---------------------------------------------------------------------------

export type SealedPayload = {
  cipherText: string;
  iv: string;
  authTag: string;
  algorithm: "aes-256-gcm";
};

function encryptionKey(): Buffer {
  const key = Buffer.from(env.sessionEncryptionKey, "hex");
  if (key.length !== 32) {
    throw new Error(
      "SESSION_ENCRYPTION_KEY must be 32 bytes encoded as 64 hex characters. " +
        'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    );
  }
  return key;
}

/** AES-256-GCM seal. Used for Playwright storageState blobs. */
export function seal(plaintext: string): SealedPayload {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const cipherText = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return {
    cipherText: cipherText.toString("base64"),
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    algorithm: "aes-256-gcm",
  };
}

export function unseal(payload: {
  cipherText: string;
  iv: string;
  authTag: string;
}): string {
  const decipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey(),
    Buffer.from(payload.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(payload.authTag, "base64"));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(payload.cipherText, "base64")),
    decipher.final(),
  ]);
  return plain.toString("utf8");
}

export function sealJson(value: unknown): SealedPayload {
  return seal(JSON.stringify(value));
}

export function unsealJson<T>(payload: {
  cipherText: string;
  iv: string;
  authTag: string;
}): T {
  return JSON.parse(unseal(payload)) as T;
}
