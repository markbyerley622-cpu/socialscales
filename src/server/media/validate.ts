import { AssetKind } from "@/generated/prisma/enums";

/**
 * Upload validation. Extension and client-declared MIME type are both attacker
 * controlled, so acceptance is decided by sniffing the file's own magic bytes
 * and cross-checking against a small allowlist.
 */

export const MAX_VIDEO_BYTES = 512 * 1024 * 1024; // 512 MB
export const MAX_IMAGE_BYTES = 32 * 1024 * 1024; // 32 MB

export type MediaType = {
  mimeType: string;
  extension: string;
  kind: AssetKind;
  maxBytes: number;
};

const ALLOWED: MediaType[] = [
  { mimeType: "video/mp4", extension: ".mp4", kind: AssetKind.VIDEO, maxBytes: MAX_VIDEO_BYTES },
  { mimeType: "video/quicktime", extension: ".mov", kind: AssetKind.VIDEO, maxBytes: MAX_VIDEO_BYTES },
  { mimeType: "video/webm", extension: ".webm", kind: AssetKind.VIDEO, maxBytes: MAX_VIDEO_BYTES },
  { mimeType: "image/jpeg", extension: ".jpg", kind: AssetKind.IMAGE, maxBytes: MAX_IMAGE_BYTES },
  { mimeType: "image/png", extension: ".png", kind: AssetKind.IMAGE, maxBytes: MAX_IMAGE_BYTES },
];

export const ACCEPTED_MIME_TYPES = ALLOWED.map((entry) => entry.mimeType);
export const ACCEPTED_EXTENSIONS = ALLOWED.map((entry) => entry.extension);

function byMime(mimeType: string): MediaType | undefined {
  return ALLOWED.find((entry) => entry.mimeType === mimeType);
}

/**
 * Identifies a file from its leading bytes. Needs at least 16 bytes; ISO-BMFF
 * (mp4/mov) detection wants the `ftyp` box which sits at offset 4.
 */
export function sniffMediaType(head: Buffer): MediaType | null {
  if (head.length < 12) return null;

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    head[0] === 0x89 &&
    head[1] === 0x50 &&
    head[2] === 0x4e &&
    head[3] === 0x47 &&
    head[4] === 0x0d &&
    head[5] === 0x0a &&
    head[6] === 0x1a &&
    head[7] === 0x0a
  ) {
    return byMime("image/png") ?? null;
  }

  // JPEG: FF D8 FF
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    return byMime("image/jpeg") ?? null;
  }

  // Matroska/WebM EBML: 1A 45 DF A3
  if (
    head[0] === 0x1a &&
    head[1] === 0x45 &&
    head[2] === 0xdf &&
    head[3] === 0xa3
  ) {
    return byMime("video/webm") ?? null;
  }

  // ISO base media file format: bytes 4..8 are "ftyp".
  if (head.subarray(4, 8).toString("latin1") === "ftyp") {
    const brand = head.subarray(8, 12).toString("latin1");
    if (brand.startsWith("qt")) return byMime("video/quicktime") ?? null;
    return byMime("video/mp4") ?? null;
  }

  return null;
}

export class MediaValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MediaValidationError";
  }
}

/**
 * Validates a completed upload. `declaredMime` is only used to produce a clearer
 * error message; the verdict comes from the sniffed bytes.
 */
export function validateUpload(input: {
  head: Buffer;
  sizeBytes: number;
  declaredMime?: string;
  filename: string;
}): MediaType {
  const sniffed = sniffMediaType(input.head);
  if (!sniffed) {
    throw new MediaValidationError(
      `${input.filename} is not a supported media file. Accepted: MP4, MOV, WebM, JPG, PNG.`,
    );
  }
  if (input.declaredMime && byMime(input.declaredMime) === undefined) {
    throw new MediaValidationError(
      `${input.filename} declared an unsupported content type (${input.declaredMime}).`,
    );
  }
  if (input.sizeBytes <= 0) {
    throw new MediaValidationError(`${input.filename} is empty.`);
  }
  if (input.sizeBytes > sniffed.maxBytes) {
    const limitMb = Math.round(sniffed.maxBytes / (1024 * 1024));
    throw new MediaValidationError(
      `${input.filename} is ${formatMb(input.sizeBytes)}, over the ${limitMb} MB limit for ${sniffed.mimeType}.`,
    );
  }
  return sniffed;
}

function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
