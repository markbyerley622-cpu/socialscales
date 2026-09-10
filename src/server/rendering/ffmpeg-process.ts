import { spawn } from "node:child_process";
import path from "node:path";
import { STORAGE_ROOT } from "@/server/storage";
import type { RenderStage } from "@/generated/prisma/enums";
import { RenderError } from "./types";

/**
 * Running ffmpeg, and reporting honestly on what it did.
 *
 * Two things get careful treatment here:
 *
 *  - **Arguments are an array, never a string.** Nothing is passed through a
 *    shell, so a filename containing a quote or a semicolon is a filename and
 *    not a command.
 *  - **Output is sanitised before it is stored.** ffmpeg echoes every path it
 *    touched, and those paths disclose the storage layout and the machine's
 *    directory structure. They are rewritten before anything reaches a row or a
 *    screen.
 */

export const FFMPEG_BIN = process.env["FFMPEG_PATH"] ?? "ffmpeg";
export const FFPROBE_BIN = process.env["FFPROBE_PATH"] ?? "ffprobe";

/** How much of a tool's output is worth keeping. The end is the useful part. */
const LOG_TAIL_CHARS = 4_000;

export type RunResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  /** Sanitised, truncated stderr, ready to store. */
  log: string;
};

export type RunOptions = {
  /** Kills the process and reports TIMEOUT. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Called with each stderr chunk, for progress parsing. */
  onStderr?: (chunk: string) => void;
  /** Working directory for the child. */
  cwd?: string;
};

export async function runTool(
  bin: string,
  args: string[],
  options: RunOptions = {},
): Promise<RunResult> {
  return new Promise<RunResult>((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, {
        // No shell: arguments stay arguments.
        shell: false,
        windowsHide: true,
        ...(options.cwd ? { cwd: options.cwd } : {}),
      });
    } catch (error) {
      reject(unavailable(bin, error));
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, options.timeoutMs)
      : null;

    const onAbort = () => {
      child.kill("SIGKILL");
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      fn();
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderr += text;
      // Unbounded growth is a real risk: a long encode emits a progress line
      // several times a second. Only the tail is ever useful.
      if (stderr.length > LOG_TAIL_CHARS * 8) {
        stderr = stderr.slice(-LOG_TAIL_CHARS * 4);
      }
      options.onStderr?.(text);
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      finish(() => reject(unavailable(bin, error)));
    });

    child.on("close", (code) => {
      finish(() => {
        if (timedOut) {
          reject(
            new RenderError(
              "TIMEOUT",
              "ENCODING",
              `${path.basename(bin)} exceeded its ${options.timeoutMs}ms budget and was killed.`,
              { log: sanitizeLog(stderr) },
            ),
          );
          return;
        }
        if (options.signal?.aborted) {
          reject(
            new RenderError("CANCELLED", "ENCODING", "The render was cancelled.", {
              log: sanitizeLog(stderr),
            }),
          );
          return;
        }
        resolve({ code, stdout, stderr, log: sanitizeLog(stderr) });
      });
    });
  });
}

function unavailable(bin: string, error: unknown): RenderError {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === "ENOENT") {
    return new RenderError(
      "FFMPEG_UNAVAILABLE",
      "VALIDATING",
      `${bin} was not found on PATH. Install FFmpeg, or set FFMPEG_PATH and FFPROBE_PATH to its binaries.`,
      { cause: error },
    );
  }
  return new RenderError(
    "FFMPEG_UNAVAILABLE",
    "VALIDATING",
    `Could not start ${bin}: ${error instanceof Error ? error.message : String(error)}`,
    { cause: error },
  );
}

/**
 * Runs a tool and turns a non-zero exit into a classified failure.
 *
 * The stage is passed in rather than guessed, so a failure says *which* part of
 * the pipeline broke instead of just naming the tool.
 */
export async function runToolOrThrow(
  bin: string,
  args: string[],
  stage: RenderStage,
  options: RunOptions = {},
): Promise<RunResult> {
  const result = await runTool(bin, args, options);
  if (result.code !== 0) {
    throw new RenderError(
      "FFMPEG_FAILED",
      stage,
      `${path.basename(bin)} exited with code ${result.code}. ${firstRealError(result.log)}`,
      { log: result.log },
    );
  }
  return result;
}

/**
 * Rewrites absolute paths out of tool output.
 *
 * ffmpeg names every file it opens. Those names disclose the storage layout and
 * the machine's directory structure, and this text is shown on a screen and
 * stored in a row, so it is rewritten rather than trusted to be uninteresting.
 */
export function sanitizeLog(text: string): string {
  if (!text) return "";
  const replacements: Array<[string, string]> = [
    [STORAGE_ROOT, "<storage>"],
    [process.cwd(), "<app>"],
  ];

  let out = text;
  for (const [from, to] of replacements) {
    if (!from) continue;
    for (const variant of pathVariants(from)) {
      out = out.split(variant).join(to);
    }
  }

  // Anything still looking like an absolute path loses its leading directories.
  out = out.replace(/[A-Za-z]:[\\/][^\s"']*/g, (match) => `<path>/${path.basename(match)}`);
  out = out.replace(/(^|[\s"'(])\/(?:home|Users|var|tmp|opt)\/[^\s"']*/g, (match) => {
    const trimmed = match.trimStart();
    return `${match.slice(0, match.length - trimmed.length)}<path>/${path.basename(trimmed)}`;
  });

  return out.length > LOG_TAIL_CHARS ? `…${out.slice(-LOG_TAIL_CHARS)}` : out;
}

function pathVariants(dir: string): string[] {
  return [...new Set([dir, dir.replace(/\\/g, "/"), dir.replace(/\//g, "\\")])];
}

/** The most useful line of an ffmpeg failure is rarely the last one. */
function firstRealError(log: string): string {
  const lines = log.split(/\r?\n/).filter((line) => line.trim() !== "");
  const interesting = lines.filter((line) =>
    /error|invalid|no such|unable|failed|not found|cannot/i.test(line),
  );
  return (interesting[interesting.length - 1] ?? lines[lines.length - 1] ?? "").trim();
}

/**
 * Escapes a path for use *inside* an ffmpeg filter argument.
 *
 * Filter graphs have their own parser, so a Windows drive letter's colon reads
 * as an option separator and backslashes read as escapes. Forward slashes work
 * on every platform ffmpeg runs on, and the colon needs an explicit escape.
 */
export function escapeFilterPath(absolute: string): string {
  return absolute.replace(/\\/g, "/").replace(/:/g, "\\:");
}

/** ffmpeg reports progress as `out_time_ms=` when asked for machine output. */
export function parseProgressSeconds(chunk: string): number | null {
  const match = /out_time_ms=(\d+)/.exec(chunk);
  if (match?.[1]) return Number.parseInt(match[1], 10) / 1_000_000;
  const timeMatch = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(chunk);
  if (timeMatch) {
    return (
      Number(timeMatch[1]) * 3600 + Number(timeMatch[2]) * 60 + Number(timeMatch[3])
    );
  }
  return null;
}
