"use client";

import { useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, CheckCircle2, Loader2, UploadCloud } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { bytes, cn } from "@/lib/utils";

/**
 * Drag-and-drop upload.
 *
 * Posts to /api/upload rather than a server action, because server actions cap
 * request bodies well below a video and give no per-file result. Each file gets
 * its own row so a rejection (wrong type, too big, duplicate) is attributable to
 * the file that caused it.
 */

const ACCEPT = ".mp4,.mov,.webm,.jpg,.jpeg,.png";

type Row = {
  filename: string;
  sizeBytes: number;
  state: "uploading" | "done" | "error";
  message?: string;
};

export function UploadDropzone({
  projectId,
  projectName,
  pillars,
}: {
  projectId: string;
  projectName: string;
  pillars: Array<{ id: string; name: string }>;
}) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  const [pillarId, setPillarId] = useState<string>("");

  const upload = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;

      setBusy(true);
      setRows(
        files.map((file) => ({
          filename: file.name,
          sizeBytes: file.size,
          state: "uploading" as const,
        })),
      );

      const formData = new FormData();
      formData.set("projectId", projectId);
      if (pillarId) formData.set("pillarId", pillarId);
      for (const file of files) formData.append("files", file);

      try {
        const response = await fetch("/api/upload", {
          method: "POST",
          body: formData,
        });
        const payload = (await response.json()) as {
          results?: Array<{ filename: string; ok: boolean; error?: string }>;
          error?: string;
        };

        if (!payload.results) {
          toast.error(payload.error ?? "Upload failed.");
          setRows((current) =>
            current.map((row) => ({
              ...row,
              state: "error",
              message: payload.error ?? "Upload failed.",
            })),
          );
          return;
        }

        setRows(
          payload.results.map((result) => ({
            filename: result.filename,
            sizeBytes: files.find((file) => file.name === result.filename)?.size ?? 0,
            state: result.ok ? "done" : "error",
            message: result.error,
          })),
        );

        const succeeded = payload.results.filter((result) => result.ok).length;
        const failed = payload.results.length - succeeded;

        if (succeeded > 0) {
          toast.success(
            `${succeeded} file${succeeded === 1 ? "" : "s"} uploaded to ${projectName}. AI metadata is being generated.`,
          );
          router.refresh();
        }
        if (failed > 0) {
          toast.error(
            `${failed} file${failed === 1 ? "" : "s"} rejected. See the list for why.`,
            { duration: 8000 },
          );
        }
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "Upload failed unexpectedly.",
        );
        setRows((current) =>
          current.map((row) => ({ ...row, state: "error", message: "Network error." })),
        );
      } finally {
        setBusy(false);
        if (inputRef.current) inputRef.current.value = "";
      }
    },
    [pillarId, projectId, projectName, router],
  );

  return (
    <div>
      {pillars.length > 0 ? (
        <div className="mb-2.5 flex flex-wrap items-center gap-2">
          <label
            htmlFor="upload-pillar"
            className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-ink-muted"
          >
            Content pillar
          </label>
          <select
            id="upload-pillar"
            value={pillarId}
            onChange={(event) => setPillarId(event.target.value)}
            className="h-7 rounded-md border border-hairline-strong bg-surface px-2 text-[11.5px] text-ink"
          >
            <option value="">Unassigned</option>
            {pillars.map((pillar) => (
              <option key={pillar.id} value={pillar.id}>
                {pillar.name}
              </option>
            ))}
          </select>
          <span className="text-[10.5px] text-ink-muted">
            Applied to everything in this upload; it feeds topic detection.
          </span>
        </div>
      ) : null}

      <div
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          void upload(Array.from(event.dataTransfer.files));
        }}
        className={cn(
          "rounded-[10px] border border-dashed px-5 py-7 text-center transition-colors",
          dragging
            ? "border-accent bg-accent/8"
            : "border-hairline-strong bg-surface/60 hover:border-hairline-strong hover:bg-surface",
        )}
      >
        <div className="mx-auto grid size-9 place-items-center rounded-full border border-hairline bg-surface-raised text-ink-muted">
          {busy ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <UploadCloud className="size-4" />
          )}
        </div>
        <p className="mt-2.5 text-[13px] font-medium text-ink">
          Drop video or images here
        </p>
        <p className="mt-1 text-[11.5px] leading-relaxed text-ink-muted">
          MP4, MOV, WebM up to 512 MB · JPG, PNG up to 32 MB · 10 files at a time.
          <br />
          Files are fingerprinted, so the same file cannot enter {projectName} twice.
        </p>

        <input
          ref={inputRef}
          type="file"
          multiple
          accept={ACCEPT}
          className="sr-only"
          onChange={(event) => void upload(Array.from(event.target.files ?? []))}
        />
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="mt-3"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
        >
          Choose files
        </Button>
      </div>

      {rows.length > 0 ? (
        <ul className="mt-2.5 space-y-1">
          {rows.map((row, index) => (
            <li
              key={`${row.filename}-${index}`}
              className="flex items-start gap-2 rounded-md border border-hairline bg-surface px-2.5 py-1.5"
            >
              <span className="mt-px shrink-0">
                {row.state === "uploading" ? (
                  <Loader2 className="size-3.5 animate-spin text-ink-muted" />
                ) : row.state === "done" ? (
                  <CheckCircle2 className="size-3.5 text-good" />
                ) : (
                  <AlertTriangle className="size-3.5 text-critical" />
                )}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[11.5px] text-ink">{row.filename}</p>
                {row.message ? (
                  <p className="mt-0.5 text-[10.5px] leading-relaxed text-[#ec7d7d]">
                    {row.message}
                  </p>
                ) : null}
              </div>
              <span className="shrink-0 text-[10.5px] tabular text-ink-muted">
                {row.sizeBytes > 0 ? bytes(row.sizeBytes) : ""}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
