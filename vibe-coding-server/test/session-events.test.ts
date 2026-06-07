import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { parseSessionMetadata, parseSessionRecord } from "../src/session-events.js";

async function readFixture(name: "desktop" | "cli"): Promise<string[]> {
  const content = await readFile(
    new URL(`./fixtures/sessions/${name}.jsonl`, import.meta.url),
    "utf8",
  );
  return content.trim().split(/\r?\n/);
}

test("parseSessionMetadata 归一化 Desktop 来源", async () => {
  const [line] = await readFixture("desktop");

  assert.deepEqual(parseSessionMetadata(line), {
    threadId: "desktop-session-1",
    sessionId: "desktop-session-1",
    source: "desktop",
  });
});

test("parseSessionMetadata 归一化 CLI 来源", async () => {
  const [line] = await readFixture("cli");

  assert.deepEqual(parseSessionMetadata(line), {
    threadId: "cli-session-1",
    sessionId: "cli-session-1",
    source: "cli",
  });
});

test("parseSessionRecord 将 task_started 转换为 WORKING", async () => {
  const [metadataLine, startedLine] = await readFixture("desktop");
  const metadata = parseSessionMetadata(metadataLine);
  assert.ok(metadata);

  assert.deepEqual(parseSessionRecord(startedLine, metadata, null), {
    kind: "status",
    threadId: "desktop-session-1",
    sessionId: "desktop-session-1",
    turnId: "turn-1",
    occurredAt: 1780768660869,
    source: "desktop",
    status: "WORKING",
    modelContextWindow: 258400,
  });
});

test("parseSessionRecord 将完成和中止事件转换为 IDLE", async () => {
  const [metadataLine, , , completedLine] = await readFixture("desktop");
  const metadata = parseSessionMetadata(metadataLine);
  assert.ok(metadata);

  assert.deepEqual(parseSessionRecord(completedLine, metadata, "other-turn"), {
    kind: "status",
    threadId: "desktop-session-1",
    sessionId: "desktop-session-1",
    turnId: "turn-1",
    occurredAt: 1780768698875,
    source: "desktop",
    status: "IDLE",
  });

  const aborted = JSON.stringify({
    timestamp: "2026-06-06T17:58:18.875Z",
    type: "event_msg",
    payload: { type: "turn_aborted", turn_id: "turn-aborted" },
  });
  assert.deepEqual(parseSessionRecord(aborted, metadata, "other-turn"), {
    kind: "status",
    threadId: "desktop-session-1",
    sessionId: "desktop-session-1",
    turnId: "turn-aborted",
    occurredAt: 1780768698875,
    source: "desktop",
    status: "IDLE",
  });
});

test("parseSessionRecord 从 token_count 提取最近用量和 snake_case 配额", async () => {
  const [metadataLine, startedLine, tokenLine] = await readFixture("desktop");
  const metadata = parseSessionMetadata(metadataLine);
  assert.ok(metadata);
  const started = parseSessionRecord(startedLine, metadata, null);
  assert.ok(started);

  assert.deepEqual(parseSessionRecord(tokenLine, metadata, started.turnId), {
    kind: "token",
    threadId: "desktop-session-1",
    sessionId: "desktop-session-1",
    turnId: "turn-1",
    occurredAt: 1780768673200,
    source: "desktop",
    contextTokens: 43192,
    modelContextWindow: 258400,
    quota: {
      limitId: "codex",
      planType: "plus",
      primary: { usedPercent: 1, resetsAt: 1780778325 },
      secondary: { usedPercent: 34, resetsAt: 1781142977 },
    },
  });
});

test("parseSessionRecord 在 rate_limits 缺失时仍保留 token 事件", async () => {
  const [metadataLine] = await readFixture("desktop");
  const metadata = parseSessionMetadata(metadataLine);
  assert.ok(metadata);

  const tokenLine = JSON.stringify({
    timestamp: "2026-06-06T17:57:53.200Z",
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        last_token_usage: { total_tokens: 43192 },
        model_context_window: 258400,
      },
    },
  });

  assert.deepEqual(parseSessionRecord(tokenLine, metadata, "turn-1"), {
    kind: "token",
    threadId: "desktop-session-1",
    sessionId: "desktop-session-1",
    turnId: "turn-1",
    occurredAt: 1780768673200,
    source: "desktop",
    contextTokens: 43192,
    modelContextWindow: 258400,
    quota: null,
  });
});

test("parseSessionRecord 保留 nullable planType 和缺失的 secondary", async () => {
  const [metadataLine] = await readFixture("desktop");
  const metadata = parseSessionMetadata(metadataLine);
  assert.ok(metadata);

  const tokenLine = JSON.stringify({
    timestamp: "2026-06-06T17:57:53.200Z",
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        last_token_usage: { total_tokens: 43192 },
        model_context_window: 258400,
      },
      rate_limits: {
        limit_id: "codex",
        plan_type: null,
        primary: { used_percent: 1, resets_at: 1780778325 },
        secondary: null,
      },
    },
  });

  assert.deepEqual(parseSessionRecord(tokenLine, metadata, "turn-1")?.quota, {
    limitId: "codex",
    planType: null,
    primary: { usedPercent: 1, resetsAt: 1780778325 },
    secondary: null,
  });
});

test("parseSessionRecord 独立解析 secondary 并容忍 malformed primary", async () => {
  const [metadataLine] = await readFixture("desktop");
  const metadata = parseSessionMetadata(metadataLine);
  assert.ok(metadata);

  const tokenLine = JSON.stringify({
    timestamp: "2026-06-06T17:57:53.200Z",
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        last_token_usage: { total_tokens: 43192 },
        model_context_window: 258400,
      },
      rate_limits: {
        limit_id: null,
        primary: { used_percent: "invalid", resets_at: 1780778325 },
        secondary: { used_percent: 34, resets_at: 1781142977 },
      },
    },
  });

  assert.deepEqual(parseSessionRecord(tokenLine, metadata, "turn-1")?.quota, {
    limitId: null,
    primary: null,
    secondary: { usedPercent: 34, resetsAt: 1781142977 },
  });
});

test("parseSessionRecord 保留 resetsAt 为 null 的有效窗口", async () => {
  const [metadataLine] = await readFixture("desktop");
  const metadata = parseSessionMetadata(metadataLine);
  assert.ok(metadata);

  const tokenLine = JSON.stringify({
    timestamp: "2026-06-06T17:57:53.200Z",
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        last_token_usage: { total_tokens: 43192 },
        model_context_window: 258400,
      },
      rate_limits: {
        limit_id: "codex",
        primary: { used_percent: 1, resets_at: null },
      },
    },
  });

  assert.deepEqual(parseSessionRecord(tokenLine, metadata, "turn-1")?.quota, {
    limitId: "codex",
    primary: { usedPercent: 1, resetsAt: null },
    secondary: null,
  });
});

test("解析器对未知和 malformed 记录返回 null", async () => {
  const [metadataLine] = await readFixture("desktop");
  const metadata = parseSessionMetadata(metadataLine);
  assert.ok(metadata);

  assert.equal(parseSessionMetadata("{"), null);
  assert.equal(parseSessionMetadata(JSON.stringify({
    type: "session_meta",
    payload: { id: "unknown", originator: "other", source: "api", cwd: "C:\\" },
  })), null);
  assert.equal(parseSessionRecord("{", metadata, null), null);
  assert.equal(parseSessionRecord(JSON.stringify({
    timestamp: "2026-06-06T17:57:53.200Z",
    type: "event_msg",
    payload: { type: "unknown" },
  }), metadata, null), null);
});
