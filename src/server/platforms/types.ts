import type { Page } from "playwright";
import type {
  FailureCategory,
  Platform,
  PublishStage,
} from "@/generated/prisma/enums";

/**
 * The platform boundary.
 *
 * The scheduler, the approval flow and the publishing worker never mention
 * TikTok, Instagram or YouTube by name. They ask the registry for a
 * `SocialPlatform` and read its declared capabilities. Adding a platform means
 * adding one adapter file and one registry entry.
 */

/** How a given operation is actually carried out for a platform. */
export type CapabilityMode =
  /** A documented, official API supports this. Always preferred. */
  | "OFFICIAL_API"
  /** Performed by driving the platform's own web UI in a logged-in browser. */
  | "BROWSER_ASSISTED"
  /** Not offered by the platform, or not implemented here. */
  | "UNSUPPORTED";

export type PlatformCapability =
  | "upload"
  | "publish"
  /** Platform's own "publish later" feature, as opposed to us holding the job. */
  | "nativeSchedule"
  | "metrics"
  | "checkStatus";

export type MediaConstraints = {
  maxSizeBytes: number;
  minDurationSeconds: number | null;
  maxDurationSeconds: number | null;
  acceptedMimeTypes: string[];
  /** Aspect ratios the platform renders without cropping. */
  preferredAspectRatios: string[];
  captionMaxLength: number;
  hashtagMaxCount: number;
};

export type MediaCandidate = {
  mimeType: string;
  sizeBytes: number;
  durationSeconds: number | null;
  aspectRatio: string | null;
};

export type ValidationIssue = {
  severity: "error" | "warning";
  message: string;
};

export type ValidationVerdict = {
  ok: boolean;
  issues: ValidationIssue[];
};

/**
 * A failure an adapter understands well enough to classify.
 *
 * Classification belongs to the adapter, not to a regex over an error string in
 * the runner: only the adapter knows whether "element not found" means the DOM
 * drifted, the session expired, or the platform is showing a checkpoint. The
 * runner uses the category to decide retry policy, so guessing it would mean
 * retrying things that can never succeed.
 */
export class AdapterFailure extends Error {
  constructor(
    message: string,
    readonly category: FailureCategory,
    readonly stage: PublishStage,
    /** Non-sensitive context for the operator. Never credentials or cookies. */
    readonly detail: Record<string, unknown> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AdapterFailure";
  }
}

/** True when retrying the same job could plausibly succeed. */
export function isRetryableCategory(category: FailureCategory): boolean {
  return category === "TRANSIENT" || category === "UNKNOWN";
}

/** One line in the publish log shown in the UI. */
export type StepLogger = (
  message: string,
  detail?: Record<string, unknown>,
) => Promise<void>;

export type BrowserPublishContext = {
  page: Page;
  /** Absolute path of the media file to upload. */
  mediaPath: string;
  caption: string;
  hashtags: string[];
  cta: string;
  /** Set when the platform natively supports scheduling and we want to use it. */
  publishAt: Date | null;
  log: StepLogger;
};

/**
 * Proof that a publication exists on the platform.
 *
 * A successful button click is not proof. This is only populated when the
 * adapter has re-read the platform's own state and found the post there.
 */
export type PublicationEvidence = {
  method: string;
  remotePostId: string | null;
  permalink: string | null;
  publishedAt: Date | null;
  observed: string;
};

export type PublishOutcome =
  | {
      status: "published";
      remotePostId: string | null;
      permalink: string | null;
      platformAccountId: string | null;
      /** Null when the adapter submitted successfully but could not confirm. */
      verification: PublicationEvidence | null;
    }
  | {
      status: "scheduled";
      remotePostId: string | null;
      permalink: string | null;
      platformAccountId: string | null;
      scheduledFor: Date;
      verification: PublicationEvidence | null;
    };

/**
 * What a session probe found.
 *
 * `AUTHENTICATED` is the only state that permits publishing, and an adapter may
 * only return it when it has seen positive evidence of a usable signed-in
 * session — never merely because a session blob exists on disk.
 */
export type SignInState =
  | "AUTHENTICATED"
  | "UNAUTHENTICATED"
  | "CHALLENGE"
  | "UNKNOWN";

export type SignInProbe = {
  state: SignInState;
  handle: string | null;
  displayName: string | null;
  /** The platform's own account id, when it can be read cheaply. */
  platformAccountId: string | null;
  /** What the adapter actually observed, for the diagnostics view. */
  evidence: string;
};

export type MetricsSample = {
  views: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
  profileVisits: number;
  linkClicks: number;
  watchTimeSeconds: number;
  completionRate: number;
  followerDelta: number;
  conversions: number;
};

export type SocialPlatform = {
  readonly platform: Platform;
  readonly label: string;
  /** Where the operator completes login by hand. */
  readonly loginUrl: string;
  /** Where publishing happens once signed in. */
  readonly composerUrl: string;
  /** Page used to confirm a session is still valid. */
  readonly sessionProbeUrl: string;
  readonly capabilities: Record<PlatformCapability, CapabilityMode>;
  readonly constraints: MediaConstraints;

  /** Pure function: no browser, no network. Used at approval time. */
  validateMedia(candidate: MediaCandidate): ValidationVerdict;

  /** Composes the caption exactly as the platform should receive it. */
  composeCaption(input: {
    caption: string;
    hashtags: string[];
    cta: string;
  }): string;

  /** Reads whether the loaded session is still signed in, and as whom. */
  probeSignIn(page: Page): Promise<SignInProbe>;

  /**
   * Drives the platform's own composer. Only called when the platform declares
   * BROWSER_ASSISTED for `publish` and live publishing is enabled.
   */
  publishViaBrowser(context: BrowserPublishContext): Promise<PublishOutcome>;

  /**
   * Re-reads the platform to confirm a publication exists. Called after a
   * submit that reported success, and again by reconciliation for a destination
   * that has a remote id but no verification.
   */
  verifyPublication?(input: {
    page: Page;
    remotePostId: string | null;
    caption: string;
    log: StepLogger;
  }): Promise<PublicationEvidence | null>;

  /** Present only when the platform declares a metrics capability. */
  collectMetrics?(input: {
    page: Page;
    remotePostId: string;
    log: StepLogger;
  }): Promise<Partial<MetricsSample>>;
};

// ---------------------------------------------------------------------------
// Shared helpers used by every adapter
// ---------------------------------------------------------------------------

/** Standard media check driven entirely by a platform's declared constraints. */
export function validateAgainstConstraints(
  candidate: MediaCandidate,
  constraints: MediaConstraints,
  label: string,
): ValidationVerdict {
  const issues: ValidationIssue[] = [];

  if (!constraints.acceptedMimeTypes.includes(candidate.mimeType)) {
    issues.push({
      severity: "error",
      message: `${label} does not accept ${candidate.mimeType}. Accepted: ${constraints.acceptedMimeTypes.join(", ")}.`,
    });
  }

  if (candidate.sizeBytes > constraints.maxSizeBytes) {
    issues.push({
      severity: "error",
      message: `File is ${mb(candidate.sizeBytes)}, over the ${mb(constraints.maxSizeBytes)} ${label} limit.`,
    });
  }

  if (candidate.durationSeconds !== null) {
    if (
      constraints.minDurationSeconds !== null &&
      candidate.durationSeconds < constraints.minDurationSeconds
    ) {
      issues.push({
        severity: "error",
        message: `${Math.round(candidate.durationSeconds)}s is shorter than the ${constraints.minDurationSeconds}s ${label} minimum.`,
      });
    }
    if (
      constraints.maxDurationSeconds !== null &&
      candidate.durationSeconds > constraints.maxDurationSeconds
    ) {
      issues.push({
        severity: "error",
        message: `${Math.round(candidate.durationSeconds)}s exceeds the ${constraints.maxDurationSeconds}s ${label} maximum.`,
      });
    }
  }

  if (
    candidate.aspectRatio &&
    constraints.preferredAspectRatios.length > 0 &&
    !constraints.preferredAspectRatios.includes(candidate.aspectRatio)
  ) {
    issues.push({
      severity: "warning",
      message: `${candidate.aspectRatio} will be cropped or letterboxed on ${label}. Preferred: ${constraints.preferredAspectRatios.join(", ")}.`,
    });
  }

  return { ok: issues.every((issue) => issue.severity !== "error"), issues };
}

/** Caption + CTA + a trimmed hashtag set, clipped to the platform's limit. */
export function composeStandardCaption(
  input: { caption: string; hashtags: string[]; cta: string },
  constraints: MediaConstraints,
): string {
  const tags = input.hashtags
    .slice(0, constraints.hashtagMaxCount)
    .map((tag) => (tag.startsWith("#") ? tag : `#${tag}`))
    .join(" ");

  const blocks = [input.caption.trim(), input.cta.trim(), tags.trim()].filter(
    (block) => block.length > 0,
  );

  const full = blocks.join("\n\n");
  if (full.length <= constraints.captionMaxLength) return full;

  // Trim the caption body, never the CTA or the tags.
  const overflow = full.length - constraints.captionMaxLength;
  const trimmedCaption = input.caption.trim().slice(0, Math.max(0, input.caption.trim().length - overflow - 1)).trimEnd();
  return [trimmedCaption, input.cta.trim(), tags.trim()]
    .filter((block) => block.length > 0)
    .join("\n\n")
    .slice(0, constraints.captionMaxLength);
}

function mb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
}
