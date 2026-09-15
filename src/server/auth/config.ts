/**
 * Whether this deployment can actually sign anyone in.
 *
 * `src/env.ts` exposes the two auth secrets as lazy getters, which is
 * deliberate and right: a misconfigured deployment should ship and then say so,
 * rather than fail the build and leave the host serving the last bundle that
 * worked. The gap this file closes is the *saying so*.
 *
 * Nothing read `AUTH_COOKIE_SECRET` until the request that needed it, and the
 * first request that needs it is the first **successful** sign-in — `login`
 * signs the session cookie only after `authenticate` has already verified the
 * password and written the session row. A deployment missing it therefore built,
 * shipped, served `/login`, answered a wrong password with the ordinary "does
 * not match", quietly redirected every protected route (see `src/proxy.ts`,
 * which treats an absent secret as "no valid session"), reported
 * `status: "ok"` on `/api/health` — and threw an opaque 500 with an error
 * digest at the exact moment a correct password arrived. That happened in
 * production on 2026-09-15 and cost a debugging cycle.
 *
 * So this resolver is modelled on `resolveDataSource`, which already solves the
 * same problem for `DATABASE_URL`: it never throws, it returns what is wrong and
 * what to set, and callers decide whether that is fatal or merely reported. It
 * checks **presence and format only, never a value**, so its output is safe in
 * the unauthenticated health response.
 *
 * It reports only constraints the code already enforces. `SESSION_ENCRYPTION_KEY`
 * has a format check because `encryptionKey()` in `src/server/security/crypto.ts`
 * throws on anything that is not 32 bytes of hex. `AUTH_COOKIE_SECRET` is
 * checked for presence alone: `PRODUCTION_ENV.md` recommends 64+ characters, but
 * no code enforces a length, and marking a working deployment misconfigured over
 * a recommendation would make this check the thing operators learn to ignore.
 */

export type AuthConfigProblem = {
  /** The environment variable to set. */
  variable: string;
  /** What is wrong and what to do, readable in a terminal with no repo to hand. */
  problem: string;
};

export type AuthConfigDecision =
  | { ok: true }
  | { ok: false; problems: AuthConfigProblem[] };

function present(name: string): string | null {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : null;
}

/**
 * The auth configuration, or every reason it is unusable.
 *
 * Every problem is reported at once so one redeploy can fix all of them. Never
 * throws.
 */
export function resolveAuthConfig(): AuthConfigDecision {
  const problems: AuthConfigProblem[] = [];

  if (present("AUTH_COOKIE_SECRET") === null) {
    problems.push({
      variable: "AUTH_COOKIE_SECRET",
      problem:
        "AUTH_COOKIE_SECRET is not set, so the session cookie cannot be signed and nobody can sign in. A correct password will be accepted and then fail with a server error. Generate one with: node -e \"console.log(require('crypto').randomBytes(48).toString('base64url'))\"",
    });
  }

  const encryptionKey = present("SESSION_ENCRYPTION_KEY");
  if (encryptionKey === null) {
    problems.push({
      variable: "SESSION_ENCRYPTION_KEY",
      problem:
        "SESSION_ENCRYPTION_KEY is not set, so stored platform sessions cannot be encrypted or read back. Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
    });
  } else if (!/^[0-9a-fA-F]{64}$/.test(encryptionKey)) {
    problems.push({
      variable: "SESSION_ENCRYPTION_KEY",
      problem:
        "SESSION_ENCRYPTION_KEY must be 64 hex characters (32 bytes). The value set is a different length or contains non-hex characters, and AES-256-GCM will refuse it on first use.",
    });
  }

  return problems.length === 0 ? { ok: true } : { ok: false, problems };
}
