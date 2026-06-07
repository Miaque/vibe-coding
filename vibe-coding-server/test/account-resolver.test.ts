import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  AccountResolver,
  probeAccount,
  quotaMatches,
  type AccountSnapshot,
} from "../src/account-resolver.js";
import type { AppServerCommand } from "../src/app-server-client.js";
import type { RateLimitSnapshot } from "../src/codex-state.js";
import type { ThreadSnapshot } from "../src/thread-aggregator.js";

function snapshot(
  primaryUsed: number,
  secondaryUsed: number,
  primaryReset: number | null,
  secondaryReset: number | null,
): RateLimitSnapshot {
  return {
    limitId: "codex",
    primary: { usedPercent: primaryUsed, resetsAt: primaryReset },
    secondary: { usedPercent: secondaryUsed, resetsAt: secondaryReset },
  };
}

function account(email: string, quota: RateLimitSnapshot): AccountSnapshot {
  return {
    email,
    planType: "plus",
    quota,
    resolvedAt: 123,
  };
}

function thread(input: Partial<ThreadSnapshot> = {}): ThreadSnapshot {
  return {
    threadId: "thread-1",
    sessionId: "session-1",
    source: "cli",
    status: "WORKING",
    turnId: "turn-1",
    lastEventAt: 100,
    contextTokens: null,
    modelContextWindow: null,
    quota: snapshot(23, 37, 1000, 2000),
    ...input,
  };
}

async function flushAsyncWork() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test("quotaMatches 允许 usedPercent 采样差异并匹配 reset time", () => {
  assert.equal(
    quotaMatches(snapshot(23, 37, 1000, 2000), snapshot(24, 36, 1000, 2000)),
    true,
  );
});

test("quotaMatches 在 usedPercent 差异过大时返回 false", () => {
  assert.equal(
    quotaMatches(snapshot(0, 37, 1000, 2000), snapshot(100, 37, 1000, 2000)),
    false,
  );
});

test("quotaMatches 在 reset time 不一致时返回 false", () => {
  assert.equal(
    quotaMatches(snapshot(23, 37, 1000, 2000), snapshot(23, 37, 1001, 2000)),
    false,
  );
});

test("quotaMatches 同时缺少窗口时匹配，只有一边缺少时不匹配", () => {
  assert.equal(
    quotaMatches({ limitId: null, primary: null }, { limitId: null, primary: null }),
    true,
  );
  assert.equal(
    quotaMatches({ limitId: null, primary: null }, { limitId: null, primary: { usedPercent: 0 } }),
    false,
  );
});

test("probeAccount 拒绝空白或非 ChatGPT 账号", async () => {
  const command: AppServerCommand = { command: "codex", args: ["app-server"], shell: false };

  await assert.rejects(
    probeAccount(command, {
      createClient: () => fakeClient({ type: "chatgpt", email: " " }),
      now: () => 1,
    }),
    /ChatGPT 账号邮箱为空/,
  );

  await assert.rejects(
    probeAccount(command, {
      createClient: () => fakeClient({ type: "api", email: "user@example.com" }),
      now: () => 1,
    }),
    /不是 ChatGPT 账号/,
  );
});

test("失败探测保留上次邮箱并标记 stale", async () => {
  const quota = snapshot(23, 37, 1000, 2000);
  const sleeps: number[] = [];
  let probeCount = 0;
  const resolved: unknown[] = [];
  const resolver = new AccountResolver({
    probe: async () => {
      probeCount += 1;
      if (probeCount === 1) {
        return account("user@example.com", quota);
      }
      throw new Error("probe failed");
    },
    resolveCommand: () => ({ command: "codex", args: ["app-server"], shell: false }),
    sleep: (delay) => {
      sleeps.push(delay);
      if (delay >= 500) {
        return new Promise<void>(() => {});
      }
      return Promise.resolve();
    },
    now: () => 1000,
  });
  resolver.on("resolved", (value) => resolved.push(value));

  assert.equal(resolver.resolve(thread({ quota })), null);
  await flushAsyncWork();
  assert.deepEqual(resolver.resolve(thread({ threadId: "thread-2", quota })), {
    email: "user@example.com",
    planType: "plus",
    resolvedAt: 123,
    stale: true,
  });
  await flushAsyncWork();

  assert.deepEqual(sleeps.slice(0, 3), [0, 0, 250]);
  assert.deepEqual(resolver.resolve(thread({ source: null, quota })), {
    email: "user@example.com",
    planType: "plus",
    resolvedAt: 123,
    stale: true,
  });
  assert.deepEqual(resolved, [
    { email: "user@example.com", planType: "plus", resolvedAt: 123, stale: false },
    { email: "user@example.com", planType: "plus", resolvedAt: 123, stale: true },
  ]);
});

test("AccountResolver 取消过期线程的重试", async () => {
  const quota = snapshot(23, 37, 1000, 2000);
  const probeCommands: AppServerCommand[] = [];
  let blockedSleepResolve: (() => void) | null = null;
  const resolver = new AccountResolver({
    probe: async (command) => {
      probeCommands.push(command);
      throw new Error("probe failed");
    },
    resolveCommand: (source) => ({
      command: source === "cli" ? "codex" : "desktop-codex",
      args: ["app-server"],
      shell: false,
    }),
    sleep: (delay) => {
      if (delay === 0) {
        return Promise.resolve();
      }

      return new Promise<void>((resolve) => {
        blockedSleepResolve = resolve;
      });
    },
    now: () => 1000,
  });

  resolver.resolve(thread({ threadId: "thread-1", source: "cli", quota }));
  await flushAsyncWork();
  resolver.resolve(thread({ threadId: "thread-2", source: "desktop", quota }));
  blockedSleepResolve?.();
  await flushAsyncWork();

  assert.deepEqual(
    probeCommands.map((command) => command.command),
    ["codex", "desktop-codex"],
  );
});

test("AccountResolver 同时只探测最新目标且最多一个 probe in flight", async () => {
  const quota = snapshot(23, 37, 1000, 2000);
  const probeCommands: string[] = [];
  let firstProbeResolve: ((snapshot: AccountSnapshot) => void) | null = null;
  let concurrent = 0;
  let maxConcurrent = 0;
  const resolver = new AccountResolver({
    probe: async (command) => {
      probeCommands.push(command.command);
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      try {
        if (probeCommands.length === 1) {
          return await new Promise<AccountSnapshot>((resolve) => {
            firstProbeResolve = resolve;
          });
        }

        return account("desktop@example.com", quota);
      } finally {
        concurrent -= 1;
      }
    },
    resolveCommand: (source) => ({
      command: source === "cli" ? "codex" : "desktop-codex",
      args: ["app-server"],
      shell: false,
    }),
    sleep: () => Promise.resolve(),
  });

  resolver.resolve(thread({ threadId: "thread-1", source: "cli", quota }));
  await flushAsyncWork();
  resolver.resolve(thread({ threadId: "thread-2", source: "desktop", quota }));
  await flushAsyncWork();

  assert.deepEqual(probeCommands, ["codex"]);
  firstProbeResolve?.(account("cli@example.com", quota));
  await flushAsyncWork();
  await flushAsyncWork();

  assert.deepEqual(probeCommands, ["codex", "desktop-codex"]);
  assert.equal(maxConcurrent, 1);
});

test("AccountResolver 在旧 probe 超时后探测最新目标", async () => {
  const quota = snapshot(23, 37, 1000, 2000);
  const probeCommands: string[] = [];
  const resolved: unknown[] = [];
  let rejectFirstProbe: ((error: Error) => void) | null = null;
  let expireFirstProbe: (() => void) | null = null;
  const resolver = new AccountResolver({
    probe: async (command) => {
      probeCommands.push(command.command);
      if (probeCommands.length === 1) {
        return await new Promise<AccountSnapshot>((_resolve, reject) => {
          rejectFirstProbe = reject;
        });
      }

      return account("desktop@example.com", quota);
    },
    resolveCommand: (source) => ({
      command: source === "cli" ? "codex" : "desktop-codex",
      args: ["app-server"],
      shell: false,
    }),
    sleep: () => Promise.resolve(),
    probeTimeout: () =>
      new Promise<void>((resolve) => {
        expireFirstProbe ??= resolve;
      }),
  });
  resolver.on("resolved", (value) => resolved.push(value));

  resolver.resolve(thread({ threadId: "thread-1", source: "cli", quota }));
  await flushAsyncWork();
  resolver.resolve(thread({ threadId: "thread-2", source: "desktop", quota }));
  await flushAsyncWork();

  assert.deepEqual(probeCommands, ["codex"]);
  expireFirstProbe?.();
  await flushAsyncWork();
  await flushAsyncWork();

  assert.deepEqual(probeCommands, ["codex", "desktop-codex"]);
  assert.deepEqual(resolver.resolve(thread({ threadId: "thread-2", source: "desktop", quota })), {
    email: "desktop@example.com",
    planType: "plus",
    resolvedAt: 123,
    stale: false,
  });

  rejectFirstProbe?.(new Error("late failure"));
  await flushAsyncWork();
  assert.deepEqual(resolved, [
    { email: "desktop@example.com", planType: "plus", resolvedAt: 123, stale: false },
  ]);
});

test("AccountResolver 只在 email 或 stale 状态变化时发出 resolved", async () => {
  const quota = snapshot(23, 37, 1000, 2000);
  const resolved: unknown[] = [];
  let probeCount = 0;
  const resolver = new AccountResolver({
    probe: async () => {
      probeCount += 1;
      if (probeCount === 1) {
        return account("user@example.com", { limitId: "other", primary: null, secondary: null });
      }

      return {
        email: "user@example.com",
        planType: "team",
        quota,
        resolvedAt: 456,
      };
    },
    resolveCommand: () => ({ command: "codex", args: ["app-server"], shell: false }),
    sleep: () => Promise.resolve(),
    now: () => 1000,
  });
  resolver.on("resolved", (value) => resolved.push(value));

  resolver.resolve(thread({ quota }));
  await flushAsyncWork();
  await flushAsyncWork();

  assert.deepEqual(resolved, [
    { email: "user@example.com", planType: "team", resolvedAt: 456, stale: false },
  ]);
});

function fakeClient(accountValue: unknown) {
  const client = new EventEmitter() as EventEmitter & {
    start: () => Promise<void>;
    stop: () => void;
    readAccount: () => Promise<unknown>;
    readRateLimits: () => Promise<{ rateLimits: RateLimitSnapshot }>;
  };
  client.start = async () => {};
  client.stop = () => {};
  client.readAccount = async () => ({ account: accountValue });
  client.readRateLimits = async () => ({ rateLimits: snapshot(0, 0, 1000, 2000) });
  return client;
}
