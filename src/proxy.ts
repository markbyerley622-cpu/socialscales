import { createHmac } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Request gate.
 *
 * This is a cheap first check only: is a cookie present, and is its HMAC ours?
 * That rejects absent and forged cookies without a database round trip. It does
 * NOT prove the session is live — an expired or revoked session still gets past
 * here and is caught by `requireUser()` inside the page or action.
 *
 * That split is deliberate. Proxy runs on every request and should not query
 * Postgres; authorisation belongs next to the data it protects.
 */

const SESSION_COOKIE = "contentos_session";

/** Paths that must work without a session. */
const PUBLIC_PATHS = ["/login", "/api/health"];

function hasWellFormedSession(request: NextRequest): boolean {
  const value = request.cookies.get(SESSION_COOKIE)?.value;
  if (!value) return false;

  const separator = value.lastIndexOf(".");
  if (separator <= 0) return false;

  const secret = process.env.AUTH_COOKIE_SECRET;
  if (!secret) return false;

  const token = value.slice(0, separator);
  const mac = value.slice(separator + 1);
  const expected = createHmac("sha256", secret).update(token).digest("base64url");
  return mac.length === expected.length && mac === expected;
}

export function proxy(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;

  // Public paths always render. Deliberately no "already signed in, bounce to
  // the console" shortcut here: this check cannot tell a live session from a
  // well-formed cookie whose session has expired, been revoked, or vanished with
  // the database. Bouncing on it would send such a request to the console, which
  // would redirect it straight back, and the two would loop forever. The login
  // page does the authoritative check instead.
  if (PUBLIC_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`))) {
    return NextResponse.next();
  }

  if (!hasWellFormedSession(request)) {
    const target = new URL("/login", request.url);
    // Preserve where they were heading so sign-in can return them there.
    if (pathname !== "/") target.searchParams.set("next", pathname);
    return NextResponse.redirect(target);
  }

  return NextResponse.next();
}

export const config = {
  // Everything except Next's own assets and the favicon.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
