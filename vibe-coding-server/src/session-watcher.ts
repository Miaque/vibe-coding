import { EventEmitter } from "node:events";
import { open, readdir } from "node:fs/promises";
import { join } from "node:path";

import {
  parseSessionMetadata,
  parseSessionRecord,
  type SessionMetadata,
} from "./session-events.js";

export type FileCursor = {
  offset: number;
  pending: Buffer;
  metadata: SessionMetadata | null;
  activeTurnId: string | null;
  size: number;
  identity: {
    dev: number;
    ino: number;
  } | null;
};

export type SessionWatcherOptions = {
  root: string;
  pollIntervalMs?: number;
};

const DEFAULT_POLL_INTERVAL_MS = 1_000;

function createCursor(): FileCursor {
  return {
    offset: 0,
    pending: Buffer.alloc(0),
    metadata: null,
    activeTurnId: null,
    size: 0,
    identity: null,
  };
}

async function listSessionFiles(
  root: string,
  onError: (path: string, error: unknown) => void,
  isRoot = true,
): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isRoot && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    if (isRoot) {
      throw error;
    }
    onError(root, error);
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listSessionFiles(path, onError, false));
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(path);
    }
  }
  return files;
}

export class SessionWatcher extends EventEmitter {
  private readonly root: string;
  private readonly pollIntervalMs: number;
  private readonly cursors = new Map<string, FileCursor>();
  private timer: NodeJS.Timeout | null = null;
  private scanPromise: Promise<void> | null = null;
  private startGeneration = 0;

  constructor({ root, pollIntervalMs = DEFAULT_POLL_INTERVAL_MS }: SessionWatcherOptions) {
    super();
    this.root = root;
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
        this.emitScanError(this.root, error);
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
    const files = await listSessionFiles(
      this.root,
      (path, error) => this.emitScanError(path, error),
    );
    for (const file of files) {
      try {
        await this.scanFile(file);
      } catch (error) {
        this.emitScanError(file, error);
      }
    }
  }

  private async scanFile(path: string): Promise<void> {
    const cursor = this.cursors.get(path) ?? createCursor();
    this.cursors.set(path, cursor);

    let handle;
    try {
      handle = await open(path, "r");
      const { dev, ino, size } = await handle.stat();
      const identity = { dev, ino };
      if (
        (cursor.identity && (
          cursor.identity.dev !== identity.dev
          || cursor.identity.ino !== identity.ino
        ))
        || size < cursor.offset
      ) {
        Object.assign(cursor, createCursor(), { identity });
      } else if (!cursor.identity) {
        cursor.identity = identity;
      }
      cursor.size = size;

      if (size === cursor.offset) {
        return;
      }

      const buffer = Buffer.alloc(size - cursor.offset);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, cursor.offset);
      cursor.offset += bytesRead;
      cursor.size = cursor.offset;
      this.processBytes(cursor, buffer.subarray(0, bytesRead));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    } finally {
      await handle?.close();
    }
  }

  private emitScanError(path: string, error: unknown): void {
    this.emit("scanError", { path, error });
  }

  private processBytes(cursor: FileCursor, bytes: Buffer): void {
    const content = cursor.pending.length > 0
      ? Buffer.concat([cursor.pending, bytes])
      : bytes;
    let lineStart = 0;

    for (let index = 0; index < content.length; index += 1) {
      if (content[index] !== 0x0a) {
        continue;
      }

      let lineEnd = index;
      if (lineEnd > lineStart && content[lineEnd - 1] === 0x0d) {
        lineEnd -= 1;
      }
      this.processLine(cursor, content.subarray(lineStart, lineEnd).toString("utf8"));
      lineStart = index + 1;
    }

    cursor.pending = content.subarray(lineStart);
  }

  private processLine(cursor: FileCursor, line: string): void {
    if (!cursor.metadata) {
      const metadata = parseSessionMetadata(line);
      if (metadata) {
        cursor.metadata = metadata;
        this.emit("metadata", metadata);
      }
      return;
    }

    const event = parseSessionRecord(line, cursor.metadata, cursor.activeTurnId);
    if (!event) {
      return;
    }

    if (event.kind === "status" && event.status === "WORKING") {
      cursor.activeTurnId = event.turnId;
    } else if (
      event.kind === "status"
      && event.status === "IDLE"
      && event.turnId === cursor.activeTurnId
    ) {
      cursor.activeTurnId = null;
    }
    this.emit("event", event);
  }
}
