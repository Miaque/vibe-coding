import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveRuntimeCommand } from "../src/runtime-resolver.js";

function tempLocalAppData() {
  return path.join(tmpdir(), `codex-runtime-${Date.now()}-${Math.random()}`);
}

test("Desktop 解析到 LOCALAPPDATA 下最新的可执行文件", () => {
  const localAppData = tempLocalAppData();
  const older = path.join(localAppData, "OpenAI", "Codex", "bin", "old", "codex.exe");
  const newer = path.join(localAppData, "OpenAI", "Codex", "bin", "new", "codex.exe");
  mkdirSync(path.dirname(older), { recursive: true });
  mkdirSync(path.dirname(newer), { recursive: true });
  writeFileSync(older, "");
  writeFileSync(newer, "");

  const mtimes = new Map([
    [older, 1000],
    [newer, 2000],
  ]);

  assert.deepEqual(
    resolveRuntimeCommand("desktop", {
      env: { LOCALAPPDATA: localAppData },
      platform: "win32",
      statMtimeMs: (file) => mtimes.get(file) ?? 0,
    }),
    {
      command: newer,
      args: ["app-server"],
      shell: false,
    },
  );
});

test("CLI 优先使用 CODEX_CLI_COMMAND，否则使用 PATH 中的 codex", () => {
  assert.deepEqual(
    resolveRuntimeCommand("cli", {
      env: { CODEX_CLI_COMMAND: "C:\\tools\\codex.exe" },
      platform: "win32",
    }),
    {
      command: "C:\\tools\\codex.exe",
      args: ["app-server"],
      shell: false,
    },
  );

  assert.deepEqual(resolveRuntimeCommand("cli", { env: {}, platform: "win32" }), {
    command: "cmd.exe",
    args: ["/d", "/s", "/c", "codex app-server"],
    shell: false,
  });
});

test("CODEX_DESKTOP_COMMAND 覆盖 Desktop 自动发现", () => {
  assert.deepEqual(
    resolveRuntimeCommand("desktop", {
      env: { CODEX_DESKTOP_COMMAND: "D:\\Codex\\codex.exe" },
      platform: "win32",
    }),
    {
      command: "D:\\Codex\\codex.exe",
      args: ["app-server"],
      shell: false,
    },
  );
});

test("Desktop 从 where.exe 输出中选择 Desktop runtime", () => {
  assert.deepEqual(
    resolveRuntimeCommand("desktop", {
      env: {},
      platform: "win32",
      whereCodex: () =>
        [
          "C:\\Users\\user\\AppData\\Roaming\\npm\\codex.cmd",
          "C:\\Program Files\\WindowsApps\\OpenAI.Codex_1.2.3.0_x64__8wekyb3d8bbwe\\app\\resources\\codex.exe",
        ].join("\r\n"),
    }),
    {
      command:
        "C:\\Program Files\\WindowsApps\\OpenAI.Codex_1.2.3.0_x64__8wekyb3d8bbwe\\app\\resources\\codex.exe",
      args: ["app-server"],
      shell: false,
    },
  );
});

test("Ubuntu CLI 解析为 codex app-server", () => {
  assert.deepEqual(resolveRuntimeCommand("cli", { env: {}, platform: "linux" }), {
    command: "codex",
    args: ["app-server"],
    shell: false,
  });
});
