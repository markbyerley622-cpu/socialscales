import { access, constants, writeFile } from "node:fs/promises";
import { stat } from "node:fs/promises";
import path from "node:path";
import { RenderStage } from "@/generated/prisma/enums";
import {
  escapeFilterPath,
  FFMPEG_BIN,
  FFPROBE_BIN,
  parseProgressSeconds,
  runTool,
  runToolOrThrow,
  sanitizeLog,
} from "./ffmpeg-process";
import {
  RenderError,
  edlDurationSeconds,
  type EdlClip,
  type EditingProvider,
  type MediaProbe,
  type ProviderAvailability,
  type RenderEdl,
  type RenderOutcome,
  type RenderRequest,
  type RenderSource,
} from "./types";

/**
 * The local FFmpeg editing provider.
 *
 * Renders in two stages rather than one enormous filter graph:
 *
 *   1. Each clip is trimmed, fitted to the output frame and given its burned-in
 *      text, producing a normalised intermediate.
 *   2. The intermediates are concatenated, the audio is normalised or mixed, and
 *      the result is encoded once.
 *
 * A single graph would be marginally faster and considerably harder to debug: a
 * failure in stage one names the clip that broke, and the intermediates are on
 * disk to look at. Given the failure modes this has to report precisely, that
 * trade is worth making.
 *
 * Every clip is forced to the same geometry, frame rate, sample rate and channel
 * layout in stage one, which is what makes the concat demuxer safe in stage two.
 * Sources with no audio get generated silence, so the track count never varies
 * mid-timeline.
 */

const CLIP_TIMEOUT_MS = 10 * 60 * 1000;
const ASSEMBLE_TIMEOUT_MS = 30 * 60 * 1000;

/** Loudness target. -14 LUFS is the level short-form platforms normalise to. */
const LOUDNESS = { i: -14, tp: -1.5, lra: 11 } as const;

const AUDIO = { sampleRate: 48_000, channels: 2, bitrate: "128k" } as const;

/**
 * Fonts drawtext can use, in order of preference.
 *
 * ffmpeg's `drawtext` needs a font file; `fontconfig` is not reliably configured
 * on Windows, so the file is located explicitly. RENDER_FONT_FILE overrides.
 */
const FONT_CANDIDATES = [
  process.env["RENDER_FONT_FILE"],
  "C:/Windows/Fonts/arialbd.ttf",
  "C:/Windows/Fonts/arial.ttf",
  "C:/Windows/Fonts/segoeuib.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
  "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
  "/System/Library/Fonts/Helvetica.ttc",
].filter((entry): entry is string => typeof entry === "string" && entry.length > 0);

let cachedFont: string | null | undefined;

async function findFont(): Promise<string | null> {
  if (cachedFont !== undefined) return cachedFont;
  for (const candidate of FONT_CANDIDATES) {
    try {
      await access(candidate, constants.R_OK);
      cachedFont = candidate;
      return candidate;
    } catch {
      // Try the next one.
    }
  }
  cachedFont = null;
  return null;
}

/** Test seam: forget the located font so a changed env var takes effect. */
export function resetFontCache(): void {
  cachedFont = undefined;
}

export const ffmpegProvider: EditingProvider = {
  name: "local-ffmpeg",
  kind: "LOCAL_FFMPEG",

  async availability(): Promise<ProviderAvailability> {
    try {
      const result = await runTool(FFMPEG_BIN, ["-hide_banner", "-version"], {
        timeoutMs: 15_000,
      });
      if (result.code !== 0) {
        return { available: false, reason: `ffmpeg -version exited ${result.code}.` };
      }
      const version = /ffmpeg version (\S+)/.exec(result.stdout)?.[1] ?? "unknown";

      const probe = await runTool(FFPROBE_BIN, ["-hide_banner", "-version"], {
        timeoutMs: 15_000,
      });
      if (probe.code !== 0) {
        return {
          available: false,
          reason: "ffmpeg is present but ffprobe is not; output cannot be verified.",
        };
      }
      return { available: true, version };
    } catch (error) {
      return {
        available: false,
        reason: error instanceof RenderError ? error.message : String(error),
      };
    }
  },

  async textSupport() {
    const font = await findFont();
    if (font) return { supported: true };
    return {
      supported: false,
      reason:
        "No usable font file was found for burned-in text. Set RENDER_FONT_FILE to a .ttf path.",
    };
  },

  async render(request: RenderRequest): Promise<RenderOutcome> {
    const started = Date.now();
    const { edl, sources, workDir, outputPath } = request;

    const byId = new Map(sources.map((source) => [source.assetId, source]));
    const totalSeconds = edlDurationSeconds(edl);
    const needsText = edl.clips.some((clip) => clip.onScreenText !== null);
    const font = needsText ? await findFont() : null;

    // Probe each source once. The clip builder has to know whether a source
    // carries audio before it decides which input supplies the track.
    report(request, RenderStage.PREPARING, 2);
    const sourceProbes = new Map<string, MediaProbe>();
    for (const source of sources) {
      throwIfCancelled(request, RenderStage.PREPARING);
      sourceProbes.set(source.assetId, await this.probe(source.absolutePath));
    }

    if (needsText && !font) {
      throw new RenderError(
        "FONT_UNAVAILABLE",
        RenderStage.PREPARING,
        "This cut burns text into the picture, and no usable font file was found. Set RENDER_FONT_FILE to a .ttf path.",
      );
    }

    // --- Stage 1: one normalised intermediate per clip --------------------
    const clipPaths: string[] = [];
    let logTail = "";
    let elapsedSeconds = 0;

    for (const [index, clip] of edl.clips.entries()) {
      throwIfCancelled(request, RenderStage.CLIPPING);

      const source = byId.get(clip.assetId);
      if (!source) {
        throw new RenderError(
          "MISSING_ASSET",
          RenderStage.CLIPPING,
          `Clip ${index + 1} references asset ${clip.assetId}, which was not supplied to the renderer.`,
        );
      }

      const clipPath = path.join(workDir, `clip-${String(index).padStart(3, "0")}.mp4`);
      const clipSeconds = Math.max(0, clip.sourceEnd - clip.sourceStart);

      const textFile =
        clip.onScreenText !== null
          ? await writeTextFile(workDir, index, clip.onScreenText)
          : null;

      const args = buildClipArgs({
        clip,
        clipSeconds,
        source,
        sourceHasAudio: sourceProbes.get(clip.assetId)?.audio !== null,
        edl,
        outputPath: clipPath,
        textFile,
        font,
      });

      const before = elapsedSeconds;
      const result = await runToolOrThrow(FFMPEG_BIN, args, RenderStage.CLIPPING, {
        timeoutMs: CLIP_TIMEOUT_MS,
        ...(request.signal ? { signal: request.signal } : {}),
        onStderr: (chunk) => {
          const at = parseProgressSeconds(chunk);
          if (at !== null && totalSeconds > 0) {
            report(request, RenderStage.CLIPPING, ((before + at) / totalSeconds) * 70);
          }
        },
      });
      logTail = result.log;
      elapsedSeconds += clipSeconds;

      await assertNonEmpty(clipPath, RenderStage.CLIPPING, `clip ${index + 1}`, result.log);
      clipPaths.push(clipPath);
      report(request, RenderStage.CLIPPING, (elapsedSeconds / Math.max(totalSeconds, 1)) * 70);
    }

    // --- Stage 2: concatenate, mix, encode --------------------------------
    throwIfCancelled(request, RenderStage.ASSEMBLING);
    report(request, RenderStage.ASSEMBLING, 72);

    const listPath = path.join(workDir, "concat.txt");
    await writeFile(
      listPath,
      // The concat demuxer takes single-quoted paths and escapes an embedded
      // quote by closing, escaping and reopening. Our paths are generated, but
      // the workDir above them is not.
      clipPaths
        .map((clipPath) => `file '${clipPath.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`)
        .join("\n") + "\n",
      "utf8",
    );

    const subtitlePath = edl.burnSubtitles ? await writeSubtitles(workDir, edl) : null;
    const background = edl.backgroundAudio
      ? byId.get(edl.backgroundAudio.assetId) ?? null
      : null;
    if (edl.backgroundAudio && !background) {
      throw new RenderError(
        "MISSING_ASSET",
        RenderStage.ASSEMBLING,
        `The background audio asset ${edl.backgroundAudio.assetId} was not supplied to the renderer.`,
      );
    }

    const assembleArgs = buildAssembleArgs({
      listPath,
      outputPath,
      edl,
      subtitlePath,
      background,
      font,
    });

    report(request, RenderStage.ENCODING, 75);
    const assembled = await runToolOrThrow(
      FFMPEG_BIN,
      assembleArgs,
      RenderStage.ENCODING,
      {
        timeoutMs: ASSEMBLE_TIMEOUT_MS,
        ...(request.signal ? { signal: request.signal } : {}),
        onStderr: (chunk) => {
          const at = parseProgressSeconds(chunk);
          if (at !== null && totalSeconds > 0) {
            report(request, RenderStage.ENCODING, 75 + (at / totalSeconds) * 20);
          }
        },
      },
    );
    logTail = assembled.log || logTail;

    // --- Verify what was actually produced --------------------------------
    report(request, RenderStage.PROBING, 96);
    await assertNonEmpty(outputPath, RenderStage.PROBING, "the final cut", logTail);
    const probe = await this.probe(outputPath);

    return {
      outputPath,
      probe,
      log: logTail,
      durationMs: Date.now() - started,
    };
  },

  async probe(absolutePath: string): Promise<MediaProbe> {
    const result = await runTool(
      FFPROBE_BIN,
      [
        "-hide_banner",
        "-v",
        "error",
        "-show_format",
        "-show_streams",
        "-of",
        "json",
        absolutePath,
      ],
      { timeoutMs: 60_000 },
    );

    if (result.code !== 0) {
      throw new RenderError(
        "CORRUPT_MEDIA",
        RenderStage.PROBING,
        `ffprobe could not read the file. ${sanitizeLog(result.stderr).split("\n").pop() ?? ""}`,
        { log: result.log },
      );
    }

    let parsed: FfprobeJson;
    try {
      parsed = JSON.parse(result.stdout) as FfprobeJson;
    } catch (error) {
      throw new RenderError(
        "CORRUPT_MEDIA",
        RenderStage.PROBING,
        "ffprobe returned output that was not valid JSON.",
        { cause: error },
      );
    }

    const streams = parsed.streams ?? [];
    const video = streams.find((stream) => stream.codec_type === "video");
    const audio = streams.find((stream) => stream.codec_type === "audio");
    const size = Number.parseInt(parsed.format?.size ?? "0", 10);
    const duration = Number.parseFloat(parsed.format?.duration ?? "");

    return {
      formatName: parsed.format?.format_name ?? "unknown",
      durationSeconds: Number.isFinite(duration) ? duration : null,
      sizeBytes: Number.isFinite(size) ? size : 0,
      video: video
        ? {
            codec: video.codec_name ?? "unknown",
            width: video.width ?? 0,
            height: video.height ?? 0,
            fps: parseRate(video.avg_frame_rate ?? video.r_frame_rate ?? null),
          }
        : null,
      audio: audio
        ? {
            codec: audio.codec_name ?? "unknown",
            channels: audio.channels ?? 0,
            sampleRate: audio.sample_rate ? Number.parseInt(audio.sample_rate, 10) : null,
          }
        : null,
    };
  },
};

// ---------------------------------------------------------------------------
// Command construction
// ---------------------------------------------------------------------------

/**
 * One clip, normalised to the output format.
 *
 * `-ss` before `-i` seeks by keyframe and is fast; the trim filter after the
 * input is exact and slower. Timings here came from a treatment, so accuracy
 * wins and the decoder does the work.
 *
 * Two inputs are always present: the source, and generated silence. Which one
 * supplies the audio track is decided per clip rather than by mapping both —
 * `-map 0:a?` alongside `-map 1:a` would give two tracks on a source that has
 * audio, and the concat demuxer in stage two needs every intermediate to have
 * exactly one.
 */
export function buildClipArgs(input: {
  clip: EdlClip;
  clipSeconds: number;
  source: RenderSource;
  sourceHasAudio: boolean;
  edl: RenderEdl;
  outputPath: string;
  textFile: string | null;
  font: string | null;
}): string[] {
  const {
    clip,
    clipSeconds,
    source,
    sourceHasAudio,
    edl,
    outputPath,
    textFile,
    font,
  } = input;

  const useSourceAudio = edl.preserveSourceAudio && !clip.muteAudio && sourceHasAudio;

  const args: string[] = ["-hide_banner", "-nostdin", "-y", "-progress", "pipe:2"];
  args.push("-i", source.absolutePath);
  args.push(
    "-f",
    "lavfi",
    "-t",
    Math.max(clipSeconds, 0.1).toFixed(3),
    "-i",
    `anullsrc=channel_layout=stereo:sample_rate=${AUDIO.sampleRate}`,
  );

  const videoFilters = [
    `trim=start=${clip.sourceStart.toFixed(3)}:end=${clip.sourceEnd.toFixed(3)}`,
    "setpts=PTS-STARTPTS",
    `scale=${edl.width}:${edl.height}:force_original_aspect_ratio=decrease`,
    `pad=${edl.width}:${edl.height}:(ow-iw)/2:(oh-ih)/2:color=black`,
    "setsar=1",
    `fps=${edl.fps}`,
    "format=yuv420p",
  ];
  if (textFile && font) videoFilters.push(drawTextFilter(textFile, font, edl));

  const graph = [`[0:v]${videoFilters.join(",")}[v]`];
  if (useSourceAudio) {
    graph.push(
      `[0:a]atrim=start=${clip.sourceStart.toFixed(3)}:end=${clip.sourceEnd.toFixed(3)},asetpts=PTS-STARTPTS,aformat=sample_fmts=fltp:sample_rates=${AUDIO.sampleRate}:channel_layouts=stereo[a]`,
    );
  } else {
    graph.push(
      `[1:a]aformat=sample_fmts=fltp:sample_rates=${AUDIO.sampleRate}:channel_layouts=stereo[a]`,
    );
  }

  args.push("-filter_complex", graph.join(";"));
  args.push("-map", "[v]", "-map", "[a]");
  args.push("-t", clipSeconds.toFixed(3));
  args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "20");
  // Set here rather than at assembly: when stage two stream-copies the video,
  // whatever the intermediates were written as is what ships.
  args.push("-profile:v", "high", "-level", "4.0");
  args.push("-pix_fmt", "yuv420p");
  args.push("-c:a", "aac", "-ar", String(AUDIO.sampleRate), "-ac", String(AUDIO.channels));
  args.push("-b:a", AUDIO.bitrate);
  args.push("-movflags", "+faststart");
  args.push(outputPath);
  return args;
}

export function buildAssembleArgs(input: {
  listPath: string;
  outputPath: string;
  edl: RenderEdl;
  subtitlePath: string | null;
  background: RenderSource | null;
  font: string | null;
}): string[] {
  const { listPath, outputPath, edl, subtitlePath, background } = input;

  const args: string[] = ["-hide_banner", "-nostdin", "-y", "-progress", "pipe:2"];
  args.push("-f", "concat", "-safe", "0", "-i", listPath);
  if (background) args.push("-stream_loop", "-1", "-i", background.absolutePath);

  const graph: string[] = [];
  let videoLabel = "0:v";
  let audioLabel = "0:a";

  if (subtitlePath) {
    // libass defaults assume a 384px-tall frame, so on a 1920px canvas it draws
    // enormous type hard against the bottom edge — where the platform's own UI
    // sits anyway. The style is set explicitly rather than left to the default.
    const style = [
      "FontSize=22",
      "Outline=2",
      "Shadow=0",
      "MarginV=90",
      "Alignment=2",
      "PrimaryColour=&H00FFFFFF",
      "OutlineColour=&H99000000",
    ].join(",");
    graph.push(
      `[0:v]subtitles='${escapeFilterPath(subtitlePath)}':force_style='${style}'[vsub]`,
    );
    videoLabel = "vsub";
  }

  if (background && edl.backgroundAudio) {
    // `duration=first` keeps the looped bed from extending the cut, and
    // `dropout_transition=0` stops amix raising the bed when speech stops.
    graph.push(
      `[1:a]volume=${edl.backgroundAudio.gainDb}dB,aformat=sample_fmts=fltp:sample_rates=${AUDIO.sampleRate}:channel_layouts=stereo[bed]`,
      `[0:a][bed]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[amixed]`,
    );
    audioLabel = "amixed";
  }

  if (edl.normalizeAudio) {
    graph.push(`[${audioLabel}]loudnorm=I=${LOUDNESS.i}:TP=${LOUDNESS.tp}:LRA=${LOUDNESS.lra}[anorm]`);
    audioLabel = "anorm";
  }

  if (graph.length > 0) args.push("-filter_complex", graph.join(";"));
  // A label is either an input specifier ("0:v") or a filter output, which has
  // to be bracketed. Getting this wrong maps the wrong stream rather than
  // erroring, so it is decided in one place.
  args.push("-map", mapLabel(videoLabel), "-map", mapLabel(audioLabel));

  // Video is re-encoded only when a filter touched it. The intermediates are
  // already at the target geometry and codec, so copying is both faster and
  // lossless when nothing changed.
  //
  // `-profile:v` and `-level` belong to the encoder and are rejected outright
  // when the codec is `copy` — ffmpeg tries to parse "high" as a numeric
  // constant and fails to open the output. They go with the encoder or not at
  // all. The intermediates were already written as High profile, so a copied
  // stream keeps it anyway.
  if (subtitlePath) {
    args.push("-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p");
    args.push("-profile:v", "high", "-level", "4.0");
  } else {
    args.push("-c:v", "copy");
  }
  args.push("-c:a", "aac", "-ar", String(AUDIO.sampleRate), "-ac", String(AUDIO.channels));
  args.push("-b:a", AUDIO.bitrate);
  args.push("-movflags", "+faststart");
  args.push("-f", "mp4");
  args.push(outputPath);
  return args;
}

/**
 * drawtext, reading its copy from a file.
 *
 * Passing the text inline means escaping backslashes, quotes, colons, commas,
 * percent signs and brackets correctly for two nested parsers, and a caption is
 * user-supplied text. `textfile` moves the problem to a path this code generates
 * itself, which is a much smaller surface.
 */
function drawTextFilter(textFile: string, font: string, edl: RenderEdl): string {
  const fontSize = Math.round(edl.width * 0.055);
  const parts = [
    `fontfile='${escapeFilterPath(font)}'`,
    `textfile='${escapeFilterPath(textFile)}'`,
    "reload=0",
    `fontsize=${fontSize}`,
    "fontcolor=white",
    "borderw=4",
    "bordercolor=black@0.85",
    "line_spacing=8",
    "x=(w-text_w)/2",
    // Sits above the platform's own caption furniture at the bottom of frame.
    "y=h*0.72",
  ];
  return `drawtext=${parts.join(":")}`;
}

async function writeTextFile(
  workDir: string,
  index: number,
  text: string,
): Promise<string> {
  const file = path.join(workDir, `text-${String(index).padStart(3, "0")}.txt`);
  await writeFile(file, wrapText(text, 24), "utf8");
  return file;
}

/** Hard-wraps on word boundaries; a single 90-character line is unreadable. */
export function wrapText(text: string, perLine: number): string {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (current === "") current = word;
    else if (`${current} ${word}`.length <= perLine) current = `${current} ${word}`;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current !== "") lines.push(current);
  return lines.join("\n");
}

/** An SRT built from the clips' own output-timeline positions. */
export async function writeSubtitles(
  workDir: string,
  edl: RenderEdl,
): Promise<string | null> {
  const entries: string[] = [];
  let at = 0;
  let index = 1;

  for (const clip of edl.clips) {
    const length = Math.max(0, clip.sourceEnd - clip.sourceStart);
    if (clip.subtitle && clip.subtitle.trim() !== "") {
      entries.push(
        `${index}\n${srtTime(at)} --> ${srtTime(at + length)}\n${wrapText(clip.subtitle, 42)}\n`,
      );
      index += 1;
    }
    at += length;
  }

  if (entries.length === 0) return null;
  const file = path.join(workDir, "subtitles.srt");
  await writeFile(file, entries.join("\n"), "utf8");
  return file;
}

/** Input specifiers pass through; filter outputs get their brackets. */
function mapLabel(label: string): string {
  return /^\d+:/.test(label) ? label : `[${label}]`;
}

function srtTime(seconds: number): string {
  const ms = Math.round(seconds * 1000);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const millis = ms % 1000;
  const pad = (value: number, width = 2) => String(value).padStart(width, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(millis, 3)}`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function report(request: RenderRequest, stage: RenderStage, percent: number): void {
  request.onProgress?.({
    stage,
    percent: Math.max(0, Math.min(99, Math.round(percent))),
  });
}

function throwIfCancelled(request: RenderRequest, stage: RenderStage): void {
  if (request.signal?.aborted) {
    throw new RenderError("CANCELLED", stage, "The render was cancelled.");
  }
}

async function assertNonEmpty(
  file: string,
  stage: RenderStage,
  what: string,
  log: string,
): Promise<void> {
  try {
    const info = await stat(file);
    if (info.size === 0) {
      throw new RenderError(
        "OUTPUT_MISSING",
        stage,
        `ffmpeg reported success but wrote an empty file for ${what}.`,
        { log },
      );
    }
  } catch (error) {
    if (error instanceof RenderError) throw error;
    throw new RenderError(
      "OUTPUT_MISSING",
      stage,
      `ffmpeg reported success but produced no file for ${what}.`,
      { cause: error, log },
    );
  }
}

function parseRate(rate: string | null): number | null {
  if (!rate) return null;
  const [num, den] = rate.split("/");
  const numerator = Number(num);
  const denominator = den === undefined ? 1 : Number(den);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
    return null;
  }
  const value = numerator / denominator;
  return Number.isFinite(value) && value > 0 ? Math.round(value * 100) / 100 : null;
}

type FfprobeJson = {
  format?: { format_name?: string; duration?: string; size?: string };
  streams?: Array<{
    codec_type?: string;
    codec_name?: string;
    width?: number;
    height?: number;
    channels?: number;
    sample_rate?: string;
    avg_frame_rate?: string;
    r_frame_rate?: string;
  }>;
};
