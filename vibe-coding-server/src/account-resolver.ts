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

export class AccountVerificationError extends Error {
  readonly account: AccountResolution;

  constructor(account: AccountResolution, cause: unknown) {
    super("账号已读取，但额度验证失败", { cause });
    this.name = "AccountVerificationError";
    this.account = account;
  }
}

type ProbeAccountOptions = {
  createClient?: (command: AppServerCommand) => Pick<
    AppServerClient,
    "start" | "stop" | "readAccount" | "readRateLimits"
  >;
  now?: () => number;
  signal?: AbortSignal;
};

type AccountResolverOptions = {
  probe?: (command: AppServerCommand, signal: AbortSignal) => Promise<AccountSnapshot>;
  resolveCommand?: (source: CodexSource) => AppServerCommand;
  sleep?: (delayMs: number) => Promise<void>;
  probeTimeout?: (delayMs: number) => Promise<void>;
  now?: () => number;
};

type ProbeTarget = {
  generation: number;
  source: CodexSource;
  quota: RateLimitSnapshot;
  attempt: number;
};

const RETRY_DELAYS = [0, 250, 500, 1000, 2000] as const;
const PROBE_TIMEOUT_MS = 10000;

export async function probeAccount(
  command: AppServerCommand,
  options: ProbeAccountOptions = {},
): Promise<AccountSnapshot> {
  const client = options.createClient?.(command) ?? new AppServerClient({ command });
  let abortHandler: (() => void) | null = null;
  const aborted = options.signal
    ? new Promise<never>((_resolve, reject) => {
        abortHandler = () => {
          client.stop();
          reject(new Error("账号探测已中止"));
        };
        if (options.signal?.aborted) {
          abortHandler();
        } else {
          options.signal?.addEventListener("abort", abortHandler, { once: true });
        }
      })
    : null;

  try {
    const probe = async () => {
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

      const resolvedAt = options.now?.() ?? Date.now();
      let rateLimitsResponse;
      try {
        rateLimitsResponse = await client.readRateLimits();
      } catch (error) {
        throw new AccountVerificationError(
          {
            email,
            planType: account.planType ?? null,
            resolvedAt,
            stale: true,
          },
          error,
        );
      }
      return {
        email,
        planType: account.planType ?? null,
        quota: rateLimitsResponse.rateLimits,
        resolvedAt,
      };
    };

    return await (aborted ? Promise.race([probe(), aborted]) : probe());
  } finally {
    if (abortHandler) {
      options.signal?.removeEventListener("abort", abortHandler);
    }
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
  private readonly probe: (
    command: AppServerCommand,
    signal: AbortSignal,
  ) => Promise<AccountSnapshot>;
  private readonly resolveCommand: (source: CodexSource) => AppServerCommand;
  private readonly sleep: (delayMs: number) => Promise<void>;
  private readonly probeTimeout: (delayMs: number) => Promise<void>;
  private generation = 0;
  private activeKey: string | null = null;
  private lastVerified: AccountSnapshot | null = null;
  private lastObserved: AccountResolution | null = null;
  private current: AccountResolution | null = null;
  private probeInFlight = false;
  private pendingProbe: ProbeTarget | null = null;

  constructor(options: AccountResolverOptions = {}) {
    super();
    this.probe =
      options.probe ??
      ((command, signal) => probeAccount(command, { now: options.now, signal }));
    this.resolveCommand = options.resolveCommand ?? resolveRuntimeCommand;
    this.sleep = options.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
    this.probeTimeout =
      options.probeTimeout ??
      ((delayMs) =>
        new Promise((resolve) => {
          setTimeout(resolve, delayMs).unref();
        }));
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
    void this.sleep(delay).then(() => {
      if (generation !== this.generation) {
        return;
      }

      this.pendingProbe = { generation, source, quota, attempt };
      this.runPendingProbe();
    });
  }

  private runPendingProbe(): void {
    if (this.probeInFlight || !this.pendingProbe) {
      return;
    }

    const target = this.pendingProbe;
    this.pendingProbe = null;
    this.probeInFlight = true;
    void this.runProbe(target).finally(() => {
      this.probeInFlight = false;
      this.runPendingProbe();
    });
  }

  private async runProbe(target: ProbeTarget): Promise<void> {
    const { generation, source, quota, attempt } = target;
    try {
      const controller = new AbortController();
      const probe = this.probe(this.resolveCommand(source), controller.signal);
      const snapshot = await Promise.race([
        probe,
        this.probeTimeout(PROBE_TIMEOUT_MS).then(async () => {
          controller.abort();
          await probe.catch(() => undefined);
          throw new Error("账号探测超时");
        }),
      ]);
      if (generation !== this.generation) {
        return;
      }

      if (quotaMatches(quota, snapshot.quota)) {
        this.lastVerified = snapshot;
        this.lastObserved = toResolution(snapshot, false);
        this.setCurrent(this.lastObserved);
        return;
      }
    } catch (error) {
      if (generation !== this.generation) {
        return;
      }
      if (error instanceof AccountVerificationError) {
        this.lastObserved = error.account;
        this.setCurrent(error.account);
      } else {
        this.markStale();
      }
    }

    this.scheduleProbe(generation, source, quota, attempt + 1);
  }

  private cancelActiveProbe(): void {
    this.activeKey = null;
    this.generation += 1;
    this.pendingProbe = null;
  }

  private markStale(): AccountResolution | null {
    if (this.lastObserved) {
      const stale = { ...this.lastObserved, stale: true };
      this.setCurrent(stale);
      return stale;
    }

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
