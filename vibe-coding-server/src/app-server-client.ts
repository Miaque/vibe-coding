import { execFileSync, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import type { ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";

import type { Account, RateLimits } from "./quota.js";

type AppServerProcess = ChildProcessByStdio<Writable, Readable, null>;

type AppServerCommand = {
  command: string;
  args: string[];
  shell: boolean;
};

type JsonRpcRequest = {
  method: string;
  id?: number;
  params?: unknown;
};

type JsonRpcResponse = {
  id?: number;
  method?: string;
  params?: {
    rateLimits?: RateLimits;
  };
  result?: unknown;
  error?: {
    message?: string;
  };
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

export type RateLimitsResponse = {
  rateLimits: RateLimits;
};

export type AccountResponse = {
  account: Account;
  requiresOpenaiAuth?: boolean;
};

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

export function resolveCodexAppServerCommand(): AppServerCommand {
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

function spawnCodexAppServer(): AppServerProcess {
  const { command, args, shell } = resolveCodexAppServerCommand();
  return spawn(command, args, {
    shell,
    stdio: ["pipe", "pipe", "inherit"],
  });
}

export class AppServerClient extends EventEmitter {
  private spawnServer: () => AppServerProcess;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private server: AppServerProcess | null = null;
  private lines: readline.Interface | null = null;
  private exitError: Error | null = null;

  constructor({ spawnServer = spawnCodexAppServer }: { spawnServer?: () => AppServerProcess } = {}) {
    super();
    this.spawnServer = spawnServer;
  }

  async start(): Promise<void> {
    this.server = this.spawnServer();
    this.server.on("error", (error: Error) => {
      this.exitError = error;
      this.rejectPending(error);
    });
    this.server.on("exit", (code: number | null) => {
      this.exitError = new Error(`codex app-server 已退出，退出码：${code}`);
      this.rejectPending(this.exitError);
    });
    this.lines = readline.createInterface({ input: this.server.stdout });
    this.lines.on("line", (line) => this.handleLine(line));

    await this.request("initialize", {
      clientInfo: {
        name: "codex_quota_mqtt",
        title: "Codex 配额 MQTT",
        version: "0.1.0",
      },
      capabilities: null,
    });
    this.send({ method: "initialized" });
  }

  readRateLimits(): Promise<RateLimitsResponse> {
    return this.request<RateLimitsResponse>("account/rateLimits/read");
  }

  readAccount(): Promise<AccountResponse> {
    return this.request<AccountResponse>("account/read", {});
  }

  stop(): void {
    this.rejectPending(new Error("codex app-server 已停止"));
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

  request<T>(method: string, params?: unknown): Promise<T> {
    if (this.exitError) {
      return Promise.reject(this.exitError);
    }

    const id = this.nextId++;
    const message: JsonRpcRequest = { method, id };
    if (params !== undefined) {
      message.params = params;
    }

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
      this.send(message);
    });
  }

  send(message: JsonRpcRequest): void {
    if (!this.server) {
      throw new Error("codex app-server 尚未启动");
    }

    this.server.stdin.write(`${JSON.stringify(message)}\n`);
  }

  handleLine(line: string): void {
    const message = JSON.parse(line) as JsonRpcResponse;

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

    if (message.method === "account/rateLimits/updated" && message.params?.rateLimits) {
      this.emit("rateLimitsUpdated", message.params.rateLimits);
    }
  }

  rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}
