import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { DisplayState } from "../src/codex-state.js";
import { loadState, saveState } from "../src/state-cache.js";

const state: DisplayState = {
  version: 1,
  threadId: "thread-1",
  sessionId: "session-1",
  source: "cli",
  status: "WORKING",
  email: "user@example.com",
  accountStale: false,
  fiveHourRemaining: 72,
  weeklyRemaining: 64,
  contextUsedPercent: 25,
  contextTokens: 25_000,
  modelContextWindow: 100_000,
  updatedAt: 1_765_000_000_000,
};

test("saveState 写入有效 JSON", async () => {
  const cache = await createCache();

  try {
    await saveState(cache.path, state);

    assert.deepEqual(JSON.parse(await readFile(cache.path, "utf8")), state);
  } finally {
    await cache.cleanup();
  }
});

test("saveState 使用临时文件原子替换现有缓存", async () => {
  const cache = await createCache();
  await writeFile(cache.path, '{"旧缓存":true}', "utf8");

  try {
    await saveState(cache.path, state);

    assert.deepEqual(await readdir(cache.directory), ["state.json"]);
    assert.deepEqual(JSON.parse(await readFile(cache.path, "utf8")), state);
  } finally {
    await cache.cleanup();
  }
});

test("loadState 对不存在的文件返回 null", async () => {
  const cache = await createCache();

  try {
    assert.equal(await loadState(cache.path), null);
  } finally {
    await cache.cleanup();
  }
});

test("loadState 对无效 JSON 返回 null", async () => {
  const cache = await createCache();
  await writeFile(cache.path, "{无效 JSON", "utf8");

  try {
    assert.equal(await loadState(cache.path), null);
  } finally {
    await cache.cleanup();
  }
});

test("loadState 拒绝 email 为空白的缓存状态", async () => {
  const cache = await createCache();
  await writeFile(cache.path, JSON.stringify({ ...state, email: "  " }), "utf8");

  try {
    assert.equal(await loadState(cache.path), null);
  } finally {
    await cache.cleanup();
  }
});

test("loadState 返回副本并强制 accountStale 为 true", async () => {
  const cache = await createCache();
  await writeFile(cache.path, JSON.stringify(state), "utf8");

  try {
    const restored = await loadState(cache.path);

    assert.deepEqual(restored, { ...state, accountStale: true });
    assert.notEqual(restored, state);
  } finally {
    await cache.cleanup();
  }
});

async function createCache(): Promise<{
  directory: string;
  path: string;
  cleanup: () => Promise<void>;
}> {
  const directory = await mkdtemp(join(tmpdir(), "state-cache-"));

  return {
    directory,
    path: join(directory, "state.json"),
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}
