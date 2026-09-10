"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getCurrentUser, login, logout } from "@/server/auth/session";
import { activityActions, recordActivitySafe } from "@/server/activity/log";
import { ActorType } from "@/generated/prisma/enums";

/**
 * Sign-in and sign-out.
 *
 * Sign-in is rate limited per client address. The limiter is process-local, which
 * is the right scope for a single-operator console — a multi-instance deployment
 * would move it to Redis.
 */

const MAX_ATTEMPTS = 8;
const WINDOW_MS = 10 * 60 * 1000;

const attempts = new Map<string, { count: number; firstAt: number }>();

function rateLimit(key: string): { allowed: boolean; retryInMinutes: number } {
  const now = Date.now();
  const record = attempts.get(key);

  if (!record || now - record.firstAt > WINDOW_MS) {
    attempts.set(key, { count: 1, firstAt: now });
    return { allowed: true, retryInMinutes: 0 };
  }

  record.count += 1;
  if (record.count > MAX_ATTEMPTS) {
    return {
      allowed: false,
      retryInMinutes: Math.ceil((WINDOW_MS - (now - record.firstAt)) / 60_000),
    };
  }
  return { allowed: true, retryInMinutes: 0 };
}

function clearRateLimit(key: string): void {
  attempts.delete(key);
}

const loginSchema = z.object({
  email: z.string().trim().min(3).max(200),
  password: z.string().min(1).max(400),
  next: z.string().optional(),
});

export type LoginState = { error: string | null };

export async function loginAction(
  _previous: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const parsed = loginSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
    next: formData.get("next") ?? undefined,
  });

  if (!parsed.success) {
    return { error: "Enter an email address and a password." };
  }

  const headerList = await headers();
  const clientKey =
    headerList.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";

  const limit = rateLimit(clientKey);
  if (!limit.allowed) {
    return {
      error: `Too many attempts. Try again in ${limit.retryInMinutes} minute${
        limit.retryInMinutes === 1 ? "" : "s"
      }.`,
    };
  }

  const result = await login({
    email: parsed.data.email,
    password: parsed.data.password,
    userAgent: headerList.get("user-agent"),
    ipAddress: clientKey === "local" ? null : clientKey,
  });

  if (!result.ok) {
    // Deliberately generic: never disclose whether the account exists.
    return { error: "That email and password do not match." };
  }

  clearRateLimit(clientKey);

  await recordActivitySafe({
    action: activityActions.userSignedIn,
    message: `${result.user.name} signed in`,
    userId: result.user.id,
    actorType: ActorType.USER,
  });

  // Only relative in-app paths, so the form cannot be used as an open redirect.
  const target =
    parsed.data.next && /^\/[A-Za-z0-9\-_/]*$/.test(parsed.data.next)
      ? parsed.data.next
      : "/";
  redirect(target);
}

export async function logoutAction(): Promise<void> {
  const user = await getCurrentUser();
  await logout();
  if (user) {
    await recordActivitySafe({
      action: activityActions.userSignedOut,
      message: `${user.name} signed out`,
      userId: user.id,
      actorType: ActorType.USER,
    });
  }
  redirect("/login");
}
