import { EventEmitter } from "node:events";

import { AppServerClient } from "./app-server-client.js";
import { resolveRuntimeCommand } from "./runtime-resolver.js";
import type { AppServerCommand } from "./app-server-client.js";
import type { CodexSource, RateLimitSnapshot, RateLimitWindow } from "./codex-state.js";
import type { ThreadSnapshot } from "./thread-aggregator.js";

export type AccountSnapshot = {
  email: string;
  planType: string | null;
  quota: RateLimitSnapshot;
  resolvedAt: number;
};

export type AccountResolution = {
  email: string;
  planType: string | null;
  resolvedAt: number;
  stale: boolean;
};

type ProbeAccountOptions = {
  createClient?: (command: AppServerCommand) => Pick<
    AppServerClient,
    "start" | "stop" | "readAccount" | "readRateLimits"
  >;
  now?: () => number;
};

type AccountResolverOptions = {
  probe?: (command: AppServerCommand) => Promise<AccountSnapshot>;
  resolveCommand?: (source: CodexSource) => AppServerCommand;
  sleep?: (delayMs: number) => Promise<void>;
  now?: () => number;
};

const RETRY_DELAYS = [0, 250, 500, 1000, 2000] as const;

export async function probeAccount(
  command: AppServerCommand,
  options: ProbeAccountOptions = {},
): Promise<AccountSnapshot> {
  const client = options.createClient?.(command) ?? new AppServerClient({ command });

  try {
    await client.start();
    const accountResponse = await client.readAccount();
    const account = accountResponse.account;
    if (account?.type !== "chatgpt") {
      throw new Error("当前 Codex 账号不是 ChatGPT 账号");
    }

    const email = account.email?.trim();
    if (!email) {
      throw new Error("ChatGPT 账号邮箱为空");
    }

    const rateLimitsResponse = await client.readRateLimits();
    return {
      email,
      planType: account.planType ?? null,
      quota: rateLimitsResponse.rateLimits,
      resolvedAt: options.now?.() ?? Date.now(),
    };
  } finally {
    client.stop();
  }
}

export function quotaMatches(expected: RateLimitSnapshot, actual: RateLimitSnapshot): boolean {
  return (
    windowMatches(expected.primary, actual.primary) &&
    windowMatches(expected.secondary, actual.secondary)
  );
}

export class AccountResolver extends EventEmitter {
  private readonly probe: (command: AppServerCommand) => Promise<AccountSnapshot>;
  private readonly resolveCommand: (source: CodexSource) => AppServerCommand;
  private readonly sleep: (delayMs: number) => Promise<void>;
  private generation = 0;
  private activeKey: string | null = null;
  private lastVerified: AccountSnapshot | null = null;
  private current: AccountResolution | null = null;

  constructor(options: AccountResolverOptions = {}) {
    super();
    this.probe = options.probe ?? ((command) => probeAccount(command, { now: options.now }));
    this.resolveCommand = options.resolveCommand ?? resolveRuntimeCommand;
    this.sleep = options.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
  }

  resolve(thread: ThreadSnapshot | null): AccountResolution | null {
    if (!thread?.source || !thread.quota) {
      this.cancelActiveProbe();
      return this.markStale();
    }

    const key = `${thread.threadId}\n${thread.source}\n${JSON.stringify(thread.quota)}`;
    if (key !== this.activeKey) {
      this.activeKey = key;
      const generation = ++this.generation;
      const source = thread.source;
      const quota = structuredClone(thread.quota);
      this.markStale();
      this.scheduleProbe(generation, source, quota, 0);
    }

    if (!this.current && this.lastVerified) {
      return this.markStale();
    }

    return this.current;
  }

  private scheduleProbe(
    generation: number,
    source: CodexSource,
    quota: RateLimitSnapshot,
    attempt: number,
  ): void {
    const delay = RETRY_DELAYS[attempt] ?? 30000;
    void this.sleep(delay).then(() => this.runProbe(generation, source, quota, attempt));
  }

  private async runProbe(
    generation: number,
    source: CodexSource,
    quota: RateLimitSnapshot,
    attempt: number,
  ): Promise<void> {
    if (generation !== this.generation) {
      return;
    }

    try {
      const snapshot = await this.probe(this.resolveCommand(source));
      if (generation !== this.generation) {
        return;
      }

      if (quotaMatches(quota, snapshot.quota)) {
        this.lastVerified = snapshot;
        this.setCurrent(toResolution(snapshot, false));
        return;
      }
    } catch {
      if (generation !== this.generation) {
        return;
      }
      this.markStale();
    }

    this.scheduleProbe(generation, source, quota, attempt + 1);
  }

  private cancelActiveProbe(): void {
    this.activeKey = null;
    this.generation += 1;
  }

  private markStale(): AccountResolution | null {
    if (!this.lastVerified) {
      this.setCurrent(null);
      return null;
    }

    const stale = toResolution(this.lastVerified, true);
    this.setCurrent(stale);
    return stale;
  }

  private setCurrent(next: AccountResolution | null): void {
    if (sameResolvedEvent(this.current, next)) {
      this.current = next;
      return;
    }

    this.current = next;
    if (next) {
      this.emit("resolved", next);
    }
  }
}

function windowMatches(
  expected: RateLimitWindow | null | undefined,
  actual: RateLimitWindow | null | undefined,
): boolean {
  if (!expected && !actual) {
    return true;
  }

  if (!expected || !actual) {
    return false;
  }

  return (
    (expected.resetsAt ?? null) === (actual.resetsAt ?? null) &&
    Math.abs(expected.usedPercent - actual.usedPercent) <= 1
  );
}

function toResolution(snapshot: AccountSnapshot, stale: boolean): AccountResolution {
  return {
    email: snapshot.email,
    planType: snapshot.planType,
    resolvedAt: snapshot.resolvedAt,
    stale,
  };
}

function sameResolvedEvent(left: AccountResolution | null, right: AccountResolution | null): boolean {
  return left?.email === right?.email && left?.stale === right?.stale;
}
