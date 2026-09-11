# Media storage

Every file this system writes, whether it has to survive, and who has to be able
to read it.

---

## The current model

`src/server/storage/index.ts` — one local-filesystem module behind a six-function
surface:

```
writeBuffer(key, data)   readBuffer(key)   exists(key)
writeStream(key, stream) sizeOf(key)       remove(key)
absolutePath(key)        STORAGE_ROOT      storageKeys.*
```

A **key** is a relative POSIX path (`renders/<projectId>/<hash>.mp4`). Keys are
the only thing stored in the database; no absolute path is ever persisted. That
is the property that makes the backend swappable — and it already holds.

`resolveKey()` refuses any key that escapes `STORAGE_ROOT`, so a crafted
filename cannot traverse out.

---

## Classification

| Class | Files | Must survive? | Shared between processes? | Where it can live |
|---|---|---|---|---|
| **TEMPORARY** | Per-clip intermediates, `concat.txt`, `subtitles.srt`, `text-NNN.txt` | No | No | `os.tmpdir()` on the worker. Already correct — `mkdtemp` per job, `rm -rf` in a `finally`. |
| **DURABLE** | Uploaded source assets (`media/…`), rendered cuts (`renders/…`) | **Yes** | **Yes** — the worker writes, the web app serves | Object storage |
| **DURABLE** | Publish screenshots (`artifacts/publish/…`), connect screenshots (`artifacts/connect/…`) | Yes — they are publication evidence | Yes | Object storage |
| **SHARED, not media** | Playwright browser profiles (`storage/browser-profiles/…`) | Yes | **No** — worker only, and must never be shared | Worker-local persistent volume |

That last row matters. A browser profile is a live session directory; two
processes opening one concurrently corrupts it. It needs a persistent disk on
the worker, **not** object storage.

---

## Why local disk is not enough in production

| Fact | Consequence |
|---|---|
| Vercel's filesystem is ephemeral and per-instance | An upload written by one request is gone from the next |
| The worker is a different machine | A cut it renders is not visible to Vercel, so `/api/media/<key>` 404s |
| `/api/media/[...key]` reads from `STORAGE_DIR` | Serving rendered video from Vercel requires shared storage |

Today the chain works because one laptop is both processes. Split them and
`media/…` and `renders/…` break; `artifacts/…` become unreachable evidence.

---

## What exists, and what is missing

The repository has **no object-storage adapter**. No S3, R2 or Supabase client
is present in `package.json`, and nothing imports one. The storage module is
local-filesystem only.

What *does* exist is the right seam: every consumer goes through those six
functions and stores keys, never paths.

| Consumer | Uses |
|---|---|
| `content-service` (upload) | `writeStream`, `storageKeys.media` |
| `render-runner` | `absolutePath`, deterministic `renders/…` key |
| `publish-runner` | `writeBuffer` for screenshots |
| `automation/browser` | `absolutePath` for the profile directory |
| `api/media/[...key]` | `exists`, `readBuffer` |

---

## The minimum change

Not a rewrite. Two things:

**1. Make the surface async-and-remote-capable.** It already is — every function
except `absolutePath` returns a promise.

**2. `absolutePath()` is the one leak.** It hands out a filesystem path, and
object storage has none. Three callers:

| Caller | Needs | Fix |
|---|---|---|
| `render-runner` (output) | A path to write, then move | Render to the worker's temp dir, then `writeStream` the finished file to storage. The move becomes an upload. |
| `render-runner` / `edl` (sources) | A path FFmpeg can read | Download to temp first, or use a presigned URL — FFmpeg reads `https://` inputs natively. |
| `automation/browser` | The profile directory | **Stays local.** Worker-only, never shared. |

So the adapter interface is the existing surface plus one addition:

```ts
interface MediaStore {
  writeBuffer(key: string, data: Buffer): Promise<string>;
  writeStream(key: string, stream: ReadableStream<Uint8Array>): Promise<{ key: string; sizeBytes: number }>;
  readBuffer(key: string): Promise<Buffer>;
  exists(key: string): Promise<boolean>;
  sizeOf(key: string): Promise<number>;
  remove(key: string): Promise<void>;

  /** A path FFmpeg or Playwright can open. Downloads first when remote. */
  localPath(key: string): Promise<{ path: string; cleanup: () => Promise<void> }>;
}
```

`localPath` replaces `absolutePath` and is honest about the cost: on local disk
it returns the path and a no-op cleanup; on object storage it downloads to temp
and the cleanup deletes it.

---

## Choosing a provider

| | Cloudflare R2 | AWS S3 | Supabase Storage |
|---|---|---|---|
| Egress fees | **None** | Per GB | Included in tier |
| S3-compatible API | ✅ | ✅ | ✅ |
| Free tier | 10 GB + 1M writes/mo | 12 months only | 1 GB |
| Presigned URLs (FFmpeg can read) | ✅ | ✅ | ✅ |

**Recommendation: Cloudflare R2.** Video is the workload, and egress is where
video costs money. R2 charges none, speaks the S3 API (so `@aws-sdk/client-s3`
works unchanged if you ever move), and its free tier covers this system's
current volume several times over.

**No storage account has been created and no paid resource provisioned.**

---

## Order of work

This is not blocking today. Sequence it after the database and the worker:

1. **Now** — one machine runs both processes. Local storage is correct.
2. **When the worker moves to its own host** — implement `MediaStore` with an R2
   backend, swap `absolutePath` for `localPath` at the three call sites, keep
   local as the default so development is unchanged.
3. **Never** — do not put browser profiles in object storage.

Until step 2, a split deployment will serve 404s from `/api/media/…` for
anything the worker produced. That is a real limitation, stated rather than
discovered later.
