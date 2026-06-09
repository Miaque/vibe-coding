import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  AccountVerificationError,
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

test("probeAccount 额度读取失败时保留已读取的账号信息", async () => {
  const command: AppServerCommand = { command: "codex", args: ["app-server"], shell: false };
  const rateLimitError = new Error("token_revoked");

  await assert.rejects(
    probeAccount(command, {
      createClient: () => ({
        start: async () => {},
        stop: () => {},
        readAccount: async () => ({
          account: {
            type: "chatgpt",
            email: "new@example.com",
            planType: "plus",
          },
        }),
        readRateLimits: async () => {
          throw rateLimitError;
        },
      }),
      now: () => 456,
    }),
    (error: unknown) => {
      assert.ok(error instanceof AccountVerificationError);
      assert.equal(error.cause, rateLimitError);
      assert.deepEqual(error.account, {
        email: "new@example.com",
        planType: "plus",
        resolvedAt: 456,
        stale: true,
      });
      return true;
    },
  );
});

test("probeAccount 中止时停止悬挂的 client 并拒绝", async () => {
  const command: AppServerCommand = { command: "codex", args: ["app-server"], shell: false };
  const controller = new AbortController();
  let stopCalled = false;
  let finishCheck: (() => void) | null = null;
  const result = probeAccount(command, {
    createClient: () => ({
      start: async () => {},
      stop: () => {
        stopCalled = true;
      },
      readAccount: () => new Promise(() => {}),
      readRateLimits: async () => ({ rateLimits: snapshot(0, 0, 1000, 2000) }),
    }),
    signal: controller.signal,
  });
  const outcome = Promise.race([
    result.then(
      () => "resolved",
      () => "rejected",
    ),
    new Promise<"pending">((resolve) => {
      finishCheck = () => resolve("pending");
    }),
  ]);

  await flushAsyncWork();
  controller.abort();
  await flushAsyncWork();

  finishCheck?.();
  assert.equal(await outcome, "rejected");
  assert.equal(stopCalled, true);
});

test("AccountResolver 额度验证失败时发布新邮箱并标记 stale", async () => {
  const quota = snapshot(23, 37, 1000, 2000);
  const resolved: unknown[] = [];
  const resolver = new AccountResolver({
    probe: async () => {
      throw new AccountVerificationError(
        {
          email: "new@example.com",
          planType: "plus",
          resolvedAt: 456,
          stale: true,
        },
        new Error("token_revoked"),
      );
    },
    resolveCommand: () => ({ command: "codex", args: ["app-server"], shell: false }),
    sleep: (delay) => delay === 0 ? Promise.resolve() : new Promise<void>(() => {}),
  });
  resolver.on("resolved", (value) => resolved.push(value));

  assert.equal(resolver.resolve(thread({ quota })), null);
  await flushAsyncWork();

  assert.deepEqual(resolver.resolve(thread({ quota })), {
    email: "new@example.com",
    planType: "plus",
    resolvedAt: 456,
    stale: true,
  });
  assert.deepEqual(resolved, [
    {
      email: "new@example.com",
      planType: "plus",
      resolvedAt: 456,
      stale: true,
    },
  ]);
});

test("AccountResolver refresh 强制读取当前账号和额度", async () => {
  const expectedQuota = snapshot(23, 37, 1000, 2000);
  const refreshedQuota = snapshot(41, 59, 3000, 4000);
  let probeCount = 0;
  const resolver = new AccountResolver({
    probe: async () => {
      probeCount += 1;
      return account(
        probeCount === 1 ? "old@example.com" : "new@example.com",
        probeCount === 1 ? expectedQuota : refreshedQuota,
      );
    },
    resolveCommand: () => ({ command: "codex", args: ["app-server"], shell: false }),
    sleep: () => Promise.resolve(),
  });
  const target = thread({ quota: expectedQuota });

  const first = await resolver.refresh(target);
  const second = await resolver.refresh(target);

  assert.equal(probeCount, 2);
  assert.equal(first?.email, "old@example.com");
  assert.equal(first?.stale, false);
  assert.equal(second?.email, "new@example.com");
  assert.deepEqual(second?.quota, refreshedQuota);
  assert.equal(second?.stale, true);
});

test("AccountResolver refresh 等待正在执行的后台 probe", async () => {
  const quota = snapshot(23, 37, 1000, 2000);
  let finishFirstProbe: (() => void) | undefined;
  let probeCount = 0;
  const resolver = new AccountResolver({
    probe: async () => {
      probeCount += 1;
      if (probeCount === 1) {
        await new Promise<void>((resolve) => {
          finishFirstProbe = resolve;
        });
      }
      return account("user@example.com", quota);
    },
    resolveCommand: () => ({ command: "codex", args: ["app-server"], shell: false }),
    sleep: () => Promise.resolve(),
  });
  const target = thread({ quota });

  resolver.resolve(target);
  await flushAsyncWork();
  const refresh = resolver.refresh(target);
  await flushAsyncWork();

  assert.equal(probeCount, 1);
  finishFirstProbe?.();
  await refresh;
  assert.equal(probeCount, 2);
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

test("AccountResolver 额度不匹配时发布新邮箱并标记 stale", async () => {
  const quota = snapshot(23, 37, 1000, 2000);
  const sleeps: number[] = [];
  const resolved: unknown[] = [];
  const resolver = new AccountResolver({
    probe: async () => account("new@example.com", snapshot(90, 37, 1000, 2000)),
    resolveCommand: () => ({ command: "codex", args: ["app-server"], shell: false }),
    sleep: (delay) => {
      sleeps.push(delay);
      return delay === 0 ? Promise.resolve() : new Promise<void>(() => {});
    },
  });
  resolver.on("resolved", (value) => resolved.push(value));

  assert.equal(resolver.resolve(thread({ quota })), null);
  await flushAsyncWork();

  assert.deepEqual(resolver.resolve(thread({ quota })), {
    email: "new@example.com",
    planType: "plus",
    resolvedAt: 123,
    stale: true,
  });
  assert.deepEqual(resolved, [
    { email: "new@example.com", planType: "plus", resolvedAt: 123, stale: true },
  ]);
  assert.deepEqual(sleeps.slice(0, 2), [0, 250]);
});

test("AccountResolver 将同步 probe 异常标记 stale 并安排重试", async () => {
  const quota = snapshot(23, 37, 1000, 2000);
  const sleeps: number[] = [];
  let probeCount = 0;
  const resolver = new AccountResolver({
    probe: () => {
      probeCount += 1;
      if (probeCount === 1) {
        return Promise.resolve(account("user@example.com", quota));
      }

      throw new Error("sync probe failure");
    },
    resolveCommand: () => ({ command: "codex", args: ["app-server"], shell: false }),
    sleep: (delay) => {
      sleeps.push(delay);
      if (delay >= 500) {
        return new Promise<void>(() => {});
      }
      return Promise.resolve();
    },
  });

  resolver.resolve(thread({ threadId: "thread-1", quota }));
  await flushAsyncWork();

  assert.deepEqual(resolver.resolve(thread({ threadId: "thread-2", quota })), {
    email: "user@example.com",
    planType: "plus",
    resolvedAt: 123,
    stale: true,
  });
  await flushAsyncWork();

  assert.deepEqual(sleeps.slice(0, 3), [0, 0, 250]);
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

test("AccountResolver 超时中止旧 probe 后串行探测最新目标", async () => {
  const quota = snapshot(23, 37, 1000, 2000);
  const probeCommands: string[] = [];
  const resolved: unknown[] = [];
  let expireFirstProbe: (() => void) | null = null;
  let concurrent = 0;
  let maxConcurrent = 0;
  let firstProbeAborted = false;
  let firstProbeAbortedBeforeLatest = false;
  const resolver = new AccountResolver({
    probe: async (command, signal) => {
      probeCommands.push(command.command);
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      try {
        if (probeCommands.length === 1) {
          return await new Promise<AccountSnapshot>((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => {
                firstProbeAborted = true;
                reject(new Error("probe aborted"));
              },
              { once: true },
            );
          });
        }

        firstProbeAbortedBeforeLatest = firstProbeAborted;
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
  assert.equal(firstProbeAbortedBeforeLatest, true);
  assert.equal(maxConcurrent, 1);
  assert.deepEqual(resolver.resolve(thread({ threadId: "thread-2", source: "desktop", quota })), {
    email: "desktop@example.com",
    planType: "plus",
    resolvedAt: 123,
    stale: false,
  });

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
    { email: "user@example.com", planType: "plus", resolvedAt: 123, stale: true },
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
