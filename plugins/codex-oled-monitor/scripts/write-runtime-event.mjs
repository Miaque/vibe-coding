import { randomUUID } from "node:crypto";
import { appendFile, mkdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

let rawInput = "";

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

function runtimeDir() {
  return process.env.VIBE_CODING_RUNTIME_DIR || defaultRuntimeDir();
}

function parseLogInput(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

async function writeErrorLog(error) {
  const logsDir = join(runtimeDir(), "logs");
  await mkdir(logsDir, { recursive: true });
  const record = {
    timestamp: new Date().toISOString(),
    error: error instanceof Error ? error.stack ?? error.message : String(error),
    input: parseLogInput(rawInput),
  };
  await appendFile(join(logsDir, "hook-errors.log"), `${JSON.stringify(record)}\n`, "utf8");
}

async function main() {
  rawInput = await readStdin();
  const input = JSON.parse(rawInput);
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

  const inboxDir = join(runtimeDir(), "inbox");
  await mkdir(inboxDir, { recursive: true });

  const basename = `${receivedAt}-${process.pid}-${randomUUID()}`;
  const tmpPath = join(inboxDir, `${basename}.tmp`);
  const jsonPath = join(inboxDir, `${basename}.json`);
  await writeFile(tmpPath, `${JSON.stringify(event)}\n`, "utf8");
  await rename(tmpPath, jsonPath);
}

main().catch(async (error) => {
  try {
    await writeErrorLog(error);
  } catch (logError) {
    console.error(`hook 异常日志写入失败: ${logError instanceof Error ? logError.message : String(logError)}`);
  }
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
