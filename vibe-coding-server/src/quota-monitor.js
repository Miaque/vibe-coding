import { createQuotaPayload } from "./quota.js";

export class QuotaMonitor {
  constructor({
    appServer,
    createAppServer = null,
    account = null,
    publish,
    now = () => Math.floor(Date.now() / 1000),
  }) {
    this.appServer = appServer;
    this.createAppServer = createAppServer;
    this.account = account;
    this.publish = publish;
    this.now = now;
    this.rateLimitsListener = (rateLimits) => {
      this.publishCurrent(rateLimits).catch((error) => this.onError?.(error));
    };
  }

  async refresh() {
    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    this.refreshPromise = this.refreshOnce().finally(() => {
      this.refreshPromise = null;
    });

    return this.refreshPromise;
  }

  async refreshOnce() {
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

  async restartAppServer() {
    if (!this.createAppServer) {
      return;
    }

    this.detachRateLimitUpdates();
    this.appServer.stop?.();
    this.appServer = this.createAppServer();
    await this.appServer.start();
    this.listenForRateLimitUpdates();
  }

  async publishCurrent(rateLimits) {
    const { account } = await this.appServer.readAccount();
    this.account = account;
    await this.publishFresh(rateLimits);
  }

  async publishFresh(rateLimits) {
    this.lastQuota = createQuotaPayload(rateLimits, this.now(), this.account);
    await this.publish(this.lastQuota);
  }

  start(intervalMs) {
    this.listenForRateLimitUpdates();

    this.timer = setInterval(() => {
      this.refresh().catch((error) => this.onError?.(error));
    }, intervalMs);
  }

  listenForRateLimitUpdates() {
    if (this.listenedAppServer === this.appServer) {
      return;
    }

    this.appServer.on("rateLimitsUpdated", this.rateLimitsListener);
    this.listenedAppServer = this.appServer;
  }

  detachRateLimitUpdates() {
    if (!this.listenedAppServer) {
      return;
    }

    this.listenedAppServer.off?.("rateLimitsUpdated", this.rateLimitsListener);
    this.listenedAppServer = null;
  }

  stop() {
    clearInterval(this.timer);
    this.detachRateLimitUpdates();
    this.appServer.stop?.();
  }
}
