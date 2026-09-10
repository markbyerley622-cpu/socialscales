import "./lib/load-env";

/**
 * Single place where process.env is read. Everything else imports from here so
 * a missing variable fails loudly at boot instead of at 2am inside a job.
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

function flag(name: string, fallback = false): boolean {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") return fallback;
  return value === "1" || value.toLowerCase() === "true";
}

export const env = {
  databaseUrl: required("DATABASE_URL"),
  redisUrl: optional("REDIS_URL", "redis://localhost:56379"),
  /**
   * Redis key namespace for the job queues. Overridden by the test suite so a
   * Redis-backed test can never consume or delete development jobs.
   */
  queuePrefix: optional("QUEUE_PREFIX", "bull"),
  sessionEncryptionKey: required("SESSION_ENCRYPTION_KEY"),
  authCookieSecret: required("AUTH_COOKIE_SECRET"),
  storageDir: optional("STORAGE_DIR", "./storage"),
  aiProvider: optional("AI_PROVIDER", "heuristic"),
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
