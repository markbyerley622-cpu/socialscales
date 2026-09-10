/**
 * Which data source the dashboard reads, and whether it is allowed to.
 *
 * The rule this file exists to enforce: **production never shows fixtures.**
 *
 * The failure it is guarding against is specific and was real. The dashboard
 * shipped standalone with `SOCIAL_SCALES_DATA_MODE=mock` as its documented
 * default, so a deployment that inherited that variable — or simply never set
 * it — served invented clients, invented connection statuses and invented
 * analytics, indistinguishable at a glance from an operating system. Fake
 * operational data is worse than an error page, because an error page cannot be
 * acted on by mistake.
 *
 * So: `prisma` is the default, `mock` requires a deliberate opt-in outside
 * development, and a misconfigured source refuses to resolve rather than
 * quietly falling back to something that looks like it works.
 */

export type DataMode = "prisma" | "http" | "mock";

export type DataSourceDecision =
  | {
      ok: true;
      mode: DataMode;
      /** True only for fixtures. Drives the UI's demo badge. */
      isDemo: boolean;
      /** One line an operator can read on the settings screen. */
      summary: string;
    }
  | {
      ok: false;
      /** What was asked for, so the message can name it. */
      requested: DataMode;
      /** What is wrong, and what to set. */
      problem: string;
    };

/** Thrown rather than returning fixtures. Surfaces through the error boundary. */
export class DataSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DataSourceError";
  }
}

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

/** The deliberate opt-in that makes fixtures legal outside development. */
function demoAllowed(): boolean {
  const raw = process.env.SOCIAL_SCALES_ALLOW_DEMO?.toLowerCase();
  return raw === "1" || raw === "true";
}

function requested(): DataMode {
  const raw = process.env.SOCIAL_SCALES_DATA_MODE?.toLowerCase();
  if (raw === "mock") return "mock";
  if (raw === "http") return "http";
  if (raw === "prisma") return "prisma";
  // Unset means the real thing. A dashboard that lives inside its own backend
  // has no reason to default to anything else.
  return "prisma";
}

/**
 * Resolves the data source, or explains why it cannot.
 *
 * Never throws — callers decide whether a bad decision is fatal here or merely
 * reported, which is what lets the settings screen and the health endpoint
 * describe a broken configuration instead of crashing with it.
 */
export function resolveDataSource(): DataSourceDecision {
  const mode = requested();

  if (mode === "mock") {
    // The whole point of this file.
    if (isProduction() && !demoAllowed()) {
      return {
        ok: false,
        requested: "mock",
        problem:
          "SOCIAL_SCALES_DATA_MODE=mock is set in a production build. Fixtures are refused here because they are indistinguishable from real operational data. Remove the variable to use the database, or set SOCIAL_SCALES_ALLOW_DEMO=1 if this deployment is deliberately a demo.",
      };
    }
    return {
      ok: true,
      mode: "mock",
      isDemo: true,
      summary: isProduction()
        ? "Development fixtures, explicitly enabled for this deployment via SOCIAL_SCALES_ALLOW_DEMO. Nothing here is real."
        : "Development fixtures. Nothing here is real.",
    };
  }

  if (mode === "http") {
    const baseUrl = process.env.NEXT_PUBLIC_SOCIAL_SCALES_API_URL?.trim();
    if (!baseUrl) {
      return {
        ok: false,
        requested: "http",
        problem:
          "SOCIAL_SCALES_DATA_MODE=http but NEXT_PUBLIC_SOCIAL_SCALES_API_URL is not set, so there is no backend to read from.",
      };
    }
    return {
      ok: true,
      mode: "http",
      isDemo: false,
      summary: `A separate Social Scales backend at ${baseUrl}.`,
    };
  }

  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    return {
      ok: false,
      requested: "prisma",
      problem:
        "DATABASE_URL is not set, so this deployment has no database to read. Set it to a Postgres this app can reach — Vercel cannot reach a database on localhost.",
    };
  }

  return {
    ok: true,
    mode: "prisma",
    isDemo: false,
    summary: "This application's own Postgres database, read in process.",
  };
}

/**
 * The resolved mode, or a thrown error.
 *
 * Used by `getAdapter()`. The throw is deliberate: there is no fallback path,
 * because every fallback worth having would show something invented.
 */
export function requireDataSource(): Extract<DataSourceDecision, { ok: true }> {
  const decision = resolveDataSource();
  if (!decision.ok) throw new DataSourceError(decision.problem);
  return decision;
}
