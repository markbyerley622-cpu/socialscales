/**
 * Which commit this deployment is actually running.
 *
 * Answering that took a 404 probe last time — noticing that `/ops` and `/login`
 * did not exist, and reasoning backwards to "the live bundle predates the
 * merge". A deployment should not need detective work to identify itself.
 *
 * Vercel injects `VERCEL_GIT_COMMIT_SHA` and friends at build time. They are
 * read through `process.env` at module scope on purpose: these are build-time
 * constants, and inlining them is what makes the value survive into a
 * serverless bundle. Nothing here is a secret — a commit SHA and a branch name
 * are already public in the repository.
 */

export type BuildInfo = {
  /** Full commit SHA, or null when built outside a Git-aware host. */
  commit: string | null;
  /** First 7 characters, for reading against `git log --oneline`. */
  commitShort: string | null;
  branch: string | null;
  /** The commit *subject* only — the first line, never the whole body. */
  message: string | null;
  /** "vercel", "local", or whatever else built it. */
  builtOn: string;
  environment: string;
};

function clean(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

/**
 * The subject line of a commit message.
 *
 * A full body can run to a kilobyte of prose, which makes a health response
 * unreadable in a terminal and tells an operator nothing they cannot get from
 * `git show`.
 */
function firstLine(value: string | null): string | null {
  if (value === null) return null;
  const line = value.split(/\r?\n/, 1)[0]?.trim() ?? "";
  return line.length > 0 ? line.slice(0, 120) : null;
}

export function buildInfo(): BuildInfo {
  const commit =
    clean(process.env.VERCEL_GIT_COMMIT_SHA) ??
    // Set these in any other host's build step to get the same guarantee.
    clean(process.env.GIT_COMMIT_SHA) ??
    clean(process.env.SOURCE_COMMIT);

  return {
    commit,
    commitShort: commit ? commit.slice(0, 7) : null,
    branch:
      clean(process.env.VERCEL_GIT_COMMIT_REF) ?? clean(process.env.GIT_BRANCH),
    message: firstLine(clean(process.env.VERCEL_GIT_COMMIT_MESSAGE)),
    builtOn: clean(process.env.VERCEL) ? "vercel" : "local",
    environment: clean(process.env.VERCEL_ENV) ?? process.env.NODE_ENV ?? "unknown",
  };
}
