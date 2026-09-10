import {
  AlertTriangle,
  Archive,
  CalendarClock,
  CheckCircle2,
  CircleDashed,
  CircleDot,
  CircleSlash,
  Clock,
  FileText,
  HelpCircle,
  Camera,
  Loader2,
  Music2,
  ShieldCheck,
  ShieldX,
  ThumbsUp,
  UploadCloud,
  XCircle,
  CirclePlay,
} from "lucide-react";
import type { ReactNode } from "react";
import { Badge, type BadgeTone } from "./primitives";
import type {
  AccountStatus,
  ApprovalState,
  Confidence,
  JobStatus,
  MetricSource,
  Platform,
  PostPlatformStatus,
  PostStatus,
  PublishPolicy,
} from "@/generated/prisma/enums";

/**
 * One place where every status becomes a colour, an icon and a word.
 *
 * The icon is not decoration: the status palette sits outside the validated
 * categorical system, so a status must never be identifiable by colour alone.
 * Every badge below therefore ships icon + text together.
 */

type Descriptor = { tone: BadgeTone; icon: ReactNode; label: string };

const POST_STATUS: Record<PostStatus, Descriptor> = {
  DRAFT: { tone: "neutral", icon: <FileText />, label: "Draft" },
  READY: { tone: "warning", icon: <Clock />, label: "Needs approval" },
  APPROVED: { tone: "info", icon: <ThumbsUp />, label: "Approved" },
  SCHEDULED: { tone: "accent", icon: <CalendarClock />, label: "Scheduled" },
  UPLOADING: { tone: "info", icon: <Loader2 className="animate-spin" />, label: "Uploading" },
  PUBLISHED: { tone: "good", icon: <CheckCircle2 />, label: "Published" },
  FAILED: { tone: "critical", icon: <XCircle />, label: "Failed" },
  ARCHIVED: { tone: "neutral", icon: <Archive />, label: "Archived" },
};

export function PostStatusBadge({ status }: { status: PostStatus }) {
  const descriptor = POST_STATUS[status];
  return (
    <Badge tone={descriptor.tone} icon={descriptor.icon}>
      {descriptor.label}
    </Badge>
  );
}

const TARGET_STATUS: Record<PostPlatformStatus, Descriptor> = {
  PENDING: { tone: "neutral", icon: <CircleDashed />, label: "Pending" },
  QUEUED: { tone: "accent", icon: <CalendarClock />, label: "Queued" },
  UPLOADING: { tone: "info", icon: <UploadCloud />, label: "Uploading" },
  PUBLISHED: { tone: "good", icon: <CheckCircle2 />, label: "Published" },
  FAILED: { tone: "critical", icon: <XCircle />, label: "Failed" },
  SKIPPED: { tone: "neutral", icon: <CircleSlash />, label: "Skipped" },
};

export function TargetStatusBadge({ status }: { status: PostPlatformStatus }) {
  const descriptor = TARGET_STATUS[status];
  return (
    <Badge tone={descriptor.tone} icon={descriptor.icon}>
      {descriptor.label}
    </Badge>
  );
}

const JOB_STATUS: Record<JobStatus, Descriptor> = {
  PENDING: { tone: "neutral", icon: <CircleDashed />, label: "Pending" },
  QUEUED: { tone: "accent", icon: <CalendarClock />, label: "Queued" },
  RUNNING: { tone: "info", icon: <Loader2 className="animate-spin" />, label: "Running" },
  SUCCEEDED: { tone: "good", icon: <CheckCircle2 />, label: "Succeeded" },
  FAILED: { tone: "serious", icon: <AlertTriangle />, label: "Failed" },
  CANCELLED: { tone: "neutral", icon: <CircleSlash />, label: "Cancelled" },
  DEAD_LETTER: { tone: "critical", icon: <XCircle />, label: "Gave up" },
};

export function JobStatusBadge({ status }: { status: JobStatus }) {
  const descriptor = JOB_STATUS[status];
  return (
    <Badge tone={descriptor.tone} icon={descriptor.icon}>
      {descriptor.label}
    </Badge>
  );
}

const ACCOUNT_STATUS: Record<AccountStatus, Descriptor> = {
  CONNECTED: { tone: "good", icon: <ShieldCheck />, label: "Connected" },
  DISCONNECTED: { tone: "neutral", icon: <CircleDashed />, label: "Not connected" },
  NEEDS_REAUTH: { tone: "warning", icon: <AlertTriangle />, label: "Needs reconnect" },
  ERROR: { tone: "critical", icon: <ShieldX />, label: "Error" },
};

export function AccountStatusBadge({ status }: { status: AccountStatus }) {
  const descriptor = ACCOUNT_STATUS[status];
  return (
    <Badge tone={descriptor.tone} icon={descriptor.icon}>
      {descriptor.label}
    </Badge>
  );
}

const APPROVAL_STATE: Record<ApprovalState, Descriptor> = {
  NOT_REQUIRED: { tone: "neutral", icon: <CircleDot />, label: "No approval needed" },
  PENDING: { tone: "warning", icon: <Clock />, label: "Awaiting approval" },
  APPROVED: { tone: "good", icon: <CheckCircle2 />, label: "Approved" },
  REJECTED: { tone: "critical", icon: <XCircle />, label: "Rejected" },
};

export function ApprovalBadge({ state }: { state: ApprovalState }) {
  const descriptor = APPROVAL_STATE[state];
  return (
    <Badge tone={descriptor.tone} icon={descriptor.icon}>
      {descriptor.label}
    </Badge>
  );
}

const CONFIDENCE: Record<Confidence, Descriptor> = {
  HIGH: { tone: "good", icon: <CheckCircle2 />, label: "High confidence" },
  MEDIUM: { tone: "warning", icon: <AlertTriangle />, label: "Medium confidence" },
  LOW: { tone: "neutral", icon: <HelpCircle />, label: "Low confidence" },
};

export function ConfidenceBadge({
  confidence,
  reason,
}: {
  confidence: Confidence;
  reason?: string;
}) {
  const descriptor = CONFIDENCE[confidence];
  return (
    <Badge tone={descriptor.tone} icon={descriptor.icon} title={reason}>
      {descriptor.label}
    </Badge>
  );
}

const POLICY: Record<PublishPolicy, Descriptor> = {
  MANUAL_APPROVAL: { tone: "neutral", icon: <ThumbsUp />, label: "Manual approval" },
  AUTO_PUBLISH: { tone: "warning", icon: <AlertTriangle />, label: "Auto publish" },
  SMART_APPROVAL: { tone: "info", icon: <ShieldCheck />, label: "Smart approval" },
};

export function PolicyBadge({ policy }: { policy: PublishPolicy }) {
  const descriptor = POLICY[policy];
  return (
    <Badge tone={descriptor.tone} icon={descriptor.icon}>
      {descriptor.label}
    </Badge>
  );
}

/**
 * Where a metric came from. This one matters: simulated numbers must never be
 * mistaken for platform data, so the badge is loud about it.
 */
const SOURCE: Record<MetricSource, Descriptor> = {
  OFFICIAL_API: { tone: "good", icon: <ShieldCheck />, label: "Official API" },
  BROWSER_ASSISTED: { tone: "info", icon: <CircleDot />, label: "Browser-read" },
  MANUAL: { tone: "neutral", icon: <FileText />, label: "Entered by hand" },
  SIMULATED: { tone: "serious", icon: <AlertTriangle />, label: "Simulated" },
};

export function MetricSourceBadge({ source }: { source: MetricSource }) {
  const descriptor = SOURCE[source];
  return (
    <Badge
      tone={descriptor.tone}
      icon={descriptor.icon}
      title={
        source === "SIMULATED"
          ? "Generated by the publish simulator because live publishing is off. Not platform data."
          : undefined
      }
    >
      {descriptor.label}
    </Badge>
  );
}

// ---------------------------------------------------------------------------
// Platforms
// ---------------------------------------------------------------------------

// Generic glyphs rather than brand marks: lucide dropped its brand set, and
// third-party logos are trademarks we have no licence to redraw.
const PLATFORM_ICONS: Record<Platform, ReactNode> = {
  TIKTOK: <Music2 />,
  INSTAGRAM: <Camera />,
  YOUTUBE: <CirclePlay />,
};

const PLATFORM_LABELS: Record<Platform, string> = {
  TIKTOK: "TikTok",
  INSTAGRAM: "Instagram",
  YOUTUBE: "YouTube",
};

export function platformLabel(platform: Platform): string {
  return PLATFORM_LABELS[platform];
}

export function PlatformBadge({
  platform,
  className,
}: {
  platform: Platform;
  className?: string;
}) {
  return (
    <Badge tone="neutral" icon={PLATFORM_ICONS[platform]} className={className}>
      {PLATFORM_LABELS[platform]}
    </Badge>
  );
}

export function PlatformIcon({ platform }: { platform: Platform }) {
  return (
    <span className="text-ink-secondary [&>svg]:size-3.5" title={PLATFORM_LABELS[platform]}>
      {PLATFORM_ICONS[platform]}
    </span>
  );
}

/** Capability mode, shown on the Accounts and Diagnostics screens. */
export function CapabilityBadge({ mode }: { mode: string }) {
  if (mode === "OFFICIAL_API") {
    return (
      <Badge tone="good" icon={<ShieldCheck />}>
        Official API
      </Badge>
    );
  }
  if (mode === "BROWSER_ASSISTED") {
    return (
      <Badge tone="info" icon={<CircleDot />}>
        Browser-assisted
      </Badge>
    );
  }
  return (
    <Badge tone="neutral" icon={<CircleSlash />}>
      Not supported
    </Badge>
  );
}
