import "./lib/load-env";

/**
 * Single place where process.env is read. Everything else imports from here so
 * a missing variable fails loudly instead of at 2am inside a job.
 *
 * The three required values are exposed as **getters**, so they throw when they
 * are used rather than when this module is imported. That distinction decides
 * what a misconfigured deployment looks like:
 *
 *   Eager (what this used to do) — `next build` dies while collecting page
 *   data, the deployment never ships, and the host keeps serving the last
 *   build that worked. On this project that meant a stale bundle quietly
 *   serving demo fixtures, which is the worst possible failure: invisible.
 *
 *   Lazy (what it does now) — the build succeeds, the deployment ships, and
 *   the first request that needs a database gets an explicit configuration
 *   error. Loud, attributable, and impossible to mistake for real data.
 */
function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(
      `Missing required environment variable ${name}. Copy .env.example to .env.local and fill it in.`,
    );
  }
  return value;
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() !== "" ? value : fallback;
}

function ratio(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) return fallback;
  return parsed;
}

function count(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function flag(name: string, fallback = false): boolean {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") return fallback;
  return value === "1" || value.toLowerCase() === "true";
}

export const env = {
  get databaseUrl(): string {
    return required("DATABASE_URL");
  },
  redisUrl: optional("REDIS_URL", "redis://localhost:56379"),
  /**
   * Redis key namespace for the job queues. Overridden by the test suite so a
   * Redis-backed test can never consume or delete development jobs.
   */
  queuePrefix: optional("QUEUE_PREFIX", "bull"),
  get sessionEncryptionKey(): string {
    return required("SESSION_ENCRYPTION_KEY");
  },
  get authCookieSecret(): string {
    return required("AUTH_COOKIE_SECRET");
  },
  storageDir: optional("STORAGE_DIR", "./storage"),
  aiProvider: optional("AI_PROVIDER", "heuristic"),
  /**
   * The AI orchestration boundary (src/server/ai/orchestration).
   *
   * `model.provider` is "auto" by default: use the language model when a key is
   * configured, otherwise fall back to rules. The fallback is never silent — the
   * job records which provider served it and the UI says so.
   *
   * The API key is read here and read nowhere else. It is never logged, never
   * serialised into a job record, and never sent to the browser.
   */
  model: {
    provider: optional("AI_MODEL_PROVIDER", "auto"),
    name: optional("AI_MODEL", "claude-opus-5"),
    anthropicApiKey: process.env["ANTHROPIC_API_KEY"] ?? "",
    /** Schema-repair attempts after an invalid generation, per job. */
    maxRepairs: count("AI_MAX_REPAIRS", 2),
    /** Retries for retryable transport failures, per job. */
    maxRetries: count("AI_MAX_RETRIES", 2),
    requestTimeoutMs: count("AI_REQUEST_TIMEOUT_MS", 120_000),
  },
  enableLivePublishing: flag("ENABLE_LIVE_PUBLISHING", false),
  /**
   * Fraction of first attempts the publish simulator fails, 0..1.
   *
   * Non-zero by default so the retry path and the failure UI are reachable in a
   * demo install. The test suite pins it — to 0 where a run must succeed, to 1
   * where the failure path is the thing under test — because a simulator with an
   * uncontrollable failure rate makes every test that uses it flaky.
   */
  simulatedFailureRate: ratio("SIMULATED_FAILURE_RATE", 0.125),
  playwrightHeadless: flag("PLAYWRIGHT_HEADLESS", false),
  operator: {
    email: optional("OPERATOR_EMAIL", "operator@contentos.local"),
    password: process.env["OPERATOR_PASSWORD"] ?? "",
    name: optional("OPERATOR_NAME", "Operator"),
  },
  nodeEnv: optional("NODE_ENV", "development"),
} as const;

export const isProduction = env.nodeEnv === "production";
