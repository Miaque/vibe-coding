import type { EventEmitter } from "node:events";

import type { AccountRefresh, AccountResolution } from "./account-resolver.js";
import {
  createDisplayState,
  type DisplayState,
  type NormalizedEvent,
  type RateLimitSnapshot,
} from "./codex-state.js";
import type { SessionMetadata } from "./session-events.js";
import type { ThreadAggregator, ThreadSnapshot } from "./thread-aggregator.js";

export type SessionWatcherLike = Pick<EventEmitter, "on" | "off"> & {
  start: () => Promise<void>;
  stop: () => void;
};

export type HookInboxLike = Pick<EventEmitter, "on" | "off"> & {
  start: () => Promise<void>;
  stop: () => void;
};

export type AccountResolverLike = Pick<EventEmitter, "on" | "off"> & {
  resolve: (thread: ThreadSnapshot | null) => AccountResolution | null;
  refresh: (thread: ThreadSnapshot) => Promise<AccountRefresh | null>;
};

export type MonitorServiceOptions = {
  sessionWatcher: SessionWatcherLike;
  hookInbox: HookInboxLike;
  aggregator: ThreadAggregator;
  accountResolver: AccountResolverLike;
  loadCache: () => Promise<DisplayState | null>;
  saveCache: (state: DisplayState) => Promise<void>;
  publishState: (state: DisplayState) => Promise<void>;
  publishAvailability: (value: "online" | "offline") => Promise<void>;
  refreshTimeoutMs?: number;
};

const DEFAULT_REFRESH_TIMEOUT_MS = 2_000;

export class MonitorService {
  private readonly sessionWatcher: SessionWatcherLike;
  private readonly hookInbox: HookInboxLike;
  private readonly aggregator: ThreadAggregator;
  private readonly accountResolver: AccountResolverLike;
  private readonly loadCache: () => Promise<DisplayState | null>;
  private readonly saveCache: (state: DisplayState) => Promise<void>;
  private readonly publishState: (state: DisplayState) => Promise<void>;
  private readonly publishAvailability: (value: "online" | "offline") => Promise<void>;
  private readonly refreshTimeoutMs: number;
  private readonly onSessionEvent = (event: NormalizedEvent) => this.handleEvent(event);
  private readonly onHookEvent = (event: NormalizedEvent) => this.handleEvent(event);
  private readonly onMetadata = (metadata: SessionMetadata) => this.handleMetadata(metadata);
  private readonly onResolved = (account: AccountResolution) => this.handleResolved(account);
  private publishQueue: Promise<void> = Promise.resolve();
  private lastSerializedState: string | null = null;
  private pendingSerializedState: string | null = null;
  private currentAccount: AccountResolution | null = null;
  private bootstrappingInitialScan = false;
  private started = false;
  private refreshInFlight = false;
  private refreshGeneration = 0;
  private refreshTargetKey: string | null = null;
  private refreshQueued = false;
  private refreshTimedOut = false;
  private refreshTimer: NodeJS.Timeout | null = null;

  constructor(options: MonitorServiceOptions) {
    this.sessionWatcher = options.sessionWatcher;
    this.hookInbox = options.hookInbox;
    this.aggregator = options.aggregator;
    this.accountResolver = options.accountResolver;
    this.loadCache = options.loadCache;
    this.saveCache = options.saveCache;
    this.publishState = options.publishState;
    this.publishAvailability = options.publishAvailability;
    this.refreshTimeoutMs = options.refreshTimeoutMs ?? DEFAULT_REFRESH_TIMEOUT_MS;
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    this.started = true;

    this.sessionWatcher.on("event", this.onSessionEvent);
    this.sessionWatcher.on("metadata", this.onMetadata);
    this.hookInbox.on("event", this.onHookEvent);
    this.accountResolver.on("resolved", this.onResolved);

    const cached = await this.loadCache();
    if (cached) {
      const staleCached = { ...cached, accountStale: true };
      this.currentAccount = {
        email: staleCached.email,
        planType: null,
        resolvedAt: staleCached.updatedAt,
        stale: true,
      };
      await this.publishCached(staleCached);
    }

    this.bootstrappingInitialScan = true;
    try {
      await this.sessionWatcher.start();
      await this.hookInbox.start();
    } finally {
      this.bootstrappingInitialScan = false;
    }
    this.publishCurrent();
  }

  async stop(): Promise<void> {
    if (!this.started) {
      return;
    }
    this.started = false;

    this.sessionWatcher.off("event", this.onSessionEvent);
    this.sessionWatcher.off("metadata", this.onMetadata);
    this.hookInbox.off("event", this.onHookEvent);
    this.accountResolver.off("resolved", this.onResolved);
    this.sessionWatcher.stop();
    this.hookInbox.stop();
    this.refreshGeneration += 1;
    this.refreshInFlight = false;
    this.refreshQueued = false;
    this.clearRefreshTimer();
    await this.enqueue(async () => {
      await this.publishAvailability("offline");
    });
  }

  private handleEvent(event: NormalizedEvent): void {
    this.aggregator.apply(event);
    if (event.kind === "status") {
      this.refreshCurrent();
      return;
    }
    if (this.refreshInFlight && !this.refreshTimedOut) {
      return;
    }
    this.publishCurrent();
  }

  private handleMetadata(metadata: SessionMetadata): void {
    this.aggregator.setSource(metadata.threadId, metadata.source);
    this.refreshCurrent();
  }

  private handleResolved(account: AccountResolution): void {
    if (this.refreshInFlight) {
      return;
    }
    this.currentAccount = account;
    this.publishCurrent(account);
  }

  private refreshCurrent(): void {
    const thread = this.aggregator.current();
    if (!thread?.source) {
      return;
    }

    const targetKey = this.threadKey(thread);
    if (this.refreshInFlight) {
      if (targetKey !== this.refreshTargetKey) {
        this.refreshQueued = true;
      }
      return;
    }

    const generation = ++this.refreshGeneration;
    this.refreshInFlight = true;
    this.refreshTimedOut = false;
    this.refreshTargetKey = targetKey;
    this.refreshTimer = setTimeout(() => {
      if (
        !this.started
        || generation !== this.refreshGeneration
        || !this.refreshInFlight
      ) {
        return;
      }
      this.refreshTimedOut = true;
      this.publishStaleCurrent();
    }, this.refreshTimeoutMs);
    this.refreshTimer.unref();

    void this.accountResolver.refresh(thread).then((account) => {
      if (!this.started || generation !== this.refreshGeneration) {
        return;
      }

      const current = this.aggregator.current();
      if (!current?.source || this.threadKey(current) !== targetKey) {
        this.refreshQueued = true;
        return;
      }

      if (account) {
        this.currentAccount = account;
        this.publishCurrent(account, account.quota);
      } else if (!this.refreshTimedOut) {
        this.publishStaleCurrent();
      }
    }).finally(() => {
      if (generation !== this.refreshGeneration) {
        return;
      }
      this.clearRefreshTimer();
      this.refreshInFlight = false;
      this.refreshTimedOut = false;
      this.refreshTargetKey = null;
      if (this.started && this.refreshQueued) {
        this.refreshQueued = false;
        this.refreshCurrent();
      }
    });
  }

  private publishStaleCurrent(): void {
    if (!this.currentAccount) {
      return;
    }
    const staleAccount = { ...this.currentAccount, stale: true };
    this.currentAccount = staleAccount;
    this.publishCurrent(staleAccount);
  }

  private threadKey(thread: ThreadSnapshot): string {
    return `${thread.threadId}\n${thread.source ?? ""}`;
  }

  private clearRefreshTimer(): void {
    if (!this.refreshTimer) {
      return;
    }
    clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
  }

  private publishCurrent(
    account?: AccountResolution,
    quota?: RateLimitSnapshot,
  ): void {
    const thread = this.aggregator.current();
    if (!thread) {
      return;
    }

    const nextAccount = account ?? this.accountForThread(thread);
    const state = this.buildState(thread, nextAccount, quota);
    if (!state) {
      return;
    }

    if (this.bootstrappingInitialScan) {
      return;
    }

    void this.publishLive(state).catch(() => undefined);
  }

  private accountForThread(thread: ThreadSnapshot): AccountResolution | null {
    if (!thread.source) {
      return this.currentAccount;
    }

    const resolved = this.accountResolver.resolve(thread);
    if (resolved) {
      this.currentAccount = resolved;
    }
    return this.currentAccount;
  }

  private buildState(
    thread: ThreadSnapshot,
    account: AccountResolution | null,
    quota?: RateLimitSnapshot,
  ): DisplayState | null {
    if (!thread.source || !account) {
      return null;
    }

    const email = account.email.trim();
    if (email === "") {
      return null;
    }

    return createDisplayState({
      threadId: thread.threadId,
      sessionId: thread.sessionId,
      source: thread.source,
      status: thread.status,
      email,
      accountStale: account.stale,
      quota: quota ?? thread.quota,
      contextTokens: thread.contextTokens,
      modelContextWindow: thread.modelContextWindow,
      updatedAt: thread.lastEventAt,
    });
  }

  private publishCached(state: DisplayState): Promise<void> {
    const serialized = JSON.stringify(state);
    this.pendingSerializedState = serialized;
    return this.enqueue(async () => {
      try {
        await this.publishState(state);
        this.lastSerializedState = serialized;
      } finally {
        if (this.pendingSerializedState === serialized) {
          this.pendingSerializedState = null;
        }
      }
    });
  }

  private publishLive(state: DisplayState): Promise<void> {
    const serialized = JSON.stringify(state);
    if (serialized === this.lastSerializedState || serialized === this.pendingSerializedState) {
      return this.publishQueue;
    }

    this.pendingSerializedState = serialized;
    return this.enqueue(async () => {
      try {
        await this.publishState(state);
        await this.saveCache(state);
        this.lastSerializedState = serialized;
      } finally {
        if (this.pendingSerializedState === serialized) {
          this.pendingSerializedState = null;
        }
      }
    });
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.publishQueue.then(operation, operation);
    this.publishQueue = next.catch(() => undefined);
    return next;
  }
}
