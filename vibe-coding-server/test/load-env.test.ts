import assert from "node:assert/strict";
import test from "node:test";

import { loadProjectEnv } from "../src/load-env.js";

test("loadProjectEnv 从已有 env 文件加载变量", () => {
  delete process.env.CODEX_QUOTA_TEST_FROM_FILE;

  loadProjectEnv("test/fixtures/test.env");

  assert.equal(process.env.CODEX_QUOTA_TEST_FROM_FILE, "loaded");
  delete process.env.CODEX_QUOTA_TEST_FROM_FILE;
});

test("loadProjectEnv 保留父级环境中已经设置的变量", () => {
  process.env.CODEX_QUOTA_TEST_FROM_FILE = "parent";

  loadProjectEnv("test/fixtures/test.env");

  assert.equal(process.env.CODEX_QUOTA_TEST_FROM_FILE, "parent");
  delete process.env.CODEX_QUOTA_TEST_FROM_FILE;
});

test("loadProjectEnv 忽略不存在的 env 文件", () => {
  assert.doesNotThrow(() => loadProjectEnv("test/fixtures/missing.env"));
});
