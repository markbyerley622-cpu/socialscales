import type { Locator, Page } from "playwright";
import { AdapterFailure } from "./types";
import type { FailureCategory, PublishStage } from "@/generated/prisma/enums";

/**
 * Selector resolution for browser-assisted adapters.
 *
 * Platform UIs drift, and they ship more than one variant at a time (A/B tests,
 * staged rollouts, locale differences). So a target is described as an ordered
 * list of *candidates* rather than one selector, and resolution reports exactly
 * which candidates it tried when none matched — a bare "element not found" is
 * useless when the fix is "the DOM changed, here is what we looked for".
 *
 * Candidates are ordered most-stable-first:
 *   1. semantic role + accessible name
 *   2. stable data attributes the platform uses for its own tests
 *   3. structural relationships
 *   4. visible text, last
 *
 * Deliberately absent: generated class names, absolute DOM paths, nth-child
 * positional selectors, and anything that would break on a re-render.
 */

export type Candidate =
  | { kind: "role"; role: RoleName; name?: string | RegExp; exact?: boolean }
  | { kind: "label"; text: string | RegExp }
  | { kind: "placeholder"; text: string | RegExp }
  | { kind: "testId"; value: string }
  | { kind: "css"; selector: string }
  | { kind: "text"; value: string | RegExp };

/** The subset of ARIA roles these adapters actually target. */
export type RoleName =
  | "button"
  | "link"
  | "textbox"
  | "checkbox"
  | "radio"
  | "menuitem"
  | "combobox"
  | "switch"
  | "heading"
  | "dialog";

export type Target = {
  /** Human name used in logs and errors, e.g. "caption editor". */
  description: string;
  candidates: Candidate[];
};

export function describeCandidate(candidate: Candidate): string {
  switch (candidate.kind) {
    case "role":
      return `role=${candidate.role}${candidate.name ? ` name=${String(candidate.name)}` : ""}`;
    case "label":
      return `label=${String(candidate.text)}`;
    case "placeholder":
      return `placeholder=${String(candidate.text)}`;
    case "testId":
      return `data-e2e=${candidate.value}`;
    case "css":
      return `css=${candidate.selector}`;
    case "text":
      return `text=${String(candidate.value)}`;
  }
}

function toLocator(page: Page, candidate: Candidate): Locator {
  switch (candidate.kind) {
    case "role":
      return page.getByRole(candidate.role, {
        name: candidate.name,
        exact: candidate.exact,
      });
    case "label":
      return page.getByLabel(candidate.text);
    case "placeholder":
      return page.getByPlaceholder(candidate.text);
    case "testId":
      // TikTok and several others expose `data-e2e` for their own test suites.
      // It is the most stable non-semantic hook available.
      return page.locator(`[data-e2e="${candidate.value}"]`);
    case "css":
      return page.locator(candidate.selector);
    case "text":
      return page.getByText(candidate.value);
  }
}

export type ResolveOptions = {
  timeoutMs?: number;
  /** Requires the element to be visible, not merely attached. */
  requireVisible?: boolean;
  /** Category to raise when nothing matches. */
  failureCategory?: FailureCategory;
  stage: PublishStage;
};

export type Resolved = {
  locator: Locator;
  /** Which candidate matched, for the step log. */
  via: string;
};

/**
 * Tries each candidate in order until one is present, polling until the timeout.
 *
 * Polls candidates round-robin rather than exhausting each in turn, so a slow
 * page does not spend the entire budget on the first candidate.
 */
export async function resolve(
  page: Page,
  target: Target,
  options: ResolveOptions,
): Promise<Resolved> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const requireVisible = options.requireVisible ?? true;
  const deadline = Date.now() + timeoutMs;
  const attempts: string[] = [];

  while (Date.now() < deadline) {
    for (const candidate of target.candidates) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      try {
        const locator = toLocator(page, candidate).first();
        if (requireVisible) {
          if (await locator.isVisible({ timeout: Math.min(1_000, remaining) })) {
            return { locator, via: describeCandidate(candidate) };
          }
        } else if ((await locator.count()) > 0) {
          return { locator, via: describeCandidate(candidate) };
        }
      } catch {
        // Candidate not present yet; try the next one.
      }
    }
  }

  for (const candidate of target.candidates) attempts.push(describeCandidate(candidate));

  throw new AdapterFailure(
    `Could not find the ${target.description} within ${Math.round(timeoutMs / 1000)}s. ` +
      `The page layout has probably changed. Tried, in order: ${attempts.join(" | ")}.`,
    options.failureCategory ?? "SELECTOR_DRIFT",
    options.stage,
    { target: target.description, candidates: attempts, url: safeUrl(page) },
  );
}

/** Resolve-then-click, with the same diagnostics. */
export async function clickTarget(
  page: Page,
  target: Target,
  options: ResolveOptions,
): Promise<string> {
  const { locator, via } = await resolve(page, target, options);
  await locator.click({ timeout: 10_000 });
  return via;
}

/** True when any candidate is present. Never throws. */
export async function isPresent(
  page: Page,
  target: Target,
  timeoutMs = 2_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (const candidate of target.candidates) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    try {
      const locator = toLocator(page, candidate).first();
      if (await locator.isVisible({ timeout: Math.min(750, remaining) })) return true;
    } catch {
      // Keep looking.
    }
  }
  return false;
}

/**
 * The page URL with any query string removed.
 *
 * Platform URLs carry one-time tokens and session identifiers in their query
 * strings, and this value ends up in step logs and error details. Stripping the
 * query is what keeps those out of the database.
 */
export function safeUrl(page: Page): string {
  try {
    const url = new URL(page.url());
    return `${url.origin}${url.pathname}`;
  } catch {
    return "unknown";
  }
}
