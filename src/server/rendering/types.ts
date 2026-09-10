import type { RenderStage } from "@/generated/prisma/enums";

/**
 * The editing boundary.
 *
 * An `EditingProvider` takes a resolved edit decision list and a set of source
 * files on disk, and produces one playable file. It knows nothing about
 * Postgres, queues or briefs — which is what makes a hosted renderer a
 * drop-in replacement later.
 *
 * Everything above this line (the render runner) owns the lifecycle, the
 * idempotency and the record. Everything below it owns pixels.
 */

// ---------------------------------------------------------------------------
// The edit decision list
// ---------------------------------------------------------------------------

/** One cut from one source, placed in output order. */
export type EdlClip = {
  assetId: string;
  /** Source in-point, seconds. */
  sourceStart: number;
  /** Source out-point, seconds. Exclusive. */
  sourceEnd: number;
  /** Burned in for the length of the clip. Null means no text. */
  onScreenText: string | null;
  /** Subtitle line for this clip's span, when a transcript exists. */
  subtitle: string | null;
  /** Drop this clip's own audio, e.g. a beat scored by the music bed. */
  muteAudio: boolean;
};

export type EdlAudio = {
  /** A source asset used as a background bed. */
  assetId: string;
  /** Attenuation applied to the bed, in dB. Negative ducks it under speech. */
  gainDb: number;
};

export type RenderEdl = {
  /** Output geometry. 1080x1920 unless something asks otherwise. */
  width: number;
  height: number;
  fps: number;
  clips: EdlClip[];
  /** Keep the source's own audio. False renders a silent cut. */
  preserveSourceAudio: boolean;
  /** EBU R128 loudness normalisation on the final mix. */
  normalizeAudio: boolean;
  /** Optional music bed mixed under the whole cut. */
  backgroundAudio: EdlAudio | null;
  /** Burn the clips' subtitle lines into the picture. */
  burnSubtitles: boolean;
};

export const VERTICAL_1080x1920 = { width: 1080, height: 1920, fps: 30 } as const;

/** Total output runtime implied by the clips. */
export function edlDurationSeconds(edl: RenderEdl): number {
  return edl.clips.reduce(
    (total, clip) => total + Math.max(0, clip.sourceEnd - clip.sourceStart),
    0,
  );
}

// ---------------------------------------------------------------------------
// Provider surface
// ---------------------------------------------------------------------------

export type RenderSource = {
  assetId: string;
  /** Absolute path on disk. Resolved by the runner, never by the provider. */
  absolutePath: string;
  /** From the stored asset. Null when never probed. */
  durationSeconds: number | null;
  mimeType: string;
  kind: string;
};

export type MediaProbe = {
  /** Container format names as ffprobe reports them, e.g. "mov,mp4,m4a". */
  formatName: string;
  durationSeconds: number | null;
  sizeBytes: number;
  video: {
    codec: string;
    width: number;
    height: number;
    fps: number | null;
  } | null;
  audio: {
    codec: string;
    channels: number;
    sampleRate: number | null;
  } | null;
};

export type RenderProgress = (update: {
  stage: RenderStage;
  /** 0..100. */
  percent: number;
}) => void;

export type RenderRequest = {
  edl: RenderEdl;
  sources: RenderSource[];
  /** Absolute path the provider must write. The runner owns storage. */
  outputPath: string;
  /** Absolute path to a scratch directory the provider may fill. */
  workDir: string;
  onProgress?: RenderProgress;
  signal?: AbortSignal;
};

export type RenderOutcome = {
  outputPath: string;
  probe: MediaProbe;
  /** Sanitised tail of the tool's own output. Never contains absolute paths. */
  log: string;
  /** Wall-clock of the render itself, excluding validation and registration. */
  durationMs: number;
};

export type ProviderAvailability =
  | { available: true; version: string }
  | { available: false; reason: string };

export interface EditingProvider {
  readonly name: string;
  /** LOCAL_FFMPEG today. A hosted renderer would declare its own. */
  readonly kind: string;
  availability(): Promise<ProviderAvailability>;
  /** Whether burned-in text can be produced right now, and if not, why. */
  textSupport(): Promise<{ supported: true } | { supported: false; reason: string }>;
  render(request: RenderRequest): Promise<RenderOutcome>;
  probe(absolutePath: string): Promise<MediaProbe>;
}

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

export type RenderErrorKind =
  /** A referenced source asset row or its file is gone. */
  | "MISSING_ASSET"
  /** A source this renderer cannot cut, e.g. a still image in the MVP. */
  | "UNSUPPORTED_SOURCE"
  /** The file exists but the decoder will not read it. */
  | "CORRUPT_MEDIA"
  /** A clip asks for a range the source does not contain. */
  | "INVALID_TIMING"
  /** ffmpeg or ffprobe is not on PATH. */
  | "FFMPEG_UNAVAILABLE"
  /** Burned-in text was requested and no usable font was found. */
  | "FONT_UNAVAILABLE"
  /** ffmpeg ran and exited non-zero. */
  | "FFMPEG_FAILED"
  /** ffmpeg claimed success but wrote nothing. */
  | "OUTPUT_MISSING"
  /** Something was written, but it is not a playable vertical MP4. */
  | "OUTPUT_INVALID"
  | "TIMEOUT"
  | "CANCELLED"
  | "UNKNOWN";

/**
 * Retryable means "a later attempt might succeed without anyone changing
 * anything". A missing asset or an out-of-range trim will fail identically
 * forever, so retrying only burns a worker slot and hides the real problem.
 */
const RETRYABLE: ReadonlySet<RenderErrorKind> = new Set<RenderErrorKind>([
  "FFMPEG_FAILED",
  "OUTPUT_MISSING",
  "TIMEOUT",
  "UNKNOWN",
]);

export function isRetryableRenderError(kind: RenderErrorKind): boolean {
  return RETRYABLE.has(kind);
}

export class RenderError extends Error {
  readonly kind: RenderErrorKind;
  readonly stage: RenderStage;
  /** Sanitised tool output, when there was any. */
  readonly log: string | null;

  constructor(
    kind: RenderErrorKind,
    stage: RenderStage,
    message: string,
    options: { cause?: unknown; log?: string | null } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "RenderError";
    this.kind = kind;
    this.stage = stage;
    this.log = options.log ?? null;
  }

  get retryable(): boolean {
    return isRetryableRenderError(this.kind);
  }
}
