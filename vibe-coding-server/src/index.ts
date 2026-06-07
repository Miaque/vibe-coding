import mqtt from "mqtt";
import { join } from "node:path";

import { AccountResolver, probeAccount, quotaMatches } from "./account-resolver.js";
import { createDisplayState } from "./codex-state.js";
import { HookInbox } from "./hook-inbox.js";
import { loadProjectEnv } from "./load-env.js";
import { MonitorService } from "./monitor-service.js";
import {
  createMqttOptions,
  loadCachedState,
  publishAvailability,
  publishState,
  saveCachedState,
} from "./publisher.js";
import { resolveRuntimeCommand } from "./runtime-resolver.js";
import { SessionWatcher } from "./session-watcher.js";
import { ThreadAggregator } from "./thread-aggregator.js";
import type { MqttClient } from "mqtt";

loadProjectEnv();

const once = process.argv.includes("--once");
const mqttUrl = process.env.MQTT_URL ?? "mqtt://127.0.0.1:1883";
const topicPrefix = process.env.MQTT_TOPIC_PREFIX ?? "oled/codex";
const stateTopic = `${topicPrefix}/state`;
const availabilityTopic = `${topicPrefix}/availability`;
const sessionsDir = expandEnvPath(
  process.env.CODEX_SESSIONS_DIR ?? join(requiredEnv("USERPROFILE"), ".codex", "sessions"),
);
const runtimeDir = expandEnvPath(
  process.env.VIBE_CODING_RUNTIME_DIR
    ?? join(requiredEnv("LOCALAPPDATA"), "VibeCoding", "runtime"),
);
const cachePath = join(runtimeDir, "state.json");

if (once) {
  await runOnce();
  process.exit(0);
}

const mqttClient = mqtt.connect(mqttUrl, {
  ...createMqttOptions(availabilityTopic),
  ...mqttCredentials(),
});
await waitForMqttConnection(mqttClient);

const service = new MonitorService({
  sessionWatcher: new SessionWatcher({ root: sessionsDir }),
  hookInbox: new HookInbox({ runtimeDir }),
  aggregator: new ThreadAggregator(),
  accountResolver: new AccountResolver(),
  loadCache: () => loadCachedState(cachePath),
  saveCache: (state) => saveCachedState(cachePath, state),
  publishState: (state) => publishState(mqttClient, stateTopic, state),
  publishAvailability: (value) => publishAvailability(mqttClient, availabilityTopic, value),
});

await publishAvailability(mqttClient, availabilityTopic, "online");
await service.start();

console.log(`正在向 ${stateTopic} 发布 Codex OLED 状态`);

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

async function runOnce(): Promise<void> {
  const aggregator = new ThreadAggregator();
  const watcher = new SessionWatcher({ root: sessionsDir });
  watcher.on("metadata", (metadata) => {
    aggregator.setSource(metadata.threadId, metadata.source);
  });
  watcher.on("event", (event) => {
    aggregator.apply(event);
  });

  await watcher.scanOnce();
  watcher.stop();

  const thread = aggregator.current();
  if (!thread) {
    throw new Error("没有找到可用 Codex thread 事件");
  }
  if (!thread.source) {
    throw new Error("最新 Codex thread 缺少来源信息");
  }

  const account = await probeAccount(resolveRuntimeCommand(thread.source));
  const accountStale = thread.quota ? !quotaMatches(thread.quota, account.quota) : false;

  const state = createDisplayState({
    threadId: thread.threadId,
    sessionId: thread.sessionId,
    source: thread.source,
    status: thread.status,
    email: account.email,
    accountStale,
    quota: thread.quota ?? account.quota,
    contextTokens: thread.contextTokens,
    modelContextWindow: thread.modelContextWindow,
    updatedAt: thread.lastEventAt,
  });
  console.log(JSON.stringify(state));
}

function requiredEnv(name: "USERPROFILE" | "LOCALAPPDATA"): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`必须设置 ${name}`);
  }
  return value;
}

function mqttCredentials(): { username?: string; password?: string } {
  return {
    ...(process.env.MQTT_USER ? { username: process.env.MQTT_USER } : {}),
    ...(process.env.MQTT_PASSWORD ? { password: process.env.MQTT_PASSWORD } : {}),
  };
}

function expandEnvPath(value: string): string {
  return value.replace(/%([^%]+)%/g, (_match, name: string) => process.env[name] ?? "");
}

function waitForMqttConnection(client: MqttClient): Promise<void> {
  return new Promise((resolve, reject) => {
    const onConnect = () => {
      client.off("error", onError);
      resolve();
    };
    const onError = (error: Error) => {
      client.off("connect", onConnect);
      reject(error);
    };

    client.once("connect", onConnect);
    client.once("error", onError);
  });
}

function closeMqtt(client: MqttClient): Promise<void> {
  return new Promise((resolve, reject) => {
    client.end(false, {}, (error?: Error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

let shuttingDown = false;

function shutdown(): void {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  void (async () => {
    await service.stop();
    await closeMqtt(mqttClient);
    process.exit(0);
  })().catch((error) => {
    console.error("停止监控服务失败：", error);
    process.exit(1);
  });
}
