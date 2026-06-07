import type { EventEmitter } from "node:events";

import type { AccountResolution } from "./account-resolver.js";
import { createDisplayState, type DisplayState, type NormalizedEvent } from "./codex-state.js";
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
};

export class MonitorService {
  private readonly sessionWatcher: SessionWatcherLike;
  private readonly hookInbox: HookInboxLike;
  private readonly aggregator: ThreadAggregator;
  private readonly accountResolver: AccountResolverLike;
  private readonly loadCache: () => Promise<DisplayState | null>;
  private readonly saveCache: (state: DisplayState) => Promise<void>;
  private readonly publishState: (state: DisplayState) => Promise<void>;
  private readonly publishAvailability: (value: "online" | "offline") => Promise<void>;
  private readonly onSessionEvent = (event: NormalizedEvent) => this.handleEvent(event);
  private readonly onHookEvent = (event: NormalizedEvent) => this.handleEvent(event);
  private readonly onMetadata = (metadata: SessionMetadata) => this.handleMetadata(metadata);
  private readonly onResolved = (account: AccountResolution) => this.handleResolved(account);
  private publishQueue: Promise<void> = Promise.resolve();
  private lastSerializedState: string | null = null;
  private currentAccount: AccountResolution | null = null;
  private started = false;

  constructor(options: MonitorServiceOptions) {
    this.sessionWatcher = options.sessionWatcher;
    this.hookInbox = options.hookInbox;
    this.aggregator = options.aggregator;
    this.accountResolver = options.accountResolver;
    this.loadCache = options.loadCache;
    this.saveCache = options.saveCache;
    this.publishState = options.publishState;
    this.publishAvailability = options.publishAvailability;
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
      await this.publishCached({ ...cached, accountStale: true });
    }

    await this.sessionWatcher.start();
    await this.hookInbox.start();
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
    await this.enqueue(async () => {
      await this.publishAvailability("offline");
    });
  }

  private handleEvent(event: NormalizedEvent): void {
    this.aggregator.apply(event);
    this.publishCurrent();
  }

  private handleMetadata(metadata: SessionMetadata): void {
    this.aggregator.setSource(metadata.threadId, metadata.source);
    this.publishCurrent();
  }

  private handleResolved(account: AccountResolution): void {
    this.currentAccount = account;
    this.publishCurrent(account);
  }

  private publishCurrent(account = this.resolveAccount()): void {
    const thread = this.aggregator.current();
    const state = thread ? this.buildState(thread, account) : null;
    if (!state) {
      return;
    }

    void this.publishLive(state).catch(() => undefined);
  }

  private resolveAccount(): AccountResolution | null {
    this.currentAccount = this.accountResolver.resolve(this.aggregator.current());
    return this.currentAccount;
  }

  private buildState(
    thread: ThreadSnapshot,
    account: AccountResolution | null,
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
      quota: thread.quota,
      contextTokens: thread.contextTokens,
      modelContextWindow: thread.modelContextWindow,
      updatedAt: thread.lastEventAt,
    });
  }

  private publishCached(state: DisplayState): Promise<void> {
    const serialized = JSON.stringify(state);
    this.lastSerializedState = serialized;
    return this.enqueue(async () => {
      await this.publishState(state);
    });
  }

  private publishLive(state: DisplayState): Promise<void> {
    const serialized = JSON.stringify(state);
    if (serialized === this.lastSerializedState) {
      return this.publishQueue;
    }

    this.lastSerializedState = serialized;
    return this.enqueue(async () => {
      await this.publishState(state);
      await this.saveCache(state);
    });
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.publishQueue.then(operation, operation);
    this.publishQueue = next.catch(() => undefined);
    return next;
  }
}
