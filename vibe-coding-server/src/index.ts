import mqtt from "mqtt";

import { AppServerClient } from "./app-server-client.js";
import { loadProjectEnv } from "./load-env.js";
import { publishQuota } from "./publisher.js";
import { QuotaMonitor } from "./quota-monitor.js";
import type { MqttClient } from "mqtt";

loadProjectEnv();

const once = process.argv.includes("--once");
const intervalMs = Number(process.env.POLL_INTERVAL_MS ?? 30000);
const topic = once ? "" : requiredEnv("MQTT_TOPIC");
const mqttUrl = once ? "" : requiredEnv("MQTT_URL");

if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
  throw new Error("POLL_INTERVAL_MS 必须是正数");
}

const appServer = new AppServerClient();
await appServer.start();
const { account } = await appServer.readAccount();

if (once) {
  const response = await appServer.readRateLimits();
  const monitor = new QuotaMonitor({
    appServer,
    account,
    publish: async (quota) => console.log(JSON.stringify(quota)),
  });
  await monitor.publishFresh(response.rateLimits);
  appServer.stop();
  process.exit(0);
}

const mqttClient = mqtt.connect(mqttUrl, {
  username: process.env.MQTT_USER,
  password: process.env.MQTT_PASSWORD,
});
await waitForMqttConnection(mqttClient);

const monitor = new QuotaMonitor({
  appServer,
  createAppServer: () => new AppServerClient(),
  account,
  publish: (quota) => publishQuota(mqttClient, topic, quota),
});
monitor.onError = (error) => console.error("刷新配额失败：", error.message);
const response = await appServer.readRateLimits();
await monitor.publishCurrent(response.rateLimits);
monitor.start(intervalMs);

console.log(`正在每 ${intervalMs} ms 向 ${topic} 发布 Codex 配额`);

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`必须设置 ${name}`);
  }
  return value;
}

function waitForMqttConnection(client: MqttClient): Promise<void> {
  return new Promise((resolve, reject) => {
    client.once("connect", () => resolve());
    client.once("error", reject);
  });
}

function shutdown(): void {
  monitor.stop();
  mqttClient.end();
}
