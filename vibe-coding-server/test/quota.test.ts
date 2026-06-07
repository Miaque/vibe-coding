import assert from "node:assert/strict";
import test from "node:test";

import { remainingPercent } from "../src/codex-state.js";
import type { RateLimits } from "../src/quota.js";

test("RateLimits 复用 Codex 状态配额结构", () => {
  const rateLimits: RateLimits = {
    limitId: "codex",
    primary: {
      usedPercent: 28,
      resetsAt: 1780331108,
    },
    secondary: {
      usedPercent: 59,
      resetsAt: 1780917908,
    },
  };

  assert.equal(remainingPercent(rateLimits.primary), 72);
  assert.equal(remainingPercent(rateLimits.secondary), 41);
});

test("RateLimits 允许缺失窗口并沿用剩余额度边界", () => {
  const rateLimits: RateLimits = {
    limitId: null,
    primary: {
      usedPercent: 101,
      resetsAt: null,
    },
    secondary: null,
  };

  assert.equal(remainingPercent(rateLimits.primary), 0);
  assert.equal(remainingPercent(rateLimits.secondary), null);
});
