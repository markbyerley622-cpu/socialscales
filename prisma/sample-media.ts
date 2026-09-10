import { deflateSync } from "node:zlib";

/**
 * Builders for the demo media the seed uploads.
 *
 * These produce *real* files, not stubs: the MP4s carry a valid ISO-BMFF box
 * structure with genuine mvhd/tkhd/hdlr values, so the container probe reads its
 * duration, dimensions and audio flag out of the bytes exactly as it would for a
 * file exported from an editor. The video payload itself is filler — there is no
 * encoder here — which is noted in the seed output.
 */

function box(type: string, ...payloads: Buffer[]): Buffer {
  const body = Buffer.concat(payloads);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(body.length + 8, 0);
  header.write(type, 4, "latin1");
  return Buffer.concat([header, body]);
}

function u32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(Math.max(0, Math.floor(value)), 0);
  return buffer;
}

function u16(value: number): Buffer {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16BE(value, 0);
  return buffer;
}

function fixed1616(value: number): Buffer {
  return u32(Math.round(value * 65536));
}

/** The identity transform, as ISO-BMFF stores it. */
const UNITY_MATRIX = Buffer.concat([
  u32(0x00010000), u32(0), u32(0),
  u32(0), u32(0x00010000), u32(0),
  u32(0), u32(0), u32(0x40000000),
]);

const TIMESCALE = 1000;

function mvhd(durationSeconds: number, trackCount: number): Buffer {
  return box(
    "mvhd",
    Buffer.from([0, 0, 0, 0]), // version 0 + flags
    u32(0), // creation time
    u32(0), // modification time
    u32(TIMESCALE),
    u32(Math.round(durationSeconds * TIMESCALE)),
    u32(0x00010000), // rate 1.0
    u16(0x0100), // volume 1.0
    u16(0), // reserved
    u32(0), u32(0), // reserved
    UNITY_MATRIX,
    Buffer.alloc(24), // pre_defined
    u32(trackCount + 1), // next track id
  );
}

function tkhd(input: {
  trackId: number;
  durationSeconds: number;
  width: number;
  height: number;
}): Buffer {
  return box(
    "tkhd",
    Buffer.from([0, 0, 0, 3]), // version 0, flags: enabled + in movie
    u32(0),
    u32(0),
    u32(input.trackId),
    u32(0), // reserved
    u32(Math.round(input.durationSeconds * TIMESCALE)),
    Buffer.alloc(8), // reserved
    u16(0), // layer
    u16(0), // alternate group
    u16(input.width === 0 ? 0x0100 : 0), // volume: set for audio tracks
    u16(0), // reserved
    UNITY_MATRIX,
    fixed1616(input.width),
    fixed1616(input.height),
  );
}

function mdia(handler: "vide" | "soun", durationSeconds: number): Buffer {
  const mdhd = box(
    "mdhd",
    Buffer.from([0, 0, 0, 0]),
    u32(0),
    u32(0),
    u32(TIMESCALE),
    u32(Math.round(durationSeconds * TIMESCALE)),
    u16(0x55c4), // language: und
    u16(0),
  );
  const hdlr = box(
    "hdlr",
    Buffer.from([0, 0, 0, 0]),
    u32(0), // pre_defined
    Buffer.from(handler, "latin1"),
    Buffer.alloc(12), // reserved
    Buffer.from("CONTENT OS sample\0", "latin1"),
  );
  return box("mdia", mdhd, hdlr);
}

export type SampleVideoSpec = {
  durationSeconds: number;
  width: number;
  height: number;
  hasAudio: boolean;
  /** Filler payload size, so assets have believable and varied byte sizes. */
  payloadBytes?: number;
};

/** Builds a structurally valid MP4 whose header values the probe can read. */
export function buildSampleMp4(spec: SampleVideoSpec): Buffer {
  const tracks: Buffer[] = [
    box(
      "trak",
      tkhd({
        trackId: 1,
        durationSeconds: spec.durationSeconds,
        width: spec.width,
        height: spec.height,
      }),
      mdia("vide", spec.durationSeconds),
    ),
  ];

  if (spec.hasAudio) {
    tracks.push(
      box(
        "trak",
        tkhd({
          trackId: 2,
          durationSeconds: spec.durationSeconds,
          width: 0,
          height: 0,
        }),
        mdia("soun", spec.durationSeconds),
      ),
    );
  }

  const ftyp = box(
    "ftyp",
    Buffer.from("isom", "latin1"),
    u32(0x200),
    Buffer.from("isomiso2avc1mp41", "latin1"),
  );

  const moov = box("moov", mvhd(spec.durationSeconds, tracks.length), ...tracks);

  // Deterministic filler so the same spec always produces the same checksum.
  const size = spec.payloadBytes ?? Math.round(spec.durationSeconds * 180_000);
  const payload = Buffer.alloc(size);
  for (let index = 0; index < size; index += 1) {
    payload[index] = (index * 31 + spec.width + spec.durationSeconds) % 251;
  }
  const mdat = box("mdat", payload);

  return Buffer.concat([ftyp, moov, mdat]);
}

// ---------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuffer = Buffer.from(type, "latin1");
  const body = Buffer.concat([typeBuffer, data]);
  return Buffer.concat([u32(data.length), body, u32(crc32(body))]);
}

/** A real, viewable PNG: a vertical gradient in the given accent colour. */
export function buildSamplePng(input: {
  width: number;
  height: number;
  color: [number, number, number];
}): Buffer {
  const { width, height, color } = input;

  const raw = Buffer.alloc(height * (width * 3 + 1));
  let offset = 0;
  for (let y = 0; y < height; y += 1) {
    raw[offset] = 0; // filter: none
    offset += 1;
    const shade = 0.35 + 0.65 * (1 - y / Math.max(1, height - 1));
    for (let x = 0; x < width; x += 1) {
      const edge = 0.85 + 0.15 * Math.sin((x / width) * Math.PI);
      raw[offset] = Math.min(255, Math.round(color[0] * shade * edge));
      raw[offset + 1] = Math.min(255, Math.round(color[1] * shade * edge));
      raw[offset + 2] = Math.min(255, Math.round(color[2] * shade * edge));
      offset += 3;
    }
  }

  const ihdr = Buffer.concat([
    u32(width),
    u32(height),
    Buffer.from([8, 2, 0, 0, 0]), // 8-bit, truecolour RGB
  ]);

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Parses "#rrggbb" into an RGB triple. */
export function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace("#", "");
  return [
    parseInt(clean.slice(0, 2), 16),
    parseInt(clean.slice(2, 4), 16),
    parseInt(clean.slice(4, 6), 16),
  ];
}
