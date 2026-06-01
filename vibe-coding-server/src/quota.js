function remainingPercent(window) {
  if (!window) {
    return null;
  }

  return Math.max(0, Math.min(100, 100 - Math.round(window.usedPercent)));
}

export function createQuotaPayload(rateLimits, syncedAt = Math.floor(Date.now() / 1000), account = null) {
  return {
    limitId: rateLimits.limitId,
    email: account?.type === "chatgpt" ? account.email : null,
    planType: account?.type === "chatgpt" ? account.planType : (rateLimits.planType ?? null),
    fiveHourRemaining: remainingPercent(rateLimits.primary),
    fiveHourResetAt: rateLimits.primary?.resetsAt ?? null,
    weeklyRemaining: remainingPercent(rateLimits.secondary),
    weeklyResetAt: rateLimits.secondary?.resetsAt ?? null,
    syncedAt,
    stale: false,
  };
}
