import { NextResponse } from "next/server";
import { getCurrentUser } from "@/server/auth/session";
import { prisma } from "@/server/db";
import { exists, readBuffer } from "@/server/storage";

/**
 * Serves stored media.
 *
 * Two protections matter here:
 *  1. A signed-in session is required. Uploaded creative is not public.
 *  2. The requested key must match a row in the database. That means a caller
 *     cannot ask for an arbitrary path even if they defeat the storage layer's
 *     traversal guard — the key has to be one we put there.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ key: string[] }> },
): Promise<NextResponse> {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const { key: segments } = await context.params;
  const key = segments.join("/");

  const known = await isKnownKey(key);
  if (!known) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  if (!(await exists(key))) {
    return NextResponse.json(
      { error: "The file is recorded but missing from storage." },
      { status: 410 },
    );
  }

  const data = await readBuffer(key);
  const body = new Uint8Array(data);

  return new NextResponse(body, {
    headers: {
      "Content-Type": known.mimeType,
      "Content-Length": String(data.byteLength),
      // Media is immutable: the key contains the content hash.
      "Cache-Control": "private, max-age=31536000, immutable",
      "Content-Disposition": `inline; filename="${sanitizeFilename(known.filename)}"`,
      "X-Content-Type-Options": "nosniff",
    },
  });
}

async function isKnownKey(
  key: string,
): Promise<{ mimeType: string; filename: string } | null> {
  const asset = await prisma.contentAsset.findFirst({
    where: { OR: [{ storageKey: key }, { thumbnailKey: key }] },
    select: {
      storageKey: true,
      thumbnailKey: true,
      mimeType: true,
      originalFilename: true,
    },
  });
  if (asset) {
    return asset.storageKey === key
      ? { mimeType: asset.mimeType, filename: asset.originalFilename }
      : { mimeType: "image/jpeg", filename: "thumbnail.jpg" };
  }

  // Publish-failure screenshots are the other legitimate media.
  const attempt = await prisma.publishAttempt.findFirst({
    where: { screenshotKey: key },
    select: { id: true },
  });
  if (attempt) {
    return { mimeType: "image/png", filename: "publish-failure.png" };
  }

  return null;
}

function sanitizeFilename(name: string): string {
  return name.replace(/["\\\r\n]/g, "_");
}

export const runtime = "nodejs";
