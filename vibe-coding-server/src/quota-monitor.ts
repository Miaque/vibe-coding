import { createQuotaPayload } from "./quota.js";
import type { Account, QuotaPayload, RateLimits } from "./quota.js";

type AppServerLike = {
  start?: () => Promise<void>;
  stop?: () => void;
  readRateLimits: () => Promise<{ rateLimits: RateLimits }>;
  readAccount: () => Promise<{ account: Account }>;
  on: (event: "rateLimitsUpdated", listener: (rateLimits: RateLimits) => void) => unknown;
  off?: (event: "rateLimitsUpdated", listener: (rateLimits: RateLimits) => void) => unknown;
};

type QuotaMonitorOptions = {
  appServer: AppServerLike;
  createAppServer?: (() => AppServerLike) | null;
  account?: Account;
  publish: (quota: QuotaPayload) => Promise<void>;
  now?: () => number;
};

export class QuotaMonitor {
  onError?: (error: Error) => void;
  private appServer: AppServerLike;
  private createAppServer: (() => AppServerLike) | null;
  private account: Account;
  private publish: (quota: QuotaPayload) => Promise<void>;
  private now: () => number;
  private rateLimitsListener: (rateLimits: RateLimits) => void;
  private refreshPromise: Promise<void> | null = null;
  private lastQuota: QuotaPayload | null = null;
  private timer: NodeJS.Timeout | null = null;
  private listenedAppServer: AppServerLike | null = null;

  constructor({
    appServer,
    createAppServer = null,
    account = null,
    publish,
    now = () => Math.floor(Date.now() / 1000),
  }: QuotaMonitorOptions) {
    this.appServer = appServer;
    this.createAppServer = createAppServer;
    this.account = account;
    this.publish = publish;
    this.now = now;
    this.rateLimitsListener = (rateLimits) => {
      this.publishCurrent(rateLimits).catch((error) => this.onError?.(error));
    };
  }

  async refresh(): Promise<void> {
    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    this.refreshPromise = this.refreshOnce().finally(() => {
      this.refreshPromise = null;
    });

    return this.refreshPromise;
  }

  async refreshOnce(): Promise<void> {
    try {
      await this.restartAppServer();
      const response = await this.appServer.readRateLimits();
      await this.publishCurrent(response.rateLimits);
    } catch (error) {
      if (this.lastQuota) {
        await this.publish({ ...this.lastQuota, stale: true });
      }
      throw error;
    }
  }

  async restartAppServer(): Promise<void> {
    if (!this.createAppServer) {
      return;
    }

    this.detachRateLimitUpdates();
    this.appServer.stop?.();
    this.appServer = this.createAppServer();
    await this.appServer.start?.();
    this.listenForRateLimitUpdates();
  }

  async publishCurrent(rateLimits: RateLimits): Promise<void> {
    const { account } = await this.appServer.readAccount();
    this.account = account;
    await this.publishFresh(rateLimits);
  }

  async publishFresh(rateLimits: RateLimits): Promise<void> {
    this.lastQuota = createQuotaPayload(rateLimits, this.now(), this.account);
    await this.publish(this.lastQuota);
  }

  start(intervalMs: number): void {
    this.listenForRateLimitUpdates();

    this.timer = setInterval(() => {
      this.refresh().catch((error) => this.onError?.(error));
    }, intervalMs);
  }

  listenForRateLimitUpdates(): void {
    if (this.listenedAppServer === this.appServer) {
      return;
    }

    this.appServer.on("rateLimitsUpdated", this.rateLimitsListener);
    this.listenedAppServer = this.appServer;
  }

  detachRateLimitUpdates(): void {
    if (!this.listenedAppServer) {
      return;
    }

    this.listenedAppServer.off?.("rateLimitsUpdated", this.rateLimitsListener);
    this.listenedAppServer = null;
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.detachRateLimitUpdates();
    this.appServer.stop?.();
  }
}
