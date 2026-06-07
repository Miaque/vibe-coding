import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

function readStdin() {
  return new Promise((resolve, reject) => {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      input += chunk;
    });
    process.stdin.on("end", () => resolve(input));
    process.stdin.on("error", reject);
  });
}

function defaultRuntimeDir() {
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA;
    if (!localAppData) {
      throw new Error("LOCALAPPDATA 未设置");
    }
    return join(localAppData, "VibeCoding", "runtime");
  }
  return join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "vibe-coding");
}

function requireString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} 不能为空`);
  }
  return value;
}

function optionalString(value) {
  return typeof value === "string" ? value : undefined;
}

async function main() {
  const raw = await readStdin();
  const input = JSON.parse(raw);
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("hook 输入必须是 JSON object");
  }

  const receivedAt = Date.now();
  const event = {
    session_id: requireString(input.session_id, "session_id"),
    hook_event_name: requireString(input.hook_event_name, "hook_event_name"),
    cwd: requireString(input.cwd, "cwd"),
    receivedAt,
  };
  const turnId = optionalString(input.turn_id);
  const transcriptPath = optionalString(input.transcript_path);
  const model = optionalString(input.model);
  if (turnId !== undefined) {
    event.turn_id = turnId;
  }
  if (transcriptPath !== undefined) {
    event.transcript_path = transcriptPath;
  }
  if (model !== undefined) {
    event.model = model;
  }

  const runtimeDir = process.env.VIBE_CODING_RUNTIME_DIR || defaultRuntimeDir();
  const inboxDir = join(runtimeDir, "inbox");
  await mkdir(inboxDir, { recursive: true });

  const basename = `${receivedAt}-${process.pid}-${randomUUID()}`;
  const tmpPath = join(inboxDir, `${basename}.tmp`);
  const jsonPath = join(inboxDir, `${basename}.json`);
  await writeFile(tmpPath, `${JSON.stringify(event)}\n`, "utf8");
  await rename(tmpPath, jsonPath);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
