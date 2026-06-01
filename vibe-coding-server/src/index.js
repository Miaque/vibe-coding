import mqtt from "mqtt";

import { AppServerClient } from "./app-server-client.js";
import { loadProjectEnv } from "./load-env.js";
import { publishQuota } from "./publisher.js";
import { QuotaMonitor } from "./quota-monitor.js";

loadProjectEnv();

const once = process.argv.includes("--once");
const intervalMs = Number(process.env.POLL_INTERVAL_MS ?? 30000);
const topic = once ? null : requiredEnv("MQTT_TOPIC");
const mqttUrl = once ? null : requiredEnv("MQTT_URL");

if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
  throw new Error("POLL_INTERVAL_MS must be a positive number");
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
monitor.onError = (error) => console.error("Quota refresh failed:", error.message);
const response = await appServer.readRateLimits();
await monitor.publishCurrent(response.rateLimits);
monitor.start(intervalMs);

console.log(`Publishing Codex quota to ${topic} every ${intervalMs} ms`);

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function waitForMqttConnection(client) {
  return new Promise((resolve, reject) => {
    client.once("connect", resolve);
    client.once("error", reject);
  });
}

function shutdown() {
  monitor.stop();
  mqttClient.end();
}
