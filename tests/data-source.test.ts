import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DataSourceError,
  requireDataSource,
  resolveDataSource,
} from "@/lib/social-scales/data-source";

/**
 * The guarantee: production never serves fixtures by accident.
 *
 * This is a regression test with a specific history. The dashboard shipped
 * standalone with `SOCIAL_SCALES_DATA_MODE=mock` as its documented default, and
 * a deployment carrying that variable served invented clients, invented
 * connection statuses and invented analytics — indistinguishable at a glance
 * from a working system. These tests exist so that cannot happen again.
 */

const KEYS = [
  "NODE_ENV",
  "SOCIAL_SCALES_DATA_MODE",
  "SOCIAL_SCALES_ALLOW_DEMO",
  "DATABASE_URL",
  "NEXT_PUBLIC_SOCIAL_SCALES_API_URL",
] as const;

let saved: Record<string, string | undefined>;

/**
 * `NODE_ENV` is typed read-only, but these tests exist precisely to exercise the
 * production branch, and the resolver reads it at call time rather than at
 * import. A writable view of the environment is the least bad way to do that.
 */
const mutableEnv = process.env as Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
});

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete mutableEnv[key];
    else mutableEnv[key] = saved[key];
  }
});

function env(values: Partial<Record<(typeof KEYS)[number], string | undefined>>) {
  for (const key of KEYS) {
    if (key in values) {
      const value = values[key];
      if (value === undefined) delete mutableEnv[key];
      else mutableEnv[key] = value;
    }
  }
}

describe("production refuses fixtures", () => {
  it("rejects an explicit mock mode in a production build", () => {
    env({
      NODE_ENV: "production",
      SOCIAL_SCALES_DATA_MODE: "mock",
      SOCIAL_SCALES_ALLOW_DEMO: undefined,
      DATABASE_URL: "postgresql://localhost:5432/db",
    });

    const decision = resolveDataSource();
    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.requested).toBe("mock");
    expect(decision.problem).toContain("SOCIAL_SCALES_ALLOW_DEMO");
  });

  it("throws rather than falling back when the source is unusable", () => {
    env({
      NODE_ENV: "production",
      SOCIAL_SCALES_DATA_MODE: "mock",
      SOCIAL_SCALES_ALLOW_DEMO: undefined,
    });
    // The important part is that it throws — a fallback here would be fixtures.
    expect(() => requireDataSource()).toThrow(DataSourceError);
  });

  it("allows fixtures in production only behind the deliberate opt-in", () => {
    env({
      NODE_ENV: "production",
      SOCIAL_SCALES_DATA_MODE: "mock",
      SOCIAL_SCALES_ALLOW_DEMO: "1",
    });

    const decision = resolveDataSource();
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    expect(decision.mode).toBe("mock");
    expect(decision.isDemo).toBe(true);
    // The screen has to be able to say so.
    expect(decision.summary.toLowerCase()).toContain("nothing here is real");
  });

  it("still allows fixtures freely in development", () => {
    env({
      NODE_ENV: "development",
      SOCIAL_SCALES_DATA_MODE: "mock",
      SOCIAL_SCALES_ALLOW_DEMO: undefined,
    });

    const decision = resolveDataSource();
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    expect(decision.mode).toBe("mock");
  });
});

describe("defaulting", () => {
  it("defaults to the real database when nothing is configured", () => {
    env({
      NODE_ENV: "production",
      SOCIAL_SCALES_DATA_MODE: undefined,
      DATABASE_URL: "postgresql://localhost:5432/db",
    });

    const decision = resolveDataSource();
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    expect(decision.mode).toBe("prisma");
    expect(decision.isDemo).toBe(false);
  });

  it("treats an unrecognised mode as the real database, not as fixtures", () => {
    env({
      NODE_ENV: "production",
      SOCIAL_SCALES_DATA_MODE: "banana",
      DATABASE_URL: "postgresql://localhost:5432/db",
    });

    const decision = resolveDataSource();
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    expect(decision.mode).toBe("prisma");
  });
});

describe("misconfiguration fails visibly", () => {
  it("refuses the database mode with no DATABASE_URL", () => {
    env({
      NODE_ENV: "production",
      SOCIAL_SCALES_DATA_MODE: "prisma",
      DATABASE_URL: undefined,
    });

    const decision = resolveDataSource();
    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.problem).toContain("DATABASE_URL");
    // Naming the actual deployment trap is the point of the message.
    expect(decision.problem).toContain("localhost");
  });

  it("refuses the http mode with no backend URL", () => {
    env({
      NODE_ENV: "production",
      SOCIAL_SCALES_DATA_MODE: "http",
      NEXT_PUBLIC_SOCIAL_SCALES_API_URL: undefined,
    });

    const decision = resolveDataSource();
    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.problem).toContain("NEXT_PUBLIC_SOCIAL_SCALES_API_URL");
  });

  it("never reports a demo source as usable real data", () => {
    for (const nodeEnv of ["production", "development"]) {
      env({
        NODE_ENV: nodeEnv,
        SOCIAL_SCALES_DATA_MODE: "mock",
        SOCIAL_SCALES_ALLOW_DEMO: "1",
      });
      const decision = resolveDataSource();
      if (decision.ok) expect(decision.isDemo).toBe(true);
    }
  });
});
