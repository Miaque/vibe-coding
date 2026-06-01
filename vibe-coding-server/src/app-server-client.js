import { execFileSync, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";

function findLocalDesktopCodexCommand() {
  const localAppData = process.env.LOCALAPPDATA;

  if (!localAppData) {
    return null;
  }

  const binRoot = path.join(localAppData, "OpenAI", "Codex", "bin");

  if (!existsSync(binRoot)) {
    return null;
  }

  try {
    return readdirSync(binRoot)
      .map((entry) => path.join(binRoot, entry, "codex.exe"))
      .filter((candidate) => existsSync(candidate))
      .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)[0] ?? null;
  } catch {
    return null;
  }
}

function findDesktopCodexCommand() {
  if (process.platform !== "win32") {
    return null;
  }

  const localCommand = findLocalDesktopCodexCommand();

  if (localCommand) {
    return localCommand;
  }

  try {
    const output = execFileSync("where.exe", ["codex"], { encoding: "utf8" });
    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.includes("\\OpenAI.Codex_") && line.endsWith("\\app\\resources\\codex.exe")) ?? null;
  } catch {
    return null;
  }
}

export function resolveCodexAppServerCommand() {
  if (process.env.CODEX_APP_SERVER_COMMAND) {
    return {
      command: process.env.CODEX_APP_SERVER_COMMAND,
      args: ["app-server"],
      shell: false,
    };
  }

  const desktopCommand = findDesktopCodexCommand();

  if (desktopCommand) {
    return {
      command: desktopCommand,
      args: ["app-server"],
      shell: false,
    };
  }

  if (process.platform === "win32") {
    return {
      command: process.env.ComSpec ?? "cmd.exe",
      args: ["/d", "/s", "/c", "codex app-server"],
      shell: false,
    };
  }

  return {
    command: "codex",
    args: ["app-server"],
    shell: false,
  };
}

function spawnCodexAppServer() {
  const { command, args, shell } = resolveCodexAppServerCommand();
  return spawn(command, args, {
    shell,
    stdio: ["pipe", "pipe", "inherit"],
  });
}

export class AppServerClient extends EventEmitter {
  constructor({ spawnServer = spawnCodexAppServer } = {}) {
    super();
    this.spawnServer = spawnServer;
    this.nextId = 1;
    this.pending = new Map();
  }

  async start() {
    this.server = this.spawnServer();
    this.server.on("error", (error) => {
      this.exitError = error;
      this.rejectPending(error);
    });
    this.server.on("exit", (code) => {
      this.exitError = new Error(`codex app-server exited with code ${code}`);
      this.rejectPending(this.exitError);
    });
    this.lines = readline.createInterface({ input: this.server.stdout });
    this.lines.on("line", (line) => this.handleLine(line));

    await this.request("initialize", {
      clientInfo: {
        name: "codex_quota_mqtt",
        title: "Codex Quota MQTT",
        version: "0.1.0",
      },
      capabilities: null,
    });
    this.send({ method: "initialized" });
  }

  readRateLimits() {
    return this.request("account/rateLimits/read");
  }

  readAccount() {
    return this.request("account/read", {});
  }

  stop() {
    this.rejectPending(new Error("codex app-server stopped"));
    this.lines?.removeAllListeners();
    this.lines?.close();
    this.lines = null;

    if (this.server) {
      this.server.removeAllListeners("error");
      this.server.removeAllListeners("exit");
      this.server.stdin?.end();
      this.server.kill();
      this.server = null;
    }
  }

  request(method, params) {
    if (this.exitError) {
      return Promise.reject(this.exitError);
    }

    const id = this.nextId++;
    const message = { method, id };
    if (params !== undefined) {
      message.params = params;
    }

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send(message);
    });
  }

  send(message) {
    this.server.stdin.write(`${JSON.stringify(message)}\n`);
  }

  handleLine(line) {
    const message = JSON.parse(line);

    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }

      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.method === "account/rateLimits/updated") {
      this.emit("rateLimitsUpdated", message.params.rateLimits);
    }
  }

  rejectPending(error) {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}
