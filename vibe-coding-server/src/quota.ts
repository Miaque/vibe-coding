import { remainingPercent } from "./codex-state.js";
import type { RateLimitSnapshot, RateLimitWindow } from "./codex-state.js";

export type RateLimits = RateLimitSnapshot;
export type { RateLimitWindow };

export type Account = {
  type: string;
  email?: string | null;
  planType?: string | null;
} | null;

export type QuotaPayload = {
  limitId: string | null;
  email: string | null;
  planType: string | null;
  fiveHourRemaining: number | null;
  fiveHourResetAt: number | null;
  weeklyRemaining: number | null;
  weeklyResetAt: number | null;
  syncedAt: number;
  stale: boolean;
};

export function createQuotaPayload(
  rateLimits: RateLimits,
  syncedAt = Math.floor(Date.now() / 1000),
  account: Account = null,
): QuotaPayload {
  return {
    limitId: rateLimits.limitId,
    email: account?.type === "chatgpt" ? (account.email ?? null) : null,
    planType: account?.type === "chatgpt" ? (account.planType ?? null) : (rateLimits.planType ?? null),
    fiveHourRemaining: remainingPercent(rateLimits.primary),
    fiveHourResetAt: rateLimits.primary?.resetsAt ?? null,
    weeklyRemaining: remainingPercent(rateLimits.secondary),
    weeklyResetAt: rateLimits.secondary?.resetsAt ?? null,
    syncedAt,
    stale: false,
  };
}
