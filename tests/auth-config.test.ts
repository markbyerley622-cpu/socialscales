import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { env } from "@/env";
import { resolveAuthConfig } from "@/server/auth/config";
import { authenticate } from "@/server/auth/session";
import { PrismaSocialScalesAdapter } from "@/lib/social-scales/prisma-adapter";
import { GET as healthGET } from "@/app/api/health/route";

import { createOperator, migrateTestSchema, resetDatabase } from "./helpers";

/**
 * The guarantee: a deployment that cannot sign anyone in never reports `ok`.
 *
 * This is a regression test with a specific history, 2026-09-15. Production was
 * deployed to Vercel without `AUTH_COOKIE_SECRET`. Every observable signal said
 * the deployment was healthy:
 *
 *   - `next build` succeeded, because `src/env.ts` reads the variable through a
 *     lazy getter on purpose (a misconfigured deploy must ship and then say so,
 *     rather than fail the build and leave a stale bundle serving fixtures).
 *   - `/api/health` returned `status: "ok"`.
 *   - `/login` rendered.
 *   - A *wrong* password returned the ordinary "does not match", because
 *     `authenticate` finishes and returns before any cookie is signed.
 *   - `src/proxy.ts` treats a missing secret as "no valid session" and quietly
 *     redirects to /login, so no protected route complained either.
 *
 * The variable was first read at the one moment nobody was watching for a
 * configuration error: immediately after a *correct* password was accepted, when
 * `login` signs the session cookie. The operator saw an opaque 500 with an error
 * digest on the sign-in they had just spent a day earning.
 *
 * So these tests pin two things. The resolver names every required auth variable
 * that is missing or malformed, by presence and format only and never by value.
 * And `/api/health` — which exists so a deployment can be verified without a
 * browser and without credentials — refuses to call such a deployment `ok`.
 */

const KEYS = ["AUTH_COOKIE_SECRET", "SESSION_ENCRYPTION_KEY"] as const;

/** A valid-shaped key that is not, and must never be, a real one. */
const VALID_HEX_KEY = "0".repeat(64);
const VALID_COOKIE_SECRET = "test-cookie-secret-not-used-in-production";

const mutableEnv = process.env as Record<string, string | undefined>;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
});

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete mutableEnv[key];
    else mutableEnv[key] = saved[key];
  }
});

function set(values: Partial<Record<(typeof KEYS)[number], string | undefined>>): void {
  for (const key of KEYS) {
    if (!(key in values)) continue;
    const value = values[key];
    if (value === undefined) delete mutableEnv[key];
    else mutableEnv[key] = value;
  }
}

function problemFor(variable: string) {
  const decision = resolveAuthConfig();
  if (decision.ok) return null;
  return decision.problems.find((problem) => problem.variable === variable) ?? null;
}

describe("auth configuration is reported, not discovered at sign-in", () => {
  it("accepts a fully configured deployment", () => {
    set({ AUTH_COOKIE_SECRET: VALID_COOKIE_SECRET, SESSION_ENCRYPTION_KEY: VALID_HEX_KEY });
    expect(resolveAuthConfig()).toEqual({ ok: true });
  });

  it("names AUTH_COOKIE_SECRET when it is missing", () => {
    set({ AUTH_COOKIE_SECRET: undefined });
    const problem = problemFor("AUTH_COOKIE_SECRET");
    expect(problem?.problem).toMatch(/not set/i);
    // The message has to be actionable on its own, in a terminal, with no repo.
    expect(problem?.problem).toMatch(/sign in|sign-in|cookie/i);
  });

  it("treats an all-whitespace secret as missing", () => {
    set({ AUTH_COOKIE_SECRET: "   " });
    expect(problemFor("AUTH_COOKIE_SECRET")).not.toBeNull();
  });

  it("names SESSION_ENCRYPTION_KEY when it is missing", () => {
    set({ SESSION_ENCRYPTION_KEY: undefined });
    expect(problemFor("SESSION_ENCRYPTION_KEY")?.problem).toMatch(/not set/i);
  });

  /**
   * Only constraints the code already enforces are reported. `encryptionKey()`
   * in src/server/security/crypto.ts throws on anything that is not 32 bytes of
   * hex, so a 40-character key is a deployment that will fail the first time it
   * seals a browser profile. Reporting it here is surfacing that rule, not
   * inventing a new one — which is also why `AUTH_COOKIE_SECRET`, whose length
   * nothing enforces, is checked for presence only.
   */
  it("rejects a SESSION_ENCRYPTION_KEY that is not 32 bytes of hex", () => {
    set({ SESSION_ENCRYPTION_KEY: "abc123" });
    expect(problemFor("SESSION_ENCRYPTION_KEY")?.problem).toMatch(/64 hex/i);

    set({ SESSION_ENCRYPTION_KEY: "z".repeat(64) });
    expect(problemFor("SESSION_ENCRYPTION_KEY")?.problem).toMatch(/64 hex/i);
  });

  it("accepts uppercase hex", () => {
    set({ AUTH_COOKIE_SECRET: VALID_COOKIE_SECRET, SESSION_ENCRYPTION_KEY: "A".repeat(64) });
    expect(resolveAuthConfig().ok).toBe(true);
  });

  it("reports every problem at once, so one redeploy fixes all of them", () => {
    set({ AUTH_COOKIE_SECRET: undefined, SESSION_ENCRYPTION_KEY: undefined });
    const decision = resolveAuthConfig();
    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.problems.map((problem) => problem.variable).sort()).toEqual([
      "AUTH_COOKIE_SECRET",
      "SESSION_ENCRYPTION_KEY",
    ]);
  });

  it("never discloses a value, only a verdict", () => {
    set({ AUTH_COOKIE_SECRET: "s3cret-do-not-leak", SESSION_ENCRYPTION_KEY: "beef" });
    const serialised = JSON.stringify(resolveAuthConfig());
    expect(serialised).not.toContain("s3cret-do-not-leak");
    expect(serialised).not.toContain("beef");
  });

  it("never throws, whatever the environment looks like", () => {
    set({ AUTH_COOKIE_SECRET: undefined, SESSION_ENCRYPTION_KEY: undefined });
    expect(() => resolveAuthConfig()).not.toThrow();
  });
});

describe("the production failure sequence, pinned", () => {
  beforeAll(async () => {
    await migrateTestSchema();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  /**
   * The crash was never in authentication. The password was verified, the
   * session row was written, and only then did signing the cookie read the
   * missing variable — which is why a wrong password looked fine and a correct
   * one returned a 500.
   */
  it("authenticates successfully while AUTH_COOKIE_SECRET is missing", async () => {
    await createOperator("operator@example.test");
    set({ AUTH_COOKIE_SECRET: undefined });

    const result = await authenticate({
      email: "operator@example.test",
      password: "correct horse battery staple",
    });

    expect(result.ok).toBe(true);
  });

  it("throws only when the cookie is signed, and names the variable", async () => {
    set({ AUTH_COOKIE_SECRET: undefined });
    // `login` reaches this getter immediately after a successful authenticate.
    expect(() => env.authCookieSecret).toThrow(/AUTH_COOKIE_SECRET/);
  });
});

describe("/api/health refuses to call a signed-out deployment healthy", () => {
  beforeAll(async () => {
    await migrateTestSchema();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  it("reports ok when the auth configuration is complete", async () => {
    set({ AUTH_COOKIE_SECRET: VALID_COOKIE_SECRET, SESSION_ENCRYPTION_KEY: VALID_HEX_KEY });

    const response = await healthGET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.auth).toEqual({ usable: true });
  });

  it("reports misconfigured, not ok, when AUTH_COOKIE_SECRET is missing", async () => {
    set({ AUTH_COOKIE_SECRET: undefined });

    const response = await healthGET();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.status).toBe("misconfigured");
    expect(body.auth.usable).toBe(false);
    expect(
      body.auth.problems.map((problem: { variable: string }) => problem.variable),
    ).toContain("AUTH_COOKIE_SECRET");
  });

  /**
   * The counts are the reason this endpoint gets polled. Losing them on a
   * configuration fault would trade one blind spot for another.
   */
  it("still reports the database it can reach", async () => {
    set({ AUTH_COOKIE_SECRET: undefined });

    const body = await (await healthGET()).json();

    expect(body.database).toMatchObject({ reachable: true, projects: 0 });
    expect(body.build).toBeDefined();
  });

  it("does not put a secret in the response", async () => {
    set({ AUTH_COOKIE_SECRET: "s3cret-do-not-leak", SESSION_ENCRYPTION_KEY: VALID_HEX_KEY });

    const raw = JSON.stringify(await (await healthGET()).json());

    expect(raw).not.toContain("s3cret-do-not-leak");
  });
});

describe("the authenticated landing path on an empty database", () => {
  const adapter = new PrismaSocialScalesAdapter();

  beforeAll(async () => {
    await migrateTestSchema();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await resetDatabase();
  });

  /**
   * What `/` does with the result of this decides where a freshly bootstrapped
   * operator lands. With no project it must be onboarding, and it must not
   * throw: a brand-new production database is the *normal* first state, not an
   * edge case.
   */
  it("sends a brand-new workspace to onboarding rather than throwing", async () => {
    const state = await adapter.getOnboardingState();

    expect(state).toMatchObject({
      clientId: null,
      complete: false,
      currentStep: "BUSINESS",
      completedSteps: [],
    });
  });

  it("renders the shell's data with no rows at all", async () => {
    // The three calls (app)/layout.tsx makes on every authenticated route.
    // getWorkspace is excluded here only because it reads the session cookie,
    // which needs a request context; it is null-safe by construction.
    await expect(adapter.getClients()).resolves.toEqual([]);

    const queue = await adapter.getContentQueue({ status: "NEEDS_REVIEW" });
    expect(queue.items).toEqual([]);
  });
});
