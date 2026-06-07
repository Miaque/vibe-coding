import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import readline from "node:readline";
import type { ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";

import { resolveRuntimeCommand } from "./runtime-resolver.js";
import type { Account, RateLimits } from "./quota.js";

export type AppServerProcess = ChildProcessByStdio<Writable, Readable, null>;

export type AppServerCommand = {
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

export function resolveCodexAppServerCommand(): AppServerCommand {
  if (process.env.CODEX_APP_SERVER_COMMAND) {
    return {
      command: process.env.CODEX_APP_SERVER_COMMAND,
      args: ["app-server"],
      shell: false,
    };
  }

  return resolveRuntimeCommand("desktop");
}

function spawnAppServer({ command, args, shell }: AppServerCommand): AppServerProcess {
  return spawn(command, args, {
    shell,
    stdio: ["pipe", "pipe", "inherit"],
  });
}

function spawnCodexAppServer(): AppServerProcess {
  return spawnAppServer(resolveCodexAppServerCommand());
}

export class AppServerClient extends EventEmitter {
  private spawnServer: () => AppServerProcess;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private server: AppServerProcess | null = null;
  private lines: readline.Interface | null = null;
  private exitError: Error | null = null;

  constructor({
    spawnServer,
    command,
  }: { spawnServer?: () => AppServerProcess; command?: AppServerCommand } = {}) {
    super();
    this.spawnServer = command ? () => spawnAppServer(command) : spawnServer ?? spawnCodexAppServer;
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
