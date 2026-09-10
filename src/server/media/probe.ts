import { AssetKind } from "@/generated/prisma/enums";

/**
 * Container probing in pure JS. Reads real values out of the file rather than
 * inventing them, and returns nulls for anything it cannot determine (WebM
 * duration, for instance) so the UI can say "unknown" honestly instead of
 * showing a made-up number.
 *
 * Supports:
 *   - MP4/MOV: `mvhd` for duration, `tkhd` for display dimensions, `hdlr` for audio
 *   - PNG: IHDR dimensions
 *   - JPEG: SOFn frame dimensions
 */

export type ProbeResult = {
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  aspectRatio: string | null;
  hasAudio: boolean | null;
};

const EMPTY: ProbeResult = {
  durationSeconds: null,
  width: null,
  height: null,
  aspectRatio: null,
  hasAudio: null,
};

export function probeMedia(buffer: Buffer, kind: AssetKind): ProbeResult {
  try {
    if (kind === AssetKind.IMAGE) {
      const dims = probeImage(buffer);
      return dims
        ? { ...EMPTY, ...dims, aspectRatio: ratio(dims.width, dims.height) }
        : EMPTY;
    }
    return probeIsoBmff(buffer);
  } catch {
    // A probe failure must never block an upload.
    return EMPTY;
  }
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

function probeImage(buffer: Buffer): { width: number; height: number } | null {
  // PNG: IHDR is the first chunk, width/height at offsets 16 and 20.
  if (buffer.length > 24 && buffer.subarray(1, 4).toString("latin1") === "PNG") {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }

  // JPEG: walk the marker segments to the first Start Of Frame.
  if (buffer.length > 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buffer[offset + 1];
      // SOF0..SOF3, SOF5..SOF7, SOF9..SOF11, SOF13..SOF15
      const isSof =
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc;
      const segmentLength = buffer.readUInt16BE(offset + 2);
      if (isSof) {
        return {
          height: buffer.readUInt16BE(offset + 5),
          width: buffer.readUInt16BE(offset + 7),
        };
      }
      offset += 2 + segmentLength;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// MP4 / MOV
// ---------------------------------------------------------------------------

type Box = { type: string; start: number; end: number; contentStart: number };

function readBoxes(buffer: Buffer, from: number, to: number): Box[] {
  const boxes: Box[] = [];
  let offset = from;
  while (offset + 8 <= to) {
    let size = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString("latin1");
    let contentStart = offset + 8;
    if (size === 1) {
      // 64-bit extended size.
      if (offset + 16 > to) break;
      const high = buffer.readUInt32BE(offset + 8);
      const low = buffer.readUInt32BE(offset + 12);
      size = high * 2 ** 32 + low;
      contentStart = offset + 16;
    } else if (size === 0) {
      size = to - offset; // Box runs to end of container.
    }
    if (size < 8 || offset + size > to) break;
    boxes.push({ type, start: offset, end: offset + size, contentStart });
    offset += size;
  }
  return boxes;
}

function findBox(boxes: Box[], type: string): Box | undefined {
  return boxes.find((box) => box.type === type);
}

function probeIsoBmff(buffer: Buffer): ProbeResult {
  const top = readBoxes(buffer, 0, buffer.length);
  const moov = findBox(top, "moov");
  if (!moov) return EMPTY;

  const moovChildren = readBoxes(buffer, moov.contentStart, moov.end);

  let durationSeconds: number | null = null;
  const mvhd = findBox(moovChildren, "mvhd");
  if (mvhd) {
    const version = buffer[mvhd.contentStart];
    if (version === 1) {
      const timescale = buffer.readUInt32BE(mvhd.contentStart + 20);
      const high = buffer.readUInt32BE(mvhd.contentStart + 24);
      const low = buffer.readUInt32BE(mvhd.contentStart + 28);
      const duration = high * 2 ** 32 + low;
      if (timescale > 0) durationSeconds = duration / timescale;
    } else {
      const timescale = buffer.readUInt32BE(mvhd.contentStart + 12);
      const duration = buffer.readUInt32BE(mvhd.contentStart + 16);
      if (timescale > 0) durationSeconds = duration / timescale;
    }
  }

  let width: number | null = null;
  let height: number | null = null;
  let hasAudio = false;
  let sawTrack = false;

  for (const trak of moovChildren.filter((box) => box.type === "trak")) {
    sawTrack = true;
    const trakChildren = readBoxes(buffer, trak.contentStart, trak.end);

    const tkhd = findBox(trakChildren, "tkhd");
    if (tkhd) {
      const version = buffer[tkhd.contentStart];
      // Display width/height are the last 8 bytes of the tkhd payload, as 16.16
      // fixed point. Payload is 84 bytes for v0 and 96 for v1 (creation,
      // modification and duration widen from 4 to 8 bytes each), so width sits
      // at 76 / 88 respectively.
      const dimsOffset = tkhd.contentStart + (version === 1 ? 88 : 76);
      if (dimsOffset + 8 <= tkhd.end) {
        const w = buffer.readUInt32BE(dimsOffset) / 65536;
        const h = buffer.readUInt32BE(dimsOffset + 4) / 65536;
        if (w >= 1 && h >= 1 && (width === null || w > width)) {
          width = Math.round(w);
          height = Math.round(h);
        }
      }
    }

    const mdia = findBox(trakChildren, "mdia");
    if (mdia) {
      const hdlr = findBox(
        readBoxes(buffer, mdia.contentStart, mdia.end),
        "hdlr",
      );
      if (hdlr) {
        const handler = buffer
          .subarray(hdlr.contentStart + 8, hdlr.contentStart + 12)
          .toString("latin1");
        if (handler === "soun") hasAudio = true;
      }
    }
  }

  return {
    durationSeconds:
      durationSeconds !== null ? Math.round(durationSeconds * 100) / 100 : null,
    width,
    height,
    aspectRatio: ratio(width, height),
    hasAudio: sawTrack ? hasAudio : null,
  };
}

// ---------------------------------------------------------------------------

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/** Snaps to a familiar label when close, otherwise reduces the real fraction. */
export function ratio(width: number | null, height: number | null): string | null {
  if (!width || !height) return null;
  const value = width / height;
  const known: Array<[string, number]> = [
    ["9:16", 9 / 16],
    ["16:9", 16 / 9],
    ["1:1", 1],
    ["4:5", 4 / 5],
    ["3:4", 3 / 4],
    ["4:3", 4 / 3],
  ];
  for (const [label, target] of known) {
    if (Math.abs(value - target) < 0.02) return label;
  }
  const divisor = gcd(width, height) || 1;
  return `${width / divisor}:${height / divisor}`;
}
