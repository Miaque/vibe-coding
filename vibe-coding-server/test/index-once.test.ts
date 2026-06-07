import assert from "node:assert/strict";
import test from "node:test";

import type { AccountSnapshot } from "../src/account-resolver.js";
import type { RateLimitSnapshot } from "../src/codex-state.js";
import { createOnceDisplayState } from "../src/index-once.js";
import type { ThreadSnapshot } from "../src/thread-aggregator.js";

function quota(primaryUsed: number): RateLimitSnapshot {
  return {
    limitId: "codex",
    primary: { usedPercent: primaryUsed, resetsAt: 1780331108 },
    secondary: { usedPercent: 59, resetsAt: 1780917908 },
  };
}

function thread(rateLimits: RateLimitSnapshot | null = quota(28)): ThreadSnapshot {
  return {
    threadId: "thread-1",
    sessionId: "thread-1",
    source: "cli",
    status: "WORKING",
    turnId: "turn-1",
    lastEventAt: 1780000000000,
    contextTokens: 250,
    modelContextWindow: 1000,
    quota: rateLimits,
  };
}

function account(rateLimits: RateLimitSnapshot): AccountSnapshot {
  return {
    email: "user@example.com",
    planType: "plus",
    quota: rateLimits,
    resolvedAt: 1780000001000,
  };
}

test("createOnceDisplayState 在 thread 配额与账号配额不匹配时拒绝输出 stale 状态", () => {
  assert.throws(
    () => createOnceDisplayState(thread(quota(28)), account(quota(63))),
    /最新 Codex thread 与当前账号配额不匹配/,
  );
});

test("createOnceDisplayState 在配额匹配时输出非 stale 状态", () => {
  const state = createOnceDisplayState(thread(quota(28)), account(quota(29)));

  assert.equal(state.email, "user@example.com");
  assert.equal(state.accountStale, false);
  assert.equal(state.fiveHourRemaining, 72);
});

test("createOnceDisplayState 在线程没有配额时使用账号配额并输出非 stale 状态", () => {
  const state = createOnceDisplayState(thread(null), account(quota(63)));

  assert.equal(state.accountStale, false);
  assert.equal(state.fiveHourRemaining, 37);
});
