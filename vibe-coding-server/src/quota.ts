import type { RateLimitSnapshot, RateLimitWindow } from "./codex-state.js";

export type RateLimits = RateLimitSnapshot;
export type { RateLimitWindow };

export type Account = {
  type: string;
  email?: string | null;
  planType?: string | null;
} | null;
