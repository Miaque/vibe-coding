import assert from "node:assert/strict";
import { readdir, readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";

const scriptPath = resolve("plugins/codex-oled-monitor/scripts/write-runtime-event.mjs");

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
