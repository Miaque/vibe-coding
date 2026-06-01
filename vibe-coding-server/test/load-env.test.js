import assert from "node:assert/strict";
import test from "node:test";

import { loadProjectEnv } from "../src/load-env.js";

test("loadProjectEnv loads variables from an existing env file", () => {
  delete process.env.CODEX_QUOTA_TEST_FROM_FILE;

  loadProjectEnv("test/fixtures/test.env");

  assert.equal(process.env.CODEX_QUOTA_TEST_FROM_FILE, "loaded");
  delete process.env.CODEX_QUOTA_TEST_FROM_FILE;
});

test("loadProjectEnv preserves variables already set by the parent environment", () => {
  process.env.CODEX_QUOTA_TEST_FROM_FILE = "parent";

  loadProjectEnv("test/fixtures/test.env");

  assert.equal(process.env.CODEX_QUOTA_TEST_FROM_FILE, "parent");
  delete process.env.CODEX_QUOTA_TEST_FROM_FILE;
});

test("loadProjectEnv ignores a missing env file", () => {
  assert.doesNotThrow(() => loadProjectEnv("test/fixtures/missing.env"));
});
