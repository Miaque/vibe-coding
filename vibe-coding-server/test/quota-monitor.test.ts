import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { QuotaMonitor } from "../src/quota-monitor.js";

test("QuotaMonitor 发布 app-server 返回的最新数据", async () => {
  const appServer = new EventEmitter();
  appServer.readAccount = async () => ({
    account: { type: "chatgpt", email: "user@example.com", planType: "plus" },
  });
  appServer.readRateLimits = async () => ({
    rateLimits: {
      limitId: "codex",
      primary: { usedPercent: 28, resetsAt: 1780331108 },
      secondary: { usedPercent: 59, resetsAt: 1780917908 },
    },
  });
  const published = [];
  const monitor = new QuotaMonitor({
    appServer,
    publish: async (quota) => published.push(quota),
    now: () => 1780000000,
  });

  await monitor.refresh();

  assert.equal(published[0].fiveHourRemaining, 72);
  assert.equal(published[0].weeklyRemaining, 41);
  assert.equal(published[0].email, "user@example.com");
  assert.equal(published[0].planType, "plus");
  assert.equal(published[0].stale, false);
});

test("QuotaMonitor 刷新失败后将上一次数据标记为过期并发布", async () => {
  const appServer = new EventEmitter();
  appServer.readAccount = async () => ({ account: null });
  let shouldFail = false;
  appServer.readRateLimits = async () => {
    if (shouldFail) {
      throw new Error("连接已断开");
    }
    return {
      rateLimits: {
        limitId: "codex",
        primary: { usedPercent: 28, resetsAt: 1780331108 },
        secondary: null,
      },
    };
  };
  const published = [];
  const monitor = new QuotaMonitor({
    appServer,
    publish: async (quota) => published.push(quota),
    now: () => 1780000000,
  });

  await monitor.refresh();
  shouldFail = true;
  await assert.rejects(monitor.refresh(), /连接已断开/);

  assert.equal(published[1].fiveHourRemaining, 72);
  assert.equal(published[1].stale, true);
});

test("QuotaMonitor 在当前账号变化后刷新账号信息", async () => {
  const appServer = new EventEmitter();
  let account = { type: "chatgpt", email: "first@example.com", planType: "plus" };
  let usedPercent = 28;
  appServer.readAccount = async () => ({ account });
  appServer.readRateLimits = async () => ({
    rateLimits: {
      limitId: "codex",
      primary: { usedPercent, resetsAt: 1780331108 },
      secondary: null,
    },
  });
  const published = [];
  const monitor = new QuotaMonitor({
    appServer,
    publish: async (quota) => published.push(quota),
    now: () => 1780000000,
  });

  await monitor.refresh();
  account = { type: "chatgpt", email: "second@example.com", planType: "pro" };
  usedPercent = 63;
  await monitor.refresh();

  assert.equal(published[1].email, "second@example.com");
  assert.equal(published[1].planType, "pro");
  assert.equal(published[1].fiveHourRemaining, 37);
});

test("QuotaMonitor 发布配额通知前刷新账号信息", async () => {
  const appServer = new EventEmitter();
  appServer.readAccount = async () => ({
    account: { type: "chatgpt", email: "second@example.com", planType: "pro" },
  });
  const published = [];
  const monitor = new QuotaMonitor({
    appServer,
    account: { type: "chatgpt", email: "first@example.com", planType: "plus" },
    publish: async (quota) => published.push(quota),
    now: () => 1780000000,
  });
  monitor.start(60000);

  appServer.emit("rateLimitsUpdated", {
    limitId: "codex",
    primary: { usedPercent: 63, resetsAt: 1780331108 },
    secondary: null,
  });
  await new Promise((resolve) => setImmediate(resolve));
  monitor.stop();

  assert.equal(published[0].email, "second@example.com");
  assert.equal(published[0].planType, "pro");
  assert.equal(published[0].fiveHourRemaining, 37);
});

test("QuotaMonitor 轮询前重启 app-server 以发现账号切换", async () => {
  const firstAppServer = new EventEmitter();
  firstAppServer.stop = () => {
    firstAppServer.stopped = true;
  };
  const secondAppServer = new EventEmitter();
  secondAppServer.start = async () => {
    secondAppServer.started = true;
  };
  secondAppServer.stop = () => {};
  secondAppServer.readAccount = async () => ({
    account: { type: "chatgpt", email: "second@example.com", planType: "pro" },
  });
  secondAppServer.readRateLimits = async () => ({
    rateLimits: {
      limitId: "codex",
      primary: { usedPercent: 63, resetsAt: 1780331108 },
      secondary: null,
    },
  });
  const published = [];
  const monitor = new QuotaMonitor({
    appServer: firstAppServer,
    createAppServer: () => secondAppServer,
    account: { type: "chatgpt", email: "first@example.com", planType: "plus" },
    publish: async (quota) => published.push(quota),
    now: () => 1780000000,
  });

  await monitor.refresh();

  assert.equal(firstAppServer.stopped, true);
  assert.equal(secondAppServer.started, true);
  assert.equal(published[0].email, "second@example.com");
  assert.equal(published[0].planType, "pro");
  assert.equal(published[0].fiveHourRemaining, 37);
});

test("QuotaMonitor 在刷新未结束时不会重复重启 app-server", async () => {
  const firstAppServer = new EventEmitter();
  firstAppServer.stop = () => {};
  let startedCount = 0;
  let releaseStart;
  const secondAppServer = new EventEmitter();
  secondAppServer.start = async () => {
    startedCount++;
    await new Promise((resolve) => {
      releaseStart = resolve;
    });
  };
  secondAppServer.stop = () => {};
  secondAppServer.readAccount = async () => ({ account: null });
  secondAppServer.readRateLimits = async () => ({
    rateLimits: {
      limitId: "codex",
      primary: { usedPercent: 50, resetsAt: 1780331108 },
      secondary: null,
    },
  });
  const monitor = new QuotaMonitor({
    appServer: firstAppServer,
    createAppServer: () => secondAppServer,
    publish: async () => {},
  });

  const firstRefresh = monitor.refresh();
  const secondRefresh = monitor.refresh();
  await new Promise((resolve) => setImmediate(resolve));
  releaseStart();
  await Promise.all([firstRefresh, secondRefresh]);

  assert.equal(startedCount, 1);
});

test("QuotaMonitor 停止时移除配额监听器", () => {
  const appServer = new EventEmitter();
  appServer.stop = () => {};
  const monitor = new QuotaMonitor({
    appServer,
    publish: async () => {},
  });

  monitor.start(60000);
  assert.equal(appServer.listenerCount("rateLimitsUpdated"), 1);

  monitor.stop();

  assert.equal(appServer.listenerCount("rateLimitsUpdated"), 0);
});
