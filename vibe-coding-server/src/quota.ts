export type RateLimitWindow = {
  usedPercent: number;
  resetsAt?: number | null;
};

export type RateLimits = {
  limitId: string | null;
  planType?: string | null;
  primary?: RateLimitWindow | null;
  secondary?: RateLimitWindow | null;
};

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

function remainingPercent(window: RateLimitWindow | null | undefined): number | null {
  if (!window) {
    return null;
  }

  return Math.max(0, Math.min(100, 100 - Math.round(window.usedPercent)));
}

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
