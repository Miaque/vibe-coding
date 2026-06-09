import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import type { AccountRefresh, AccountResolution } from "../src/account-resolver.js";
import type {
  CodexSource,
  DisplayState,
  NormalizedEvent,
  RateLimitSnapshot,
} from "../src/codex-state.js";
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
  refreshCalls: unknown[];
  resolve: (thread: unknown) => AccountResolution | null;
  refresh: (thread: unknown) => Promise<AccountRefresh | null>;
  setCurrent: (resolution: AccountResolution | null) => void;
};

function makeProducer(onStart?: () => void): FakeProducer {
  const producer = new EventEmitter() as FakeProducer;
  producer.startCount = 0;
  producer.stopCount = 0;
  producer.scanOnceCount = 0;
  producer.start = async () => {
    producer.startCount += 1;
    onStart?.();
  };
  producer.stop = () => {
    producer.stopCount += 1;
  };
  producer.scanOnce = async () => {
    producer.scanOnceCount += 1;
  };
  return producer;
}

function makeResolver(
  initial: AccountResolution | null = null,
  refresh?: (thread: unknown) => Promise<AccountRefresh | null>,
): FakeResolver {
  const resolver = new EventEmitter() as FakeResolver;
  resolver.current = initial;
  resolver.resolveCalls = [];
  resolver.refreshCalls = [];
  resolver.resolve = (thread) => {
    resolver.resolveCalls.push(thread);
    return resolver.current;
  };
  resolver.refresh = async (thread) => {
    resolver.refreshCalls.push(thread);
    if (refresh) {
      return refresh(thread);
    }
    return resolver.current
      ? refreshed(resolver.current.email, quota(), resolver.current.stale)
      : null;
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

function quota(primaryUsed = 10, secondaryUsed = 80): RateLimitSnapshot {
  return {
    limitId: "codex",
    primary: { usedPercent: primaryUsed },
    secondary: { usedPercent: secondaryUsed },
  };
}

function refreshed(
  email: string,
  refreshedQuota: RateLimitSnapshot,
  stale = false,
): AccountRefresh {
  return {
    ...resolution(email, stale),
    quota: refreshedQuota,
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
  onSessionStart?: (sessionWatcher: FakeProducer) => void;
  onHookStart?: (hookInbox: FakeProducer) => void;
  publishState?: (state: DisplayState) => Promise<void>;
  saveCache?: (state: DisplayState) => Promise<void>;
  refresh?: (thread: unknown) => Promise<AccountRefresh | null>;
  refreshTimeoutMs?: number;
} = {}) {
  let sessionWatcher: FakeProducer;
  let hookInbox: FakeProducer;
  sessionWatcher = makeProducer(() => options.onSessionStart?.(sessionWatcher));
  hookInbox = makeProducer(() => options.onHookStart?.(hookInbox));
  const resolver = makeResolver(options.account ?? null, options.refresh);
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
    refreshTimeoutMs: options.refreshTimeoutMs,
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

async function wait(delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

test("MonitorService 状态变化等待刷新后发布最新完整快照", async () => {
  let completeRefresh: ((value: AccountRefresh) => void) | undefined;
  const refreshResult = new Promise<AccountRefresh>((resolve) => {
    completeRefresh = resolve;
  });
  const harness = makeHarness({
    account: resolution("old@example.com"),
    refresh: () => refreshResult,
  });

  await harness.service.start();
  harness.hookInbox.emit("event", statusEvent("thread-1", 100, "desktop", "WAIT"));
  await flushAsyncWork();

  assert.equal(harness.publishedStates.length, 0);

  completeRefresh?.(refreshed("new@example.com", quota(30, 40)));
  await flushAsyncWork();

  assert.equal(harness.publishedStates.length, 1);
  assert.equal(harness.publishedStates[0].status, "WAIT");
  assert.equal(harness.publishedStates[0].email, "new@example.com");
  assert.equal(harness.publishedStates[0].fiveHourRemaining, 70);
  assert.equal(harness.publishedStates[0].weeklyRemaining, 60);
});

test("MonitorService 刷新超时后发布 stale 快照并在完成后纠正", async () => {
  let completeRefresh: ((value: AccountRefresh) => void) | undefined;
  const refreshResult = new Promise<AccountRefresh>((resolve) => {
    completeRefresh = resolve;
  });
  const harness = makeHarness({
    account: resolution("old@example.com"),
    refresh: () => refreshResult,
    refreshTimeoutMs: 10,
  });

  await harness.service.start();
  harness.sessionWatcher.emit("event", tokenEvent("thread-1", 90));
  await flushAsyncWork();
  harness.publishedStates.length = 0;

  harness.hookInbox.emit("event", statusEvent("thread-1", 100, "desktop", "WAIT"));
  await wait(20);

  assert.equal(harness.publishedStates.length, 1);
  assert.equal(harness.publishedStates[0].status, "WAIT");
  assert.equal(harness.publishedStates[0].email, "old@example.com");
  assert.equal(harness.publishedStates[0].accountStale, true);
  assert.equal(harness.publishedStates[0].fiveHourRemaining, 90);
  assert.equal(harness.publishedStates[0].weeklyRemaining, 20);

  completeRefresh?.(refreshed("new@example.com", quota(30, 40)));
  await flushAsyncWork();

  assert.equal(harness.publishedStates.length, 2);
  assert.equal(harness.publishedStates[1].email, "new@example.com");
  assert.equal(harness.publishedStates[1].accountStale, false);
  assert.equal(harness.publishedStates[1].fiveHourRemaining, 70);
  assert.equal(harness.publishedStates[1].weeklyRemaining, 60);
});

test("MonitorService 同一刷新期间合并状态并只发布最后状态", async () => {
  let completeRefresh: ((value: AccountRefresh) => void) | undefined;
  const refreshResult = new Promise<AccountRefresh>((resolve) => {
    completeRefresh = resolve;
  });
  const harness = makeHarness({
    account: resolution("user@example.com"),
    refresh: () => refreshResult,
  });

  await harness.service.start();
  harness.hookInbox.emit("event", statusEvent("thread-1", 100, "desktop", "WORKING"));
  harness.hookInbox.emit("event", statusEvent("thread-1", 110, "desktop", "WAIT"));
  harness.hookInbox.emit("event", statusEvent("thread-1", 120, "desktop", "IDLE"));
  await flushAsyncWork();

  assert.equal(harness.resolver.refreshCalls.length, 1);
  assert.equal(harness.publishedStates.length, 0);

  completeRefresh?.(refreshed("user@example.com", quota()));
  await flushAsyncWork();

  assert.equal(harness.publishedStates.length, 1);
  assert.equal(harness.publishedStates[0].status, "IDLE");
});

test("MonitorService 切换线程时丢弃旧刷新结果并刷新新线程", async () => {
  let completeDesktop: ((value: AccountRefresh) => void) | undefined;
  let completeCli: ((value: AccountRefresh) => void) | undefined;
  const desktopRefresh = new Promise<AccountRefresh>((resolve) => {
    completeDesktop = resolve;
  });
  const cliRefresh = new Promise<AccountRefresh>((resolve) => {
    completeCli = resolve;
  });
  const harness = makeHarness({
    account: resolution("old@example.com"),
    refresh: (thread) => (
      (thread as { source: CodexSource }).source === "desktop"
        ? desktopRefresh
        : cliRefresh
    ),
  });

  await harness.service.start();
  harness.hookInbox.emit("event", statusEvent("desktop-thread", 100, "desktop", "WORKING"));
  harness.hookInbox.emit("event", statusEvent("cli-thread", 110, "cli", "WAIT"));
  completeDesktop?.(refreshed("desktop@example.com", quota(10, 20)));
  await flushAsyncWork();

  assert.equal(harness.publishedStates.length, 0);
  assert.equal(harness.resolver.refreshCalls.length, 2);

  completeCli?.(refreshed("cli@example.com", quota(30, 40)));
  await flushAsyncWork();

  assert.equal(harness.publishedStates.length, 1);
  assert.equal(harness.publishedStates[0].threadId, "cli-thread");
  assert.equal(harness.publishedStates[0].email, "cli@example.com");
  assert.equal(harness.publishedStates[0].status, "WAIT");
});

test("MonitorService 停止后忽略刷新完成和超时", async () => {
  let completeRefresh: ((value: AccountRefresh) => void) | undefined;
  const refreshResult = new Promise<AccountRefresh>((resolve) => {
    completeRefresh = resolve;
  });
  const harness = makeHarness({
    account: resolution("user@example.com"),
    refresh: () => refreshResult,
    refreshTimeoutMs: 10,
  });

  await harness.service.start();
  harness.hookInbox.emit("event", statusEvent("thread-1", 100));
  await harness.service.stop();
  completeRefresh?.(refreshed("new@example.com", quota()));
  await wait(20);

  assert.equal(harness.publishedStates.length, 0);
  assert.deepEqual(harness.availability, ["offline"]);
});

test("MonitorService 启动时优先发布缓存状态并标记账号 stale", async () => {
  const cached = state({ accountStale: false });
  const harness = makeHarness({
    cached,
    refresh: async () => refreshed("cached@example.com", quota(28, 59), true),
  });

  await harness.service.start();

  assert.equal(harness.publishedStates.length, 1);
  assert.deepEqual(harness.publishedStates[0], { ...cached, accountStale: true });
  assert.equal(harness.sessionWatcher.startCount, 1);
  assert.equal(harness.hookInbox.startCount, 1);
});

test("MonitorService 账号尚未验证时使用缓存邮箱继续发布实时状态", async () => {
  const cached = state({
    status: "IDLE",
    email: "cached@example.com",
    accountStale: false,
    updatedAt: 100,
  });
  const harness = makeHarness({
    cached,
    refresh: async () => refreshed("cached@example.com", quota(28, 59), true),
  });

  await harness.service.start();
  harness.sessionWatcher.emit("event", statusEvent("thread-2", 200, "desktop", "WORKING"));
  await flushAsyncWork();

  assert.equal(harness.publishedStates.length, 2);
  assert.deepEqual(harness.publishedStates[1], {
    ...state({
      threadId: "thread-2",
      sessionId: "thread-2",
      status: "WORKING",
      email: "cached@example.com",
      accountStale: true,
      fiveHourRemaining: 72,
      weeklyRemaining: 41,
      contextUsedPercent: null,
      contextTokens: null,
      modelContextWindow: null,
      updatedAt: 200,
    }),
  });
});

test("MonitorService 启动扫描期间合并多次状态发布", async () => {
  const harness = makeHarness({
    account: resolution("user@example.com"),
    onSessionStart: (sessionWatcher) => {
      sessionWatcher.emit("event", statusEvent("thread-old", 100, "desktop", "WORKING"));
      sessionWatcher.emit("event", statusEvent("thread-new", 200, "desktop", "WAIT"));
      sessionWatcher.emit("event", tokenEvent("thread-new", 210));
    },
  });

  await harness.service.start();
  await flushAsyncWork();

  assert.equal(harness.publishedStates.length, 1);
  assert.equal(harness.publishedStates[0].threadId, "thread-new");
  assert.equal(harness.publishedStates[0].status, "WORKING");
  assert.equal(harness.publishedStates[0].updatedAt, 210);
  assert.equal(harness.savedStates.length, 1);
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

test("MonitorService hook WAIT 在账号额度刷新完成后发布", async () => {
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
  assert.equal(harness.resolver.refreshCalls.length, 1);

  harness.sessionWatcher.emit("event", tokenEvent("thread-1", 110));
  await flushAsyncWork();

  assert.equal(harness.resolver.resolveCalls.length, 1);
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
