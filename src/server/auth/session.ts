import { createHmac } from "node:crypto";
import { cookies } from "next/headers";
import { env, isProduction } from "@/env";
import { prisma } from "@/server/db";
import {
  generateToken,
  hashToken,
  safeEqual,
  verifyPassword,
} from "@/server/security/crypto";
import type { Role } from "@/generated/prisma/enums";

export const SESSION_COOKIE = "contentos_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14; // 14 days

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  role: Role;
};

/**
 * The cookie carries `<token>.<hmac>`. The HMAC lets us discard forged or
 * truncated cookies without touching the database; the token itself is opaque
 * and only its SHA-256 is stored, so the session table is useless to a thief.
 */
function signToken(token: string): string {
  const mac = createHmac("sha256", env.authCookieSecret)
    .update(token)
    .digest("base64url");
  return `${token}.${mac}`;
}

function verifySignedToken(signed: string): string | null {
  const separator = signed.lastIndexOf(".");
  if (separator <= 0) return null;
  const token = signed.slice(0, separator);
  const mac = signed.slice(separator + 1);
  const expected = createHmac("sha256", env.authCookieSecret)
    .update(token)
    .digest("base64url");
  return safeEqual(mac, expected) ? token : null;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export type LoginResult =
  | { ok: true; user: SessionUser }
  | { ok: false; reason: "invalid_credentials" };

export type AuthenticateResult =
  | { ok: true; user: SessionUser; token: string; expiresAt: Date }
  | { ok: false; reason: "invalid_credentials" };

/**
 * Credential check plus session creation, with no dependency on Next's request
 * context. `login` wraps this with the cookie write; tests and any future
 * non-HTTP caller use this directly.
 *
 * The same generic failure is returned whether the email or the password was
 * wrong, and the password check still runs against a dummy hash for unknown
 * addresses so response timing does not disclose which accounts exist.
 */
export async function authenticate(input: {
  email: string;
  password: string;
  userAgent?: string | null;
  ipAddress?: string | null;
}): Promise<AuthenticateResult> {
  const user = await prisma.user.findUnique({
    where: { email: input.email.toLowerCase().trim() },
  });

  const hashToCheck =
    user?.passwordHash ??
    // A real scrypt hash of a random value, so the miss path costs the same.
    "scrypt$32768$8$1$00000000000000000000000000000000$" + "0".repeat(64);

  const passwordOk = await verifyPassword(input.password, hashToCheck);
  if (!user || !passwordOk) {
    return { ok: false, reason: "invalid_credentials" };
  }

  const token = generateToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  await prisma.$transaction([
    prisma.userSession.create({
      data: {
        userId: user.id,
        tokenHash: hashToken(token),
        expiresAt,
        userAgent: input.userAgent ?? null,
        ipAddress: input.ipAddress ?? null,
      },
    }),
    prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    }),
  ]);

  return {
    ok: true,
    user: { id: user.id, email: user.email, name: user.name, role: user.role },
    token,
    expiresAt,
  };
}

/** Authenticates and, on success, sets the session cookie. */
export async function login(input: {
  email: string;
  password: string;
  userAgent?: string | null;
  ipAddress?: string | null;
}): Promise<LoginResult> {
  const result = await authenticate(input);
  if (!result.ok) return result;

  const jar = await cookies();
  jar.set(SESSION_COOKIE, signToken(result.token), {
    httpOnly: true,
    sameSite: "lax",
    secure: isProduction,
    path: "/",
    expires: result.expiresAt,
  });

  return { ok: true, user: result.user };
}

export async function logout(): Promise<void> {
  const jar = await cookies();
  const signed = jar.get(SESSION_COOKIE)?.value;
  if (signed) {
    const token = verifySignedToken(signed);
    if (token) {
      await prisma.userSession.updateMany({
        where: { tokenHash: hashToken(token), revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }
  }
  jar.delete(SESSION_COOKIE);
}

/**
 * Resolves a raw session token to its user, enforcing revocation and expiry.
 * Cookie-free, so it is directly testable.
 */
export async function resolveSession(token: string): Promise<SessionUser | null> {
  const session = await prisma.userSession.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: true },
  });

  if (!session || session.revokedAt || session.expiresAt < new Date()) {
    return null;
  }

  return {
    id: session.user.id,
    email: session.user.email,
    name: session.user.name,
    role: session.user.role,
  };
}

/** Returns the signed-in user, or null. Safe to call from any server context. */
export async function getCurrentUser(): Promise<SessionUser | null> {
  const jar = await cookies();
  const signed = jar.get(SESSION_COOKIE)?.value;
  if (!signed) return null;

  const token = verifySignedToken(signed);
  if (!token) return null;

  return resolveSession(token);
}

export class UnauthorizedError extends Error {
  constructor() {
    super("Not signed in.");
    this.name = "UnauthorizedError";
  }
}

/**
 * Every server action and route handler that touches data calls this. Server
 * actions are reachable by direct POST, so the page-level check is not enough.
 */
export async function requireUser(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) throw new UnauthorizedError();
  return user;
}

/** Housekeeping: drop sessions that are expired or revoked. */
export async function pruneSessions(): Promise<number> {
  const result = await prisma.userSession.deleteMany({
    where: {
      OR: [{ expiresAt: { lt: new Date() } }, { revokedAt: { not: null } }],
    },
  });
  return result.count;
}
