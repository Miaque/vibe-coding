import assert from "node:assert/strict";
import test from "node:test";
import { contextPercent, createDisplayState, remainingPercent } from "../src/codex-state.js";

test("contextPercent 使用最近一次 token usage，而不是会话总量", () => {
  assert.equal(contextPercent(64_600, 258_400), 25);
  assert.equal(contextPercent(null, 258_400), null);
  assert.equal(contextPercent(1, null), null);
});

test("remainingPercent 会限制 used percentage", () => {
  assert.equal(remainingPercent({ usedPercent: 28 }), 72);
  assert.equal(remainingPercent({ usedPercent: 101 }), 0);
  assert.equal(remainingPercent(null), null);
});

test("createDisplayState 要求非空 email", () => {
  assert.throws(() => createDisplayState({
    threadId: "thread-1", sessionId: "session-1", source: "desktop",
    status: "WORKING", email: "", accountStale: false, quota: null,
    contextTokens: null, modelContextWindow: null, updatedAt: 1,
  }), /email/);
});
