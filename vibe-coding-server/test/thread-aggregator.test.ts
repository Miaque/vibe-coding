import assert from "node:assert/strict";
import test from "node:test";

import type { CodexStatus, NormalizedEvent, RateLimitSnapshot } from "../src/codex-state.js";
import { ThreadAggregator } from "../src/thread-aggregator.js";

function statusEvent(
  threadId: string,
  occurredAt: number,
  status: CodexStatus,
  turnId = "turn-1",
  fields: Partial<Pick<NormalizedEvent, "contextTokens" | "modelContextWindow">> = {},
): NormalizedEvent {
  return {
    kind: "status",
    threadId,
    sessionId: threadId,
    turnId,
    occurredAt,
    status,
    ...fields,
  };
}

type TokenEventFields = Partial<
  Pick<NormalizedEvent, "contextTokens" | "modelContextWindow" | "quota">
>;

function tokenEvent(
  threadId: string,
  occurredAt: number,
  turnId: string | null,
  fields: TokenEventFields = {
    contextTokens: 100,
    modelContextWindow: 1_000,
  },
): NormalizedEvent {
  return {
    kind: "token",
    threadId,
    sessionId: threadId,
    turnId,
    occurredAt,
    ...fields,
  };
}

test("ThreadAggregator 选择最新事件所属线程", () => {
  const aggregator = new ThreadAggregator();

  aggregator.apply(statusEvent("thread-a", 100, "WORKING"));
  aggregator.apply(statusEvent("thread-b", 110, "WAIT"));
  aggregator.apply(statusEvent("thread-a", 105, "IDLE"));

  assert.equal(aggregator.current()?.threadId, "thread-b");
  assert.equal(aggregator.current()?.status, "WAIT");
});

test("ThreadAggregator 忽略同一线程的旧状态事件", () => {
  const aggregator = new ThreadAggregator();

  aggregator.apply(statusEvent("thread-a", 100, "WORKING"));
  aggregator.apply(statusEvent("thread-a", 90, "IDLE"));

  assert.equal(aggregator.current()?.status, "WORKING");
  assert.equal(aggregator.current()?.lastEventAt, 100);
});

test("ThreadAggregator 使用接收顺序稳定处理同毫秒事件", () => {
  const aggregator = new ThreadAggregator();

  aggregator.apply(statusEvent("thread-a", 100, "WORKING"));
  aggregator.apply(statusEvent("thread-b", 100, "WAIT"));

  assert.equal(aggregator.current()?.threadId, "thread-b");
});

test("ThreadAggregator token 事件可切换活跃线程并更新上下文和配额", () => {
  const aggregator = new ThreadAggregator();
  const quota: RateLimitSnapshot = {
    limitId: "codex",
    primary: { usedPercent: 10 },
    secondary: null,
  };

  aggregator.apply(statusEvent("thread-a", 100, "WORKING"));
  aggregator.apply(tokenEvent("thread-b", 120, "turn-b", {
    quota,
    contextTokens: 100,
    modelContextWindow: 1_000,
  }));

  assert.deepEqual(aggregator.current(), {
    threadId: "thread-b",
    sessionId: "thread-b",
    source: null,
    status: "WORKING",
    turnId: "turn-b",
    lastEventAt: 120,
    contextTokens: 100,
    modelContextWindow: 1_000,
    quota,
  });
});

test("ThreadAggregator open turn token 将 WAIT 恢复为 WORKING", () => {
  const aggregator = new ThreadAggregator();

  aggregator.apply(statusEvent("thread-a", 100, "WAIT", "turn-a"));
  aggregator.apply(tokenEvent("thread-a", 110, "turn-a"));

  assert.equal(aggregator.current()?.status, "WORKING");
  assert.equal(aggregator.current()?.turnId, "turn-a");
});

test("ThreadAggregator 无 turn token 只更新数据不制造生命周期切换", () => {
  const aggregator = new ThreadAggregator();

  aggregator.apply(statusEvent("thread-a", 100, "WAIT", "turn-a"));
  aggregator.apply(tokenEvent("thread-a", 110, null));

  assert.equal(aggregator.current()?.status, "WAIT");
  assert.equal(aggregator.current()?.contextTokens, 100);
  assert.equal(aggregator.current()?.turnId, "turn-a");
});

test("ThreadAggregator 初始无 turn token 使用保守 IDLE 状态", () => {
  const aggregator = new ThreadAggregator();

  aggregator.apply(tokenEvent("thread-a", 100, null));

  assert.equal(aggregator.current()?.threadId, "thread-a");
  assert.equal(aggregator.current()?.status, "IDLE");
  assert.equal(aggregator.current()?.turnId, null);
  assert.equal(aggregator.current()?.contextTokens, 100);
});

test("ThreadAggregator setSource 不改变当前线程选择", () => {
  const aggregator = new ThreadAggregator();

  aggregator.apply(statusEvent("thread-a", 100, "WORKING"));
  aggregator.apply(statusEvent("thread-b", 110, "WAIT"));
  const enriched = aggregator.setSource("thread-a", "desktop");

  assert.equal(enriched?.source, "desktop");
  assert.equal(enriched?.lastEventAt, 100);
  assert.equal(aggregator.current()?.threadId, "thread-b");
});

test("ThreadAggregator 返回快照不会暴露内部排序状态", () => {
  const aggregator = new ThreadAggregator();
  const quota: RateLimitSnapshot = {
    limitId: "codex",
    primary: { usedPercent: 10 },
    secondary: null,
  };

  aggregator.apply(tokenEvent("thread-a", 100, "turn-a", {
    quota,
    contextTokens: 100,
    modelContextWindow: 1_000,
  }));
  const snapshot = aggregator.current();
  assert.notEqual(snapshot, null);

  snapshot.lastEventAt = 1_000;
  snapshot.quota!.primary!.usedPercent = 90;

  const current = aggregator.current();
  assert.equal(current?.lastEventAt, 100);
  assert.equal(current?.quota?.primary?.usedPercent, 10);
});

test("ThreadAggregator token 字段缺席时保留已有快照数据", () => {
  const aggregator = new ThreadAggregator();
  const quota: RateLimitSnapshot = {
    limitId: "codex",
    primary: { usedPercent: 10 },
    secondary: null,
  };

  aggregator.apply(tokenEvent("thread-a", 100, "turn-a", {
    contextTokens: 100,
    modelContextWindow: 1_000,
    quota,
  }));
  aggregator.apply(tokenEvent("thread-a", 110, "turn-a", {}));

  assert.equal(aggregator.current()?.contextTokens, 100);
  assert.equal(aggregator.current()?.modelContextWindow, 1_000);
  assert.deepEqual(aggregator.current()?.quota, quota);
});

test("ThreadAggregator token 显式 null 会清空配额", () => {
  const aggregator = new ThreadAggregator();
  const quota: RateLimitSnapshot = {
    limitId: "codex",
    primary: { usedPercent: 10 },
    secondary: null,
  };

  aggregator.apply(tokenEvent("thread-a", 100, "turn-a", {
    contextTokens: 100,
    modelContextWindow: 1_000,
    quota,
  }));
  aggregator.apply(tokenEvent("thread-a", 110, "turn-a", { quota: null }));

  assert.equal(aggregator.current()?.quota, null);
  assert.equal(aggregator.current()?.contextTokens, 100);
  assert.equal(aggregator.current()?.modelContextWindow, 1_000);
});

test("ThreadAggregator status 事件可更新模型上下文窗口", () => {
  const aggregator = new ThreadAggregator();

  aggregator.apply(statusEvent("thread-a", 100, "WORKING", "turn-a", {
    modelContextWindow: 1_000,
  }));

  assert.equal(aggregator.current()?.modelContextWindow, 1_000);
});

test("ThreadAggregator 拒绝非监控事件", () => {
  const aggregator = new ThreadAggregator();
  aggregator.apply(statusEvent("thread-a", 100, "WORKING"));

  const result = aggregator.apply({
    kind: "account",
    threadId: "thread-b",
    sessionId: "thread-b",
    turnId: null,
    occurredAt: 200,
  } as unknown as NormalizedEvent);

  assert.equal(result, null);
  assert.equal(aggregator.current()?.threadId, "thread-a");
});

test("ThreadAggregator 拒绝缺少 status 的状态事件", () => {
  const aggregator = new ThreadAggregator();
  aggregator.apply(statusEvent("thread-a", 100, "WORKING"));

  const result = aggregator.apply({
    kind: "status",
    threadId: "thread-b",
    sessionId: "thread-b",
    turnId: "turn-b",
    occurredAt: 200,
  });

  assert.equal(result, null);
  assert.equal(aggregator.current()?.threadId, "thread-a");
});

test("ThreadAggregator PermissionRequest 和 task_complete 状态按事件时间生效", () => {
  const aggregator = new ThreadAggregator();

  aggregator.apply(statusEvent("thread-a", 100, "WAIT", "turn-a"));
  aggregator.apply(statusEvent("thread-a", 120, "IDLE", "turn-a"));
  aggregator.apply(statusEvent("thread-b", 110, "ERROR", "turn-b"));

  assert.equal(aggregator.current()?.threadId, "thread-a");
  assert.equal(aggregator.current()?.status, "IDLE");
});
