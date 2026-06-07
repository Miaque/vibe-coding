import assert from "node:assert/strict";
import {
  appendFile,
  mkdir,
  mkdtemp,
  rename,
  rm,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { NormalizedEvent } from "../src/codex-state.js";
import type { SessionMetadata } from "../src/session-events.js";
import { SessionWatcher } from "../src/session-watcher.js";

const metadataLine = JSON.stringify({
  timestamp: "2026-06-06T17:57:39.000Z",
  type: "session_meta",
  payload: {
    id: "session-1",
    originator: "Codex Desktop",
    source: "vscode",
    cwd: "C:\\workspace\\测试",
  },
});

function eventLine(type: string, turnId: string): string {
  return JSON.stringify({
    timestamp: "2026-06-06T17:58:18.875Z",
    type: "event_msg",
    payload: {
      type,
      turn_id: turnId,
      model_context_window: 258400,
    },
  });
}

function tokenLine(): string {
  return JSON.stringify({
    timestamp: "2026-06-06T17:58:19.000Z",
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        last_token_usage: { total_tokens: 100 },
        model_context_window: 258400,
      },
    },
  });
}

async function createSessionFile(
  content: string,
): Promise<{ root: string; file: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "session-watcher-"));
  const directory = join(root, "nested");
  const file = join(directory, "session.jsonl");
  await mkdir(directory);
  await writeFile(file, content, "utf8");
  return {
    root,
    file,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

function collect(watcher: SessionWatcher): {
  metadata: SessionMetadata[];
  events: NormalizedEvent[];
  order: string[];
} {
  const metadata: SessionMetadata[] = [];
  const events: NormalizedEvent[] = [];
  const order: string[] = [];
  watcher.on("metadata", (value: SessionMetadata) => {
    metadata.push(value);
    order.push("metadata");
  });
  watcher.on("event", (value: NormalizedEvent) => {
    events.push(value);
    order.push("event");
  });
  return { metadata, events, order };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 500;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "等待轮询事件超时");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("启动时回放已有完成会话且只回放一次", async (t) => {
  const session = await createSessionFile(
    `${metadataLine}\n${eventLine("task_started", "turn-1")}\n${eventLine("task_complete", "turn-1")}\n`,
  );
  t.after(session.cleanup);
  const watcher = new SessionWatcher({ root: session.root });
  const received = collect(watcher);

  await Promise.all([watcher.scanOnce(), watcher.scanOnce()]);
  await watcher.scanOnce();

  assert.deepEqual(received.events.map((event) => event.status), ["WORKING", "IDLE"]);
});

test("追加一条完整事件时只读取新增字节", async (t) => {
  const session = await createSessionFile(`${metadataLine}\n`);
  t.after(session.cleanup);
  const watcher = new SessionWatcher({ root: session.root });
  const received = collect(watcher);
  await watcher.scanOnce();

  await appendFile(session.file, `${eventLine("task_started", "turn-2")}\n`, "utf8");
  await watcher.scanOnce();

  assert.equal(received.events.length, 1);
  assert.equal(received.events[0]?.turnId, "turn-2");
});

test("partial 等待换行后再处理且 UTF-8 字节偏移不重复", async (t) => {
  const started = eventLine("task_started", "turn-3");
  const content = Buffer.from(`${metadataLine}\r\n${started}\r\n`, "utf8");
  const chineseBytes = Buffer.from("测试", "utf8");
  const chineseAt = content.indexOf(chineseBytes);
  assert.notEqual(chineseAt, -1);
  const splitAt = chineseAt + 1;
  const session = await createSessionFile("");
  t.after(session.cleanup);
  const watcher = new SessionWatcher({ root: session.root });
  const received = collect(watcher);

  await writeFile(session.file, content.subarray(0, splitAt));
  await watcher.scanOnce();
  assert.equal(received.events.length, 0);

  await appendFile(session.file, content.subarray(splitAt));
  await watcher.scanOnce();
  await watcher.scanOnce();

  assert.equal(received.events.length, 1);
  assert.equal(received.events[0]?.turnId, "turn-3");
});

test("同路径文件 identity 变化后从头读取新会话", async (t) => {
  const oldContent = `${metadataLine}\n${eventLine("task_started", "turn-old")}\n`;
  const session = await createSessionFile(oldContent);
  t.after(session.cleanup);
  const watcher = new SessionWatcher({ root: session.root });
  const received = collect(watcher);
  await watcher.scanOnce();

  const replacement = join(session.root, "nested", "replacement.jsonl");
  const newMetadata = metadataLine.replace("session-1", "session-2");
  const newContent = `${newMetadata}\n${eventLine("task_started", "turn-new")}\n${" ".repeat(oldContent.length)}\n`;
  await writeFile(replacement, newContent, "utf8");
  await rm(session.file);
  await rename(replacement, session.file);
  await watcher.scanOnce();

  assert.deepEqual(received.metadata.map((metadata) => metadata.sessionId), [
    "session-1",
    "session-2",
  ]);
  assert.deepEqual(received.events.map((event) => [event.sessionId, event.turnId]), [
    ["session-1", "turn-old"],
    ["session-2", "turn-new"],
  ]);
});

test("坏 JSON 行不会阻断后续有效记录", async (t) => {
  const session = await createSessionFile(
    `${metadataLine}\n{坏 JSON\n${eventLine("task_started", "turn-4")}\n`,
  );
  t.after(session.cleanup);
  const watcher = new SessionWatcher({ root: session.root });
  const received = collect(watcher);

  await watcher.scanOnce();

  assert.equal(received.events.length, 1);
  assert.equal(received.events[0]?.turnId, "turn-4");
});

test("单文件扫描错误发送 scanError 且不阻断其他文件", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "session-watcher-errors-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const badFile = join(root, "a-bad.jsonl");
  const validFile = join(root, "z-valid.jsonl");
  await writeFile(badFile, `${metadataLine}\n`, "utf8");
  await writeFile(
    validFile,
    `${metadataLine.replace("session-1", "session-valid")}\n`
    + `${eventLine("task_started", "turn-valid")}\n`,
    "utf8",
  );
  const watcher = new SessionWatcher({ root });
  const received = collect(watcher);
  const scanErrors: Array<{ path: string; error: unknown }> = [];
  watcher.on("scanError", (value) => scanErrors.push(value));
  const privateWatcher = watcher as unknown as {
    scanFile(path: string): Promise<void>;
  };
  const originalScanFile = privateWatcher.scanFile.bind(watcher);
  privateWatcher.scanFile = async (path) => {
    if (path === badFile) {
      const error = new Error("测试文件不可读") as NodeJS.ErrnoException;
      error.code = "EACCES";
      throw error;
    }
    await originalScanFile(path);
  };

  await watcher.scanOnce();

  assert.equal(scanErrors.length, 1);
  assert.equal(scanErrors[0]?.path, badFile);
  assert.equal((scanErrors[0]?.error as NodeJS.ErrnoException).code, "EACCES");
  assert.equal(received.events[0]?.turnId, "turn-valid");
});

test("文件截断后安全重置 cursor 并读取新会话", async (t) => {
  const session = await createSessionFile(
    `${metadataLine}\n${eventLine("task_started", "turn-before")}\n`,
  );
  t.after(session.cleanup);
  const watcher = new SessionWatcher({ root: session.root });
  const received = collect(watcher);
  await watcher.scanOnce();

  await truncate(session.file, 0);
  await watcher.scanOnce();
  await appendFile(
    session.file,
    `${metadataLine.replace("session-1", "session-2")}\n${eventLine("task_started", "turn-after")}\n`,
    "utf8",
  );
  await watcher.scanOnce();

  assert.deepEqual(received.events.map((event) => event.turnId), [
    "turn-before",
    "turn-after",
  ]);
});

test("metadata 在事件前发送且每个文件只发送一次", async (t) => {
  const session = await createSessionFile(
    `${metadataLine}\n${eventLine("task_started", "turn-5")}\n`,
  );
  t.after(session.cleanup);
  const watcher = new SessionWatcher({ root: session.root });
  const received = collect(watcher);

  await watcher.scanOnce();
  await appendFile(session.file, `${metadataLine}\n${eventLine("task_complete", "turn-5")}\n`);
  await watcher.scanOnce();

  assert.deepEqual(received.order, ["metadata", "event", "event"]);
  assert.equal(received.metadata.length, 1);
});

test("只在匹配的完成事件后清除 activeTurnId", async (t) => {
  const session = await createSessionFile(
    `${metadataLine}\n`
    + `${eventLine("task_started", "turn-active")}\n`
    + `${eventLine("task_complete", "turn-other")}\n`
    + `${tokenLine()}\n`
    + `${eventLine("task_complete", "turn-active")}\n`
    + `${tokenLine()}\n`,
  );
  t.after(session.cleanup);
  const watcher = new SessionWatcher({ root: session.root });
  const received = collect(watcher);

  await watcher.scanOnce();

  const tokenEvents = received.events.filter((event) => event.kind === "token");
  assert.deepEqual(tokenEvents.map((event) => event.turnId), ["turn-active", null]);
});

test("start 返回 Promise 且完成首次扫描后再 resolve", async (t) => {
  const session = await createSessionFile(
    `${metadataLine}\n${eventLine("task_started", "turn-start")}\n`,
  );
  t.after(session.cleanup);
  const watcher = new SessionWatcher({ root: session.root });
  t.after(() => watcher.stop());
  const received = collect(watcher);

  const started = watcher.start();

  assert.ok(started instanceof Promise);
  await started;
  assert.deepEqual(received.order, ["metadata", "event"]);
});

test("首次扫描失败时 start reject 且不启动 timer", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "session-watcher-error-"));
  const root = join(parent, "root");
  await writeFile(root, "不是目录", "utf8");
  t.after(() => rm(parent, { recursive: true, force: true }));
  const watcher = new SessionWatcher({ root, pollIntervalMs: 10 });
  t.after(() => watcher.stop());
  const received = collect(watcher);

  await assert.rejects(watcher.start(), { code: "ENOTDIR" });

  await rm(root);
  await mkdir(root);
  await writeFile(
    join(root, "session.jsonl"),
    `${metadataLine}\n${eventLine("task_started", "turn-unexpected")}\n`,
    "utf8",
  );
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(received.order, []);
});

test("首次扫描进行中 stop 会取消后续轮询", async (t) => {
  const session = await createSessionFile(`${metadataLine}\n`);
  t.after(session.cleanup);
  const watcher = new SessionWatcher({ root: session.root, pollIntervalMs: 10 });
  t.after(() => watcher.stop());
  const received = collect(watcher);
  const originalScanOnce = watcher.scanOnce.bind(watcher);
  let releaseScan: (() => void) | undefined;
  const scanGate = new Promise<void>((resolve) => {
    releaseScan = resolve;
  });
  watcher.scanOnce = async () => {
    await scanGate;
    await originalScanOnce();
  };

  const startPromise = watcher.start();
  watcher.stop();
  releaseScan?.();
  await startPromise;

  await appendFile(session.file, `${eventLine("task_started", "turn-stopped")}\n`);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(received.events, []);
});

test("start 使用轮询读取追加事件且 stop 后不再扫描", async (t) => {
  const session = await createSessionFile(`${metadataLine}\n`);
  t.after(session.cleanup);
  const watcher = new SessionWatcher({ root: session.root, pollIntervalMs: 10 });
  t.after(() => watcher.stop());
  const received = collect(watcher);

  await watcher.start();
  await appendFile(session.file, `${eventLine("task_started", "turn-poll")}\n`);
  await waitFor(() => received.events.length === 1);
  watcher.stop();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(received.events.length, 1);

  await appendFile(session.file, `${eventLine("task_complete", "turn-poll")}\n`);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(received.events.length, 1);
});
