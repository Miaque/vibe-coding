import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
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

test("AppServerClient initializes before requesting rate limits", async () => {
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

test("AppServerClient emits rate limit updates", async () => {
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

test("AppServerClient reads account details without refreshing the token", async () => {
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

test("AppServerClient rejects pending requests when app-server exits", async () => {
  const process = createFakeProcess();
  const client = new AppServerClient({ spawnServer: () => process });

  const started = client.start();
  process.stdout.write(`${JSON.stringify({ id: 1, result: {} })}\n`);
  await started;

  const response = client.readRateLimits();
  process.emit("exit", 1);

  await assert.rejects(response, /exited with code 1/);
});

test("AppServerClient rejects new requests after app-server exits", async () => {
  const process = createFakeProcess();
  const client = new AppServerClient({ spawnServer: () => process });

  const started = client.start();
  process.stdout.write(`${JSON.stringify({ id: 1, result: {} })}\n`);
  await started;
  process.emit("exit", 1);

  await assert.rejects(client.readRateLimits(), /exited with code 1/);
});

test("AppServerClient stop closes streams and rejects pending requests", async () => {
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

  await assert.rejects(pending, /stopped/);
  assert.equal(killed, true);
  assert.equal(process.listenerCount("error"), 0);
  assert.equal(process.listenerCount("exit"), 0);
});

test("AppServerClient can stop before the process is started", () => {
  const client = new AppServerClient({ spawnServer: createFakeProcess });

  assert.doesNotThrow(() => client.stop());
});

test("resolveCodexAppServerCommand allows explicitly selecting the app-server executable", () => {
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
