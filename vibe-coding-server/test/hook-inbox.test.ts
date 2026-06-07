import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { NormalizedEvent } from "../src/codex-state.js";
import { HookInbox } from "../src/hook-inbox.js";

async function createRuntime(): Promise<{ runtimeDir: string; inboxDir: string; cleanup: () => Promise<void> }> {
  const runtimeDir = await mkdtemp(join(tmpdir(), "hook-inbox-"));
  const inboxDir = join(runtimeDir, "inbox");
  await mkdir(inboxDir);
  return {
    runtimeDir,
    inboxDir,
    cleanup: () => rm(runtimeDir, { recursive: true, force: true }),
  };
}

async function writeHookFile(
  inboxDir: string,
  name: string,
  hookEventName: string,
  receivedAt: number,
): Promise<string> {
  const path = join(inboxDir, name);
  await writeFile(
    path,
    JSON.stringify({
      session_id: `session-${name}`,
      turn_id: `turn-${name}`,
      hook_event_name: hookEventName,
      cwd: "H:\\workspace\\repo",
      receivedAt,
    }),
    "utf8",
  );
  return path;
}

test("HookInbox 按 oldest-first 消费已有文件并映射状态", async (t) => {
  const runtime = await createRuntime();
  t.after(runtime.cleanup);
  await writeFile(join(runtime.runtimeDir, ".keep"), "", "utf8");
  await writeHookFile(runtime.inboxDir, "200-b.json", "Stop", 200);
  await writeHookFile(runtime.inboxDir, "100-a.json", "PermissionRequest", 100);
  await writeHookFile(runtime.inboxDir, "150-c.json", "UserPromptSubmit", 150);
  const inbox = new HookInbox({ runtimeDir: runtime.runtimeDir });
  const events: NormalizedEvent[] = [];
  inbox.on("event", (event: NormalizedEvent) => events.push(event));

  await inbox.start();
  inbox.stop();

  assert.deepEqual(events.map((event) => [event.occurredAt, event.status]), [
    [100, "WAIT"],
    [150, "WORKING"],
    [200, "IDLE"],
  ]);
  assert.deepEqual(events.map((event) => event.source), [undefined, undefined, undefined]);
  assert.deepEqual(await readdir(runtime.inboxDir), []);
});

test("HookInbox 只在成功 emit 后删除文件", async (t) => {
  const runtime = await createRuntime();
  t.after(runtime.cleanup);
  await writeHookFile(runtime.inboxDir, "100-a.json", "PermissionRequest", 100);
  const inbox = new HookInbox({ runtimeDir: runtime.runtimeDir });
  inbox.on("event", () => {
    throw new Error("模拟消费者失败");
  });

  await assert.rejects(inbox.start(), /模拟消费者失败/);

  assert.deepEqual(await readdir(runtime.inboxDir), ["100-a.json"]);
});

test("HookInbox 将无效文件移动到 rejected", async (t) => {
  const runtime = await createRuntime();
  t.after(runtime.cleanup);
  await writeFile(join(runtime.inboxDir, "100-bad.json"), "{坏 JSON", "utf8");
  await writeFile(
    join(runtime.inboxDir, "200-unknown.json"),
    JSON.stringify({
      session_id: "session-2",
      hook_event_name: "Other",
      cwd: "H:\\workspace\\repo",
      receivedAt: 200,
    }),
    "utf8",
  );
  const inbox = new HookInbox({ runtimeDir: runtime.runtimeDir });

  await inbox.start();
  inbox.stop();

  assert.deepEqual(await readdir(runtime.inboxDir), []);
  const rejected = await readdir(join(runtime.runtimeDir, "rejected"));
  assert.deepEqual(rejected.sort(), ["100-bad.json", "200-unknown.json"]);
  assert.equal(await readFile(join(runtime.runtimeDir, "rejected", "100-bad.json"), "utf8"), "{坏 JSON");
});

test("HookInbox 首次扫描进行中 stop 会取消后续轮询", async (t) => {
  const runtime = await createRuntime();
  t.after(runtime.cleanup);
  const inbox = new HookInbox({ runtimeDir: runtime.runtimeDir, pollIntervalMs: 10 });
  t.after(() => inbox.stop());
  const events: NormalizedEvent[] = [];
  inbox.on("event", (event: NormalizedEvent) => events.push(event));
  const originalScanOnce = inbox.scanOnce.bind(inbox);
  let releaseScan: (() => void) | undefined;
  const scanGate = new Promise<void>((resolve) => {
    releaseScan = resolve;
  });
  inbox.scanOnce = async () => {
    await scanGate;
    await originalScanOnce();
  };

  const startPromise = inbox.start();
  inbox.stop();
  releaseScan?.();
  await startPromise;

  await writeHookFile(runtime.inboxDir, "100-a.json", "PermissionRequest", 100);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(events, []);
});
