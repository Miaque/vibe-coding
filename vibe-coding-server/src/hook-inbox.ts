import { EventEmitter } from "node:events";
import { mkdir, readdir, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";

import type { CodexStatus, NormalizedEvent } from "./codex-state.js";

type HookInboxOptions = {
  runtimeDir: string;
  pollIntervalMs?: number;
};

type HookRecord = {
  session_id: string;
  turn_id?: string;
  hook_event_name: string;
  receivedAt: number;
};

const DEFAULT_POLL_INTERVAL_MS = 500;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function statusForHook(name: string): CodexStatus | null {
  if (name === "PermissionRequest") {
    return "WAIT";
  }
  if (name === "UserPromptSubmit") {
    return "WORKING";
  }
  if (name === "Stop") {
    return "IDLE";
  }
  return null;
}

function parseHookRecord(content: string): HookRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return null;
  }
  if (!isObject(value)) {
    return null;
  }

  const sessionId = value.session_id;
  const turnId = value.turn_id;
  const hookEventName = value.hook_event_name;
  const receivedAt = value.receivedAt;
  if (
    typeof sessionId !== "string"
    || sessionId.trim() === ""
    || (turnId !== undefined && typeof turnId !== "string")
    || typeof hookEventName !== "string"
    || typeof receivedAt !== "number"
    || !Number.isFinite(receivedAt)
  ) {
    return null;
  }

  return {
    session_id: sessionId,
    turn_id: turnId,
    hook_event_name: hookEventName,
    receivedAt,
  };
}

export class HookInbox extends EventEmitter {
  private readonly runtimeDir: string;
  private readonly inboxDir: string;
  private readonly rejectedDir: string;
  private readonly pollIntervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private scanPromise: Promise<void> | null = null;
  private startGeneration = 0;

  constructor({ runtimeDir, pollIntervalMs = DEFAULT_POLL_INTERVAL_MS }: HookInboxOptions) {
    super();
    this.runtimeDir = runtimeDir;
    this.inboxDir = join(runtimeDir, "inbox");
    this.rejectedDir = join(runtimeDir, "rejected");
    this.pollIntervalMs = pollIntervalMs;
  }

  scanOnce(): Promise<void> {
    if (this.scanPromise) {
      return this.scanPromise;
    }

    this.scanPromise = this.scan().finally(() => {
      this.scanPromise = null;
    });
    return this.scanPromise;
  }

  async start(): Promise<void> {
    if (this.timer) {
      return;
    }

    const generation = ++this.startGeneration;
    await this.scanOnce();
    if (generation !== this.startGeneration || this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      void this.scanOnce().catch((error) => {
        this.emit("scanError", { path: this.inboxDir, error });
      });
    }, this.pollIntervalMs);
  }

  stop(): void {
    this.startGeneration += 1;
    if (!this.timer) {
      return;
    }

    clearInterval(this.timer);
    this.timer = null;
  }

  private async scan(): Promise<void> {
    await mkdir(this.inboxDir, { recursive: true });
    const entries = await readdir(this.inboxDir, { withFileTypes: true });
    const files = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name)
      .sort();

    for (const file of files) {
      await this.consumeFile(file);
    }
  }

  private async consumeFile(file: string): Promise<void> {
    const path = join(this.inboxDir, file);
    const content = await readFile(path, "utf8");
    const record = parseHookRecord(content);
    const status = record ? statusForHook(record.hook_event_name) : null;
    if (!record || !status) {
      await this.rejectFile(path, file);
      return;
    }

    const event: NormalizedEvent = {
      kind: "status",
      threadId: record.session_id,
      sessionId: record.session_id,
      turnId: record.turn_id ?? null,
      occurredAt: record.receivedAt,
      status,
    };
    this.emit("event", event);
    await rm(path, { force: true });
  }

  private async rejectFile(path: string, file: string): Promise<void> {
    await mkdir(this.rejectedDir, { recursive: true });
    const destination = join(this.rejectedDir, file);
    try {
      await rename(path, destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }
}
