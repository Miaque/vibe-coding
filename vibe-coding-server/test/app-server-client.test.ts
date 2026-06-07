import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { execPath } from "node:process";
import { PassThrough } from "node:stream";
import test from "node:test";

import { AppServerClient, resolveCodexAppServerCommand } from "../src/app-server-client.js";

function createFakeProcess() {
  const process = new EventEmitter();
  process.stdin = new PassThrough();
  process.stdout = new PassThrough();
  process.stderr = new PassThrough();
  process.kill = () => {};
  return process;
}

function readMessages(stream) {
  const messages = [];
  let buffer = "";

  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) {
        return;
      }

      messages.push(JSON.parse(buffer.slice(0, newline)));
      buffer = buffer.slice(newline + 1);
    }
  });

  return messages;
}

test("AppServerClient 在读取配额前先完成初始化", async () => {
  const process = createFakeProcess();
  const sent = readMessages(process.stdin);
  const client = new AppServerClient({ spawnServer: () => process });

  const started = client.start();
  assert.equal(sent[0].method, "initialize");
  assert.equal(sent[0].params.capabilities, null);

  process.stdout.write(`${JSON.stringify({ id: 1, result: {} })}\n`);
  await started;

  assert.deepEqual(sent[1], { method: "initialized" });

  const response = client.readRateLimits();
  assert.deepEqual(sent[2], { method: "account/rateLimits/read", id: 2 });

  process.stdout.write(
    `${JSON.stringify({ id: 2, result: { rateLimits: { limitId: "codex" } } })}\n`,
  );

  assert.deepEqual(await response, { rateLimits: { limitId: "codex" } });
});

test("AppServerClient 触发配额更新事件", async () => {
  const process = createFakeProcess();
  const client = new AppServerClient({ spawnServer: () => process });

  const started = client.start();
  process.stdout.write(`${JSON.stringify({ id: 1, result: {} })}\n`);
  await started;

  const update = new Promise((resolve) => client.once("rateLimitsUpdated", resolve));
  process.stdout.write(
    `${JSON.stringify({
      method: "account/rateLimits/updated",
      params: { rateLimits: { limitId: "codex" } },
    })}\n`,
  );

  assert.deepEqual(await update, { limitId: "codex" });
});

test("AppServerClient 读取账号信息时不刷新 token", async () => {
  const process = createFakeProcess();
  const sent = readMessages(process.stdin);
  const client = new AppServerClient({ spawnServer: () => process });

  const started = client.start();
  process.stdout.write(`${JSON.stringify({ id: 1, result: {} })}\n`);
  await started;

  const response = client.readAccount();
  assert.deepEqual(sent[2], { method: "account/read", id: 2, params: {} });

  process.stdout.write(
    `${JSON.stringify({
      id: 2,
      result: {
        account: { type: "chatgpt", email: "user@example.com", planType: "plus" },
        requiresOpenaiAuth: true,
      },
    })}\n`,
  );

  assert.deepEqual(await response, {
    account: { type: "chatgpt", email: "user@example.com", planType: "plus" },
    requiresOpenaiAuth: true,
  });
});

test("AppServerClient 在 app-server 退出时拒绝未完成的请求", async () => {
  const process = createFakeProcess();
  const client = new AppServerClient({ spawnServer: () => process });

  const started = client.start();
  process.stdout.write(`${JSON.stringify({ id: 1, result: {} })}\n`);
  await started;

  const response = client.readRateLimits();
  process.emit("exit", 1);

  await assert.rejects(response, /已退出，退出码：1/);
});

test("AppServerClient 在 app-server 退出后拒绝新的请求", async () => {
  const process = createFakeProcess();
  const client = new AppServerClient({ spawnServer: () => process });

  const started = client.start();
  process.stdout.write(`${JSON.stringify({ id: 1, result: {} })}\n`);
  await started;
  process.emit("exit", 1);

  await assert.rejects(client.readRateLimits(), /已退出，退出码：1/);
});

test("AppServerClient 停止时关闭流并拒绝未完成的请求", async () => {
  const process = createFakeProcess();
  let killed = false;
  process.kill = () => {
    killed = true;
  };
  const client = new AppServerClient({ spawnServer: () => process });

  const started = client.start();
  process.stdout.write(`${JSON.stringify({ id: 1, result: {} })}\n`);
  await started;

  const pending = client.readRateLimits();
  client.stop();

  await assert.rejects(pending, /已停止/);
  assert.equal(killed, true);
  assert.equal(process.listenerCount("error"), 0);
  assert.equal(process.listenerCount("exit"), 0);
});

test("AppServerClient 可以在进程启动前停止", () => {
  const client = new AppServerClient({ spawnServer: createFakeProcess });

  assert.doesNotThrow(() => client.stop());
});

test("resolveCodexAppServerCommand 支持显式指定 app-server 可执行文件", () => {
  const original = process.env.CODEX_APP_SERVER_COMMAND;
  process.env.CODEX_APP_SERVER_COMMAND = "C:\\Codex\\codex.exe";

  try {
    assert.deepEqual(resolveCodexAppServerCommand(), {
      command: "C:\\Codex\\codex.exe",
      args: ["app-server"],
      shell: false,
    });
  } finally {
    if (original === undefined) {
      delete process.env.CODEX_APP_SERVER_COMMAND;
    } else {
      process.env.CODEX_APP_SERVER_COMMAND = original;
    }
  }
});

test("AppServerClient 支持使用显式命令启动 app-server", async () => {
  const script = `
    const readline = require("node:readline");
    const lines = readline.createInterface({ input: process.stdin });
    lines.on("line", (line) => {
      const message = JSON.parse(line);
      if (message.method === "initialize") {
        process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\\n");
      }
      if (message.method === "account/rateLimits/read") {
        process.stdout.write(JSON.stringify({
          id: message.id,
          result: { rateLimits: { limitId: "codex" } }
        }) + "\\n");
      }
    });
  `;
  const client = new AppServerClient({
    command: {
      command: execPath,
      args: ["-e", script],
      shell: false,
    },
  });

  await client.start();
  assert.deepEqual(await client.readRateLimits(), { rateLimits: { limitId: "codex" } });
  client.stop();
});
