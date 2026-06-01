import assert from "node:assert/strict";
import test from "node:test";

import { createQuotaPayload } from "../src/quota.js";

test("createQuotaPayload converts used percentages to remaining percentages", () => {
  const payload = createQuotaPayload(
    {
      limitId: "codex",
      primary: {
        usedPercent: 28,
        windowDurationMins: 300,
        resetsAt: 1780331108,
      },
      secondary: {
        usedPercent: 59,
        windowDurationMins: 10080,
        resetsAt: 1780917908,
      },
    },
    1780000000,
    { type: "chatgpt", email: "user@example.com", planType: "plus" },
  );

  assert.deepEqual(payload, {
    limitId: "codex",
    email: "user@example.com",
    planType: "plus",
    fiveHourRemaining: 72,
    fiveHourResetAt: 1780331108,
    weeklyRemaining: 41,
    weeklyResetAt: 1780917908,
    syncedAt: 1780000000,
    stale: false,
  });
});

test("createQuotaPayload clamps remaining percentages and preserves missing windows", () => {
  const payload = createQuotaPayload(
    {
      limitId: null,
      primary: {
        usedPercent: 101,
        windowDurationMins: 300,
        resetsAt: null,
      },
      secondary: null,
    },
    1780000000,
  );

  assert.deepEqual(payload, {
    limitId: null,
    email: null,
    planType: null,
    fiveHourRemaining: 0,
    fiveHourResetAt: null,
    weeklyRemaining: null,
    weeklyResetAt: null,
    syncedAt: 1780000000,
    stale: false,
  });
});
