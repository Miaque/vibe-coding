import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import type { AccountResolution } from "../src/account-resolver.js";
import type { CodexSource, DisplayState, NormalizedEvent } from "../src/codex-state.js";
import { MonitorService } from "../src/monitor-service.js";
import { ThreadAggregator } from "../src/thread-aggregator.js";
import type { SessionMetadata } from "../src/session-events.js";

type FakeProducer = EventEmitter & {
  startCount: number;
  stopCount: number;
  scanOnceCount: number;
  start: () => Promise<void>;
  stop: () => void;
  scanOnce: () => Promise<void>;
};

type FakeResolver = EventEmitter & {
  current: AccountResolution | null;
  resolveCalls: unknown[];
  resolve: (thread: unknown) => AccountResolution | null;
  setCurrent: (resolution: AccountResolution | null) => void;
};

function makeProducer(): FakeProducer {
  const producer = new EventEmitter() as FakeProducer;
  producer.startCount = 0;
  producer.stopCount = 0;
  producer.scanOnceCount = 0;
  producer.start = async () => {
    producer.startCount += 1;
  };
  producer.stop = () => {
    producer.stopCount += 1;
  };
  producer.scanOnce = async () => {
    producer.scanOnceCount += 1;
  };
  return producer;
}

function makeResolver(initial: AccountResolution | null = null): FakeResolver {
  const resolver = new EventEmitter() as FakeResolver;
  resolver.current = initial;
  resolver.resolveCalls = [];
  resolver.resolve = (thread) => {
    resolver.resolveCalls.push(thread);
    return resolver.current;
  };
  resolver.setCurrent = (resolution) => {
    resolver.current = resolution;
    if (resolution) {
      resolver.emit("resolved", resolution);
    }
  };
  return resolver;
}

function state(fields: Partial<DisplayState> = {}): DisplayState {
  return {
    version: 1,
    threadId: "thread-1",
    sessionId: "session-1",
    source: "desktop",
    status: "WORKING",
    email: "cached@example.com",
    accountStale: true,
    fiveHourRemaining: 72,
    weeklyRemaining: 41,
    contextUsedPercent: 25,
    contextTokens: 250,
    modelContextWindow: 1000,
    updatedAt: 100,
    ...fields,
  };
}

function resolution(email: string, stale = false): AccountResolution {
  return {
    email,
    planType: "plus",
    resolvedAt: 123,
    stale,
  };
}

function statusEvent(
  threadId: string,
  occurredAt: number,
  source: CodexSource | undefined = "desktop",
  status: NormalizedEvent["status"] = "WORKING",
): NormalizedEvent {
  return {
    kind: "status",
    threadId,
    sessionId: threadId,
    turnId: "turn-1",
    occurredAt,
    source,
    status,
  };
}

function tokenEvent(
  threadId: string,
  occurredAt: number,
  source: CodexSource | undefined = "desktop",
  fields: Partial<Pick<NormalizedEvent, "contextTokens" | "modelContextWindow" | "quota">> = {},
): NormalizedEvent {
  return {
    kind: "token",
    threadId,
    sessionId: threadId,
    turnId: "turn-1",
    occurredAt,
    source,
    contextTokens: 500,
    modelContextWindow: 1000,
    quota: {
      limitId: "codex",
      primary: { usedPercent: 10 },
      secondary: { usedPercent: 80 },
    },
    ...fields,
  };
}

function metadata(threadId: string, source: CodexSource): SessionMetadata {
  return {
    threadId,
    sessionId: threadId,
    source,
  };
}

function makeHarness(options: {
  cached?: DisplayState | null;
  account?: AccountResolution | null;
  publishState?: (state: DisplayState) => Promise<void>;
  saveCache?: (state: DisplayState) => Promise<void>;
} = {}) {
  const sessionWatcher = makeProducer();
  const hookInbox = makeProducer();
  const resolver = makeResolver(options.account ?? null);
  const publishedStates: DisplayState[] = [];
  const savedStates: DisplayState[] = [];
  const availability: Array<"online" | "offline"> = [];
  const service = new MonitorService({
    sessionWatcher,
    hookInbox,
    aggregator: new ThreadAggregator(),
    accountResolver: resolver,
    loadCache: async () => options.cached ?? null,
    saveCache: options.saveCache ?? (async (next) => {
      savedStates.push(next);
    }),
    publishState: options.publishState ?? (async (next) => {
      publishedStates.push(next);
    }),
    publishAvailability: async (value) => {
      availability.push(value);
    },
  });

  return {
    service,
    sessionWatcher,
    hookInbox,
    resolver,
    publishedStates,
    savedStates,
    availability,
  };
}

async function flushAsyncWork(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test("MonitorService 启动时优先发布缓存状态并标记账号 stale", async () => {
  const cached = state({ accountStale: false });
  const harness = makeHarness({ cached });

  await harness.service.start();

  assert.equal(harness.publishedStates.length, 1);
  assert.deepEqual(harness.publishedStates[0], { ...cached, accountStale: true });
  assert.equal(harness.sessionWatcher.startCount, 1);
  assert.equal(harness.hookInbox.startCount, 1);
});

test("MonitorService 无缓存启动时在解析出 email 前不发布状态", async () => {
  const harness = makeHarness();

  await harness.service.start();
  harness.sessionWatcher.emit("event", statusEvent("thread-1", 100));
  await flushAsyncWork();
  harness.resolver.setCurrent(resolution("user@example.com"));
  await flushAsyncWork();

  assert.equal(harness.publishedStates.length, 1);
  assert.equal(harness.publishedStates[0].email, "user@example.com");
});

test("MonitorService session metadata 只设置来源且不切换当前线程", async () => {
  const harness = makeHarness({ account: resolution("user@example.com") });

  await harness.service.start();
  harness.sessionWatcher.emit("event", statusEvent("thread-new", 200, "desktop", "WAIT"));
  harness.sessionWatcher.emit("event", statusEvent("thread-old", 100, undefined, "WORKING"));
  harness.sessionWatcher.emit("metadata", metadata("thread-old", "cli"));
  await flushAsyncWork();

  assert.equal(harness.publishedStates.at(-1)?.threadId, "thread-new");
  assert.equal(harness.publishedStates.at(-1)?.status, "WAIT");
});

test("MonitorService 在 metadata 到达前保留 hook 状态但不发布", async () => {
  const harness = makeHarness({ account: resolution("user@example.com") });

  await harness.service.start();
  harness.hookInbox.emit("event", statusEvent("thread-1", 100, undefined, "WAIT"));
  await flushAsyncWork();
  harness.sessionWatcher.emit("metadata", metadata("thread-1", "desktop"));
  await flushAsyncWork();

  assert.equal(harness.publishedStates.length, 1);
  assert.equal(harness.publishedStates[0].status, "WAIT");
  assert.equal(harness.publishedStates[0].source, "desktop");
});

test("MonitorService hook WAIT 在同一轮事件循环内发布", async () => {
  const harness = makeHarness({ account: resolution("user@example.com") });

  await harness.service.start();
  harness.hookInbox.emit("event", statusEvent("thread-1", 100, "desktop", "WAIT"));
  await flushAsyncWork();

  assert.equal(harness.publishedStates.length, 1);
  assert.equal(harness.publishedStates[0].status, "WAIT");
});

test("MonitorService token 事件使用事件内配额和上下文更新 DisplayState 并重新检查账号", async () => {
  const harness = makeHarness({ account: resolution("user@example.com") });

  await harness.service.start();
  harness.sessionWatcher.emit("event", statusEvent("thread-1", 100));
  await flushAsyncWork();
  const resolveCallCount = harness.resolver.resolveCalls.length;
  harness.sessionWatcher.emit("event", tokenEvent("thread-1", 110));
  await flushAsyncWork();

  assert.equal(harness.publishedStates.at(-1)?.fiveHourRemaining, 90);
  assert.equal(harness.publishedStates.at(-1)?.weeklyRemaining, 20);
  assert.equal(harness.publishedStates.at(-1)?.contextUsedPercent, 50);
  assert.equal(harness.resolver.resolveCalls.length, resolveCallCount + 1);
  assert.deepEqual(
    (harness.resolver.resolveCalls.at(-1) as { quota: unknown }).quota,
    tokenEvent("thread-1", 110).quota,
  );
});

test("MonitorService stale 账号在同线程首次获得 quota 时重新解析账号", async () => {
  const harness = makeHarness({ account: resolution("old@example.com", true) });

  await harness.service.start();
  harness.sessionWatcher.emit("event", statusEvent("thread-1", 100));
  await flushAsyncWork();
  assert.equal(harness.resolver.resolveCalls.length, 1);

  harness.sessionWatcher.emit("event", tokenEvent("thread-1", 110));
  await flushAsyncWork();

  assert.equal(harness.resolver.resolveCalls.length, 2);
  assert.equal(harness.publishedStates.at(-1)?.fiveHourRemaining, 90);
  assert.equal(harness.publishedStates.at(-1)?.contextUsedPercent, 50);
});

test("MonitorService 同线程后续 token quota 和 CTX 更新会重新检查账号", async () => {
  const harness = makeHarness({ account: resolution("old@example.com", true) });

  await harness.service.start();
  harness.sessionWatcher.emit("event", statusEvent("thread-1", 100));
  await flushAsyncWork();
  harness.sessionWatcher.emit("event", tokenEvent("thread-1", 110));
  await flushAsyncWork();
  const resolveCallCount = harness.resolver.resolveCalls.length;

  harness.sessionWatcher.emit("event", tokenEvent("thread-1", 120, "desktop", {
    contextTokens: 750,
    quota: {
      limitId: "codex",
      primary: { usedPercent: 20 },
      secondary: { usedPercent: 70 },
    },
  }));
  await flushAsyncWork();

  assert.equal(harness.resolver.resolveCalls.length, resolveCallCount + 1);
  assert.equal(harness.publishedStates.at(-1)?.fiveHourRemaining, 80);
  assert.equal(harness.publishedStates.at(-1)?.contextUsedPercent, 75);
});

test("MonitorService 账号解析完成后用已验证邮箱重发当前线程", async () => {
  const harness = makeHarness({ account: resolution("old@example.com", true) });

  await harness.service.start();
  harness.sessionWatcher.emit("event", statusEvent("thread-1", 100));
  await flushAsyncWork();
  harness.resolver.setCurrent(resolution("verified@example.com"));
  await flushAsyncWork();

  assert.equal(harness.publishedStates.length, 2);
  assert.equal(harness.publishedStates[0].email, "old@example.com");
  assert.equal(harness.publishedStates[0].accountStale, true);
  assert.equal(harness.publishedStates[1].email, "verified@example.com");
  assert.equal(harness.publishedStates[1].accountStale, false);
});

test("MonitorService 不重复发布完全相同的 DisplayState", async () => {
  const harness = makeHarness({ account: resolution("user@example.com") });

  await harness.service.start();
  harness.sessionWatcher.emit("event", statusEvent("thread-1", 100));
  harness.sessionWatcher.emit("event", statusEvent("thread-1", 100));
  await flushAsyncWork();

  assert.equal(harness.publishedStates.length, 1);
  assert.equal(harness.savedStates.length, 1);
});

test("MonitorService publishState 失败后相同 DisplayState 会再次尝试发布", async () => {
  let publishCalls = 0;
  const harness = makeHarness({
    account: resolution("user@example.com"),
    publishState: async (next) => {
      publishCalls += 1;
      if (publishCalls === 1) {
        throw new Error("MQTT publish failed");
      }
      harness.publishedStates.push(next);
    },
  });

  await harness.service.start();
  harness.sessionWatcher.emit("event", statusEvent("thread-1", 100));
  await flushAsyncWork();
  harness.sessionWatcher.emit("event", statusEvent("thread-1", 100));
  await flushAsyncWork();

  assert.equal(publishCalls, 2);
  assert.equal(harness.publishedStates.length, 1);
});

test("MonitorService stop 发布 offline 并停止所有 watcher", async () => {
  const harness = makeHarness({ account: resolution("user@example.com") });

  await harness.service.start();
  await harness.service.stop();

  assert.deepEqual(harness.availability, ["offline"]);
  assert.equal(harness.sessionWatcher.stopCount, 1);
  assert.equal(harness.hookInbox.stopCount, 1);
});
