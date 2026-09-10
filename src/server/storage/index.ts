import { createWriteStream } from "node:fs";
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { env } from "@/env";

/**
 * Local filesystem storage. Everything the app persists outside Postgres lives
 * under STORAGE_DIR behind a storage *key* (a relative posix path). Keys are the
 * only thing stored in the database, so swapping in S3 later means implementing
 * this same four-function surface.
 */

// STORAGE_DIR is intentionally configurable, so this path cannot be statically
// scoped to a subfolder. The turbopackIgnore opt-out stops the bundler from
// tracing (and deploying) the whole project because of it.
export const STORAGE_ROOT = path.resolve(
  /* turbopackIgnore: true */ process.cwd(),
  env.storageDir,
);

/** Rejects keys that would escape the storage root. */
function resolveKey(key: string): string {
  const normalised = path.normalize(key).replace(/^([/\\])+/, "");
  const full = path.resolve(STORAGE_ROOT, normalised);
  if (full !== STORAGE_ROOT && !full.startsWith(STORAGE_ROOT + path.sep)) {
    throw new Error(`Refusing storage key outside the storage root: ${key}`);
  }
  return full;
}

async function ensureDirFor(fullPath: string): Promise<void> {
  await mkdir(path.dirname(fullPath), { recursive: true });
}

export async function writeBuffer(key: string, data: Buffer): Promise<string> {
  const full = resolveKey(key);
  await ensureDirFor(full);
  await writeFile(full, data);
  return key;
}

/** Streams a web ReadableStream to disk without buffering the whole file. */
export async function writeStream(
  key: string,
  stream: ReadableStream<Uint8Array>,
): Promise<{ key: string; sizeBytes: number }> {
  const full = resolveKey(key);
  await ensureDirFor(full);
  let sizeBytes = 0;
  const counted = Readable.fromWeb(
    stream as Parameters<typeof Readable.fromWeb>[0],
  );
  counted.on("data", (chunk: Buffer) => {
    sizeBytes += chunk.length;
  });
  await pipeline(counted, createWriteStream(full));
  return { key, sizeBytes };
}

export async function readBuffer(key: string): Promise<Buffer> {
  return readFile(resolveKey(key));
}

export async function exists(key: string): Promise<boolean> {
  try {
    await stat(resolveKey(key));
    return true;
  } catch {
    return false;
  }
}

export async function sizeOf(key: string): Promise<number> {
  const info = await stat(resolveKey(key));
  return info.size;
}

export async function remove(key: string): Promise<void> {
  try {
    await unlink(resolveKey(key));
  } catch {
    // Already gone; deleting storage is idempotent.
  }
}

/** Absolute path, for the few consumers that need one (Playwright uploads). */
export function absolutePath(key: string): string {
  return resolveKey(key);
}

// ---------------------------------------------------------------------------
// Key layout
// ---------------------------------------------------------------------------

export const storageKeys = {
  media(projectId: string, checksum: string, extension: string): string {
    const ext = extension.startsWith(".") ? extension : `.${extension}`;
    return `media/${projectId}/${checksum}${ext}`;
  },
  thumbnail(projectId: string, checksum: string): string {
    return `thumbnails/${projectId}/${checksum}.jpg`;
  },
  attemptScreenshot(jobId: string, attemptNo: number): string {
    return `artifacts/publish/${jobId}/attempt-${attemptNo}.png`;
  },
  connectScreenshot(accountId: string, stamp: string): string {
    return `artifacts/connect/${accountId}/${stamp}.png`;
  },
};
