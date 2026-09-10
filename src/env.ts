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

function flag(name: string, fallback = false): boolean {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") return fallback;
  return value === "1" || value.toLowerCase() === "true";
}

export const env = {
  databaseUrl: required("DATABASE_URL"),
  redisUrl: optional("REDIS_URL", "redis://localhost:56379"),
  sessionEncryptionKey: required("SESSION_ENCRYPTION_KEY"),
  authCookieSecret: required("AUTH_COOKIE_SECRET"),
  storageDir: optional("STORAGE_DIR", "./storage"),
  aiProvider: optional("AI_PROVIDER", "heuristic"),
  enableLivePublishing: flag("ENABLE_LIVE_PUBLISHING", false),
  playwrightHeadless: flag("PLAYWRIGHT_HEADLESS", false),
  operator: {
    email: optional("OPERATOR_EMAIL", "operator@contentos.local"),
    password: process.env["OPERATOR_PASSWORD"] ?? "",
    name: optional("OPERATOR_NAME", "Operator"),
  },
  nodeEnv: optional("NODE_ENV", "development"),
} as const;

export const isProduction = env.nodeEnv === "production";
