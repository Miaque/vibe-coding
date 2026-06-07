export type CodexStatus = "IDLE" | "WORKING" | "WAIT" | "ERROR";

export type CodexSource = "desktop" | "cli";

export type RateLimitWindow = {
  usedPercent: number;
  resetsAt?: number | null;
};

export type RateLimitSnapshot = {
  limitId: string | null;
  planType?: string | null;
  primary?: RateLimitWindow | null;
  secondary?: RateLimitWindow | null;
};

export type NormalizedEvent = {
  kind: "status" | "token";
  threadId: string;
  sessionId: string;
  turnId: string | null;
  occurredAt: number;
  source?: CodexSource;
  status?: CodexStatus;
  contextTokens?: number | null;
  modelContextWindow?: number | null;
  quota?: RateLimitSnapshot | null;
};

export type DisplayState = {
  version: 1;
  threadId: string;
  sessionId: string;
  source: CodexSource;
  status: CodexStatus;
  email: string;
  accountStale: boolean;
  fiveHourRemaining: number | null;
  weeklyRemaining: number | null;
  contextUsedPercent: number | null;
  contextTokens: number | null;
  modelContextWindow: number | null;
  updatedAt: number;
};

export function contextPercent(tokens: number | null, window: number | null): number | null {
  if (tokens === null || window === null || window <= 0) {
    return null;
  }

  return Math.max(0, Math.min(100, Math.round((tokens / window) * 100)));
}

export function remainingPercent(window: RateLimitWindow | null | undefined): number | null {
  if (!window) {
    return null;
  }

  return Math.max(0, Math.min(100, 100 - Math.round(window.usedPercent)));
}

export function createDisplayState(input: {
  threadId: string;
  sessionId: string;
  source: CodexSource;
  status: CodexStatus;
  email: string;
  accountStale: boolean;
  quota: RateLimitSnapshot | null;
  contextTokens: number | null;
  modelContextWindow: number | null;
  updatedAt: number;
}): DisplayState {
  if (input.email.trim() === "") {
    throw new Error("email 不能为空");
  }

  return {
    version: 1,
    threadId: input.threadId,
    sessionId: input.sessionId,
    source: input.source,
    status: input.status,
    email: input.email,
    accountStale: input.accountStale,
    fiveHourRemaining: remainingPercent(input.quota?.primary),
    weeklyRemaining: remainingPercent(input.quota?.secondary),
    contextUsedPercent: contextPercent(input.contextTokens, input.modelContextWindow),
    contextTokens: input.contextTokens,
    modelContextWindow: input.modelContextWindow,
    updatedAt: input.updatedAt,
  };
}
