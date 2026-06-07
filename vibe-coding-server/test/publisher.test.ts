import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { DisplayState } from "../src/codex-state.js";
import {
  createMqttOptions,
  loadCachedState,
  publishAvailability,
  publishState,
  saveCachedState,
} from "../src/publisher.js";

const state: DisplayState = {
  version: 1,
  threadId: "thread-1",
  sessionId: "session-1",
  source: "desktop",
  status: "WAIT",
  email: "user@example.com",
  accountStale: false,
  fiveHourRemaining: 72,
  weeklyRemaining: 64,
  contextUsedPercent: 25,
  contextTokens: 25_000,
  modelContextWindow: 100_000,
  updatedAt: 1_765_000_000_000,
};

test("publishState 发布保留的 DisplayState JSON 消息", async () => {
  const calls = [];
  const client = {
    publish(topic, payload, options, callback) {
      calls.push({ topic, payload, options });
      callback();
    },
  };

  await publishState(client, "oled/codex/state", state);

  assert.deepEqual(calls, [
    {
      topic: "oled/codex/state",
      payload: JSON.stringify(state),
      options: { retain: true, qos: 1 },
    },
  ]);
});

test("publishState 序列化 UTF-8 payload 小于 400 字节", () => {
  const payload = JSON.stringify({
    ...state,
    email: "用户@example.com",
  });

  assert.ok(Buffer.byteLength(payload, "utf8") < 400);
});

test("publishAvailability 发布保留的 online 消息", async () => {
  const calls = [];
  const client = {
    publish(topic, payload, options, callback) {
      calls.push({ topic, payload, options });
      callback();
    },
  };

  await publishAvailability(client, "oled/codex/availability", "online");

  assert.deepEqual(calls, [
    {
      topic: "oled/codex/availability",
      payload: "online",
      options: { retain: true, qos: 1 },
    },
  ]);
});

test("publishAvailability 发布保留的 offline 消息", async () => {
  const calls = [];
  const client = {
    publish(topic, payload, options, callback) {
      calls.push({ topic, payload, options });
      callback();
    },
  };

  await publishAvailability(client, "oled/codex/availability", "offline");

  assert.deepEqual(calls, [
    {
      topic: "oled/codex/availability",
      payload: "offline",
      options: { retain: true, qos: 1 },
    },
  ]);
});

test("createMqttOptions 配置保留的 offline 遗嘱且不加入凭据", () => {
  const options = createMqttOptions("oled/codex/availability");

  assert.deepEqual(options, {
    will: {
      topic: "oled/codex/availability",
      payload: "offline",
      qos: 1,
      retain: true,
    },
  });
  assert.equal("username" in options, false);
  assert.equal("password" in options, false);
});

test("saveCachedState 和 loadCachedState 委托缓存持久化", async () => {
  const directory = await mkdtemp(join(tmpdir(), "publisher-cache-"));
  const path = join(directory, "state.json");

  try {
    await saveCachedState(path, state);

    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), state);
    assert.deepEqual(await loadCachedState(path), { ...state, accountStale: true });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
