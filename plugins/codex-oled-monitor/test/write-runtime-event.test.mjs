import assert from "node:assert/strict";
import { readdir, readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";

const scriptPath = resolve("plugins/codex-oled-monitor/scripts/write-runtime-event.mjs");
const hooksPath = resolve("plugins/codex-oled-monitor/hooks/hooks.json");
const pluginRoot = resolve("plugins/codex-oled-monitor");

function runWriter(input, runtimeDir) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [scriptPath], {
      env: {
        ...process.env,
        VIBE_CODING_RUNTIME_DIR: runtimeDir,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(new Error(`hook writer exited ${code}: ${stderr}`));
    });
    child.stdin.end(JSON.stringify(input), "utf8");
  });
}

test("write-runtime-event 原子写入 hook 事件", async (t) => {
  const runtimeDir = await mkdtemp(join(tmpdir(), "codex-oled-hook-"));
  t.after(() => rm(runtimeDir, { recursive: true, force: true }));

  await runWriter(
    {
      session_id: "session-1",
      turn_id: "turn-1",
      transcript_path: "C:\\sessions\\thread.jsonl",
      cwd: "H:\\workspace\\repo",
      hook_event_name: "PermissionRequest",
      model: "gpt-5.5",
    },
    runtimeDir,
  );

  const inbox = join(runtimeDir, "inbox");
  const files = await readdir(inbox);
  assert.equal(files.length, 1);
  assert.match(files[0], /\.json$/);

  const event = JSON.parse(await readFile(join(inbox, files[0]), "utf8"));
  assert.equal(event.session_id, "session-1");
  assert.equal(event.turn_id, "turn-1");
  assert.equal(event.transcript_path, "C:\\sessions\\thread.jsonl");
  assert.equal(event.cwd, "H:\\workspace\\repo");
  assert.equal(event.hook_event_name, "PermissionRequest");
  assert.equal(event.model, "gpt-5.5");
  assert.equal(typeof event.receivedAt, "number");
  assert.ok(event.receivedAt > 1_700_000_000_000);
});

test("write-runtime-event 将执行异常追加到日志文件", async (t) => {
  const runtimeDir = await mkdtemp(join(tmpdir(), "codex-oled-hook-"));
  t.after(() => rm(runtimeDir, { recursive: true, force: true }));

  const input = {
    cwd: "H:\\workspace\\repo",
    hook_event_name: "PermissionRequest",
  };

  await assert.rejects(
    runWriter(input, runtimeDir),
    /hook writer exited 1: session_id 不能为空/,
  );
  await assert.rejects(
    runWriter(input, runtimeDir),
    /hook writer exited 1: session_id 不能为空/,
  );

  const logPath = join(runtimeDir, "logs", "hook-errors.log");
  const records = (await readFile(logPath, "utf8")).trim().split("\n");
  assert.equal(records.length, 2);

  const record = JSON.parse(records[0]);
  assert.match(record.timestamp, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(record.error, /Error: session_id 不能为空/);
  assert.deepEqual(record.input, input);
});

test("hook 命令兼容 Codex 的 Windows 扩展路径", async (t) => {
  const config = JSON.parse(await readFile(hooksPath, "utf8"));
  const hook = config.hooks.Stop[0].hooks[0];

  assert.equal(
    hook.command,
    "node \"${CLAUDE_PLUGIN_ROOT}/scripts/write-runtime-event.mjs\"",
  );
  assert.equal(
    hook.commandWindows,
    "node -e \"const{join}=require('node:path'),{pathToFileURL}=require('node:url'),r=process.env.CLAUDE_PLUGIN_ROOT,p=r[2]==='?'?r.slice(4):r;import(pathToFileURL(join(p,'scripts','write-runtime-event.mjs')).href)\"",
  );

  if (process.platform !== "win32") {
    t.skip("仅在 Windows 验证扩展路径");
    return;
  }

  const runtimeDir = await mkdtemp(join(tmpdir(), "codex-oled-hook-"));
  t.after(() => rm(runtimeDir, { recursive: true, force: true }));
  await runWindowsHook(hook.commandWindows, runtimeDir, pluginRoot);
  await runWindowsHook(hook.commandWindows, runtimeDir, `\\\\?\\${pluginRoot}`);

  const files = await readdir(join(runtimeDir, "inbox"));
  assert.equal(files.length, 2);
});

function runWindowsHook(command, runtimeDir, root) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.env.ComSpec ?? "cmd.exe", ["/C", command], {
      env: {
        ...process.env,
        CLAUDE_PLUGIN_ROOT: root,
        VIBE_CODING_RUNTIME_DIR: runtimeDir,
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsVerbatimArguments: true,
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(new Error(`Windows hook exited ${code}: ${stderr}`));
    });
    child.stdin.end(JSON.stringify({
      session_id: "session-1",
      cwd: "H:\\workspace\\repo",
      hook_event_name: "Stop",
    }), "utf8");
  });
}
