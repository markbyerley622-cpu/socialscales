import { AudioLines, ImageIcon, VolumeX } from "lucide-react";
import { cn, duration } from "@/lib/utils";
import { AssetKind } from "@/generated/prisma/enums";

/**
 * Asset preview.
 *
 * Videos are rendered as a real <video preload="metadata">, which shows the first
 * frame when the file has a decodable stream. The seeded demo files carry valid
 * containers but filler payload, so they fall back to the tinted panel below
 * rather than showing a broken element — the facts strip is the useful part
 * either way.
 */
export function AssetThumb({
  kind,
  storageKey,
  mimeType,
  aspectRatio,
  durationSeconds,
  hasAudio,
  accentColor,
  className,
}: {
  kind: AssetKind;
  storageKey: string;
  mimeType: string;
  aspectRatio: string | null;
  durationSeconds: number | null;
  hasAudio: boolean | null;
  accentColor: string;
  className?: string;
}) {
  const src = `/api/media/${storageKey}`;

  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-md border border-hairline bg-surface-raised",
        className,
      )}
      style={{
        background: `linear-gradient(160deg, ${accentColor}22, transparent 70%)`,
      }}
    >
      {kind === AssetKind.IMAGE ? (
        // Deliberately a plain <img>: next/image cannot optimise an
        // authenticated private route, and these are already small.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt=""
          loading="lazy"
          className="size-full object-cover"
        />
      ) : (
        <video
          src={src}
          preload="metadata"
          muted
          playsInline
          className="size-full object-cover"
        />
      )}

      {/* Facts strip: the numbers that decide whether a platform will take it. */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-gradient-to-t from-black/80 to-transparent px-1.5 pb-1.5 pt-4">
        {kind === AssetKind.IMAGE ? (
          <Chip>
            <ImageIcon className="size-2.5" />
            Image
          </Chip>
        ) : (
          <Chip>{duration(durationSeconds)}</Chip>
        )}
        {aspectRatio ? <Chip>{aspectRatio}</Chip> : null}
        {kind === AssetKind.VIDEO && hasAudio === false ? (
          <Chip title="No audio track: needs captions or music on most platforms">
            <VolumeX className="size-2.5" />
          </Chip>
        ) : null}
        {kind === AssetKind.VIDEO && hasAudio === true ? (
          <Chip title="Has an audio track">
            <AudioLines className="size-2.5" />
          </Chip>
        ) : null}
        <span className="ml-auto text-[9.5px] uppercase tracking-wider text-white/60">
          {mimeType.split("/")[1]}
        </span>
      </div>
    </div>
  );
}

function Chip({
  children,
  title,
}: {
  children: React.ReactNode;
  title?: string;
}) {
  return (
    <span
      title={title}
      className="inline-flex items-center gap-1 rounded bg-black/55 px-1.5 py-px text-[9.5px] font-medium tabular text-white/85 backdrop-blur-sm"
    >
      {children}
    </span>
  );
}
