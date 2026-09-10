import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser, UnauthorizedError } from "@/server/auth/session";
import {
  createAsset,
  DuplicateAssetError,
} from "@/server/services/content-service";
import { MediaValidationError } from "@/server/media/validate";
import { queueJobId, queues } from "@/server/jobs/queues";
import { analyzeAsset } from "@/server/services/content-service";
import { prisma } from "@/server/db";

/**
 * Multipart upload endpoint.
 *
 * A route handler rather than a server action, because server actions cap
 * payloads well below a video file and give no per-file progress. Each file is
 * validated, hashed, stored and recorded independently, so one bad file in a
 * drag-and-drop of ten does not lose the other nine.
 *
 * Analysis is queued rather than awaited. If Redis is unreachable it falls back
 * to running inline, so a single-process setup still works.
 */

const MAX_FILES_PER_REQUEST = 10;

const bodySchema = z.object({
  projectId: z.string().min(1),
  pillarId: z.string().min(1).nullable().optional(),
});

export type UploadOutcome = {
  filename: string;
  ok: boolean;
  assetId?: string;
  error?: string;
};

export async function POST(request: Request): Promise<NextResponse> {
  let user;
  try {
    user = await requireUser();
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ error: "Not signed in." }, { status: 401 });
    }
    throw error;
  }

  const formData = await request.formData();

  const parsed = bodySchema.safeParse({
    projectId: formData.get("projectId"),
    pillarId: formData.get("pillarId") || null,
  });
  if (!parsed.success) {
    return NextResponse.json(
      { error: "A projectId is required." },
      { status: 400 },
    );
  }

  // Authorisation: the project must exist. (Single-tenant today; this is the
  // hook where per-user project membership would be enforced.)
  const project = await prisma.project.findUnique({
    where: { id: parsed.data.projectId },
    select: { id: true },
  });
  if (!project) {
    return NextResponse.json({ error: "Unknown project." }, { status: 404 });
  }

  const files = formData.getAll("files").filter((entry): entry is File => entry instanceof File);

  if (files.length === 0) {
    return NextResponse.json({ error: "No files were sent." }, { status: 400 });
  }
  if (files.length > MAX_FILES_PER_REQUEST) {
    return NextResponse.json(
      { error: `Upload at most ${MAX_FILES_PER_REQUEST} files at a time.` },
      { status: 400 },
    );
  }

  const results: UploadOutcome[] = [];

  for (const file of files) {
    try {
      const data = Buffer.from(await file.arrayBuffer());
      const { asset } = await createAsset({
        projectId: parsed.data.projectId,
        uploaderId: user.id,
        filename: file.name,
        declaredMime: file.type || undefined,
        data,
        pillarId: parsed.data.pillarId ?? null,
      });

      await scheduleAnalysis(asset.id, user.id);
      results.push({ filename: file.name, ok: true, assetId: asset.id });
    } catch (error) {
      results.push({
        filename: file.name,
        ok: false,
        error: describeUploadError(error),
      });
    }
  }

  const anyOk = results.some((result) => result.ok);
  return NextResponse.json({ results }, { status: anyOk ? 201 : 422 });
}

async function scheduleAnalysis(assetId: string, userId: string): Promise<void> {
  try {
    await queues.contentAnalysis().add(
      "analyze",
      { assetId, userId },
      { jobId: queueJobId("analyze", assetId) },
    );
  } catch {
    // No Redis: analyse inline so the upload still produces suggestions.
    try {
      await analyzeAsset({ assetId, userId });
    } catch (error) {
      console.error("[upload] inline analysis failed", error);
    }
  }
}

function describeUploadError(error: unknown): string {
  if (error instanceof MediaValidationError) return error.message;
  if (error instanceof DuplicateAssetError) return error.message;
  console.error("[upload] failed", error);
  return "Upload failed. Check the server log for details.";
}
