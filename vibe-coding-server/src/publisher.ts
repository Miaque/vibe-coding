import type { IClientOptions, IClientPublishOptions, MqttClient } from "mqtt";

import type { DisplayState } from "./codex-state.js";
import type { QuotaPayload } from "./quota.js";
import { loadState, saveState } from "./state-cache.js";

export async function loadCachedState(path: string): Promise<DisplayState | null> {
  return loadState(path);
}

export async function saveCachedState(path: string, state: DisplayState): Promise<void> {
  await saveState(path, state);
}

export function publishState(
  client: Pick<MqttClient, "publish">,
  topic: string,
  state: DisplayState,
): Promise<void> {
  return publish(client, topic, JSON.stringify(state));
}

export function publishAvailability(
  client: Pick<MqttClient, "publish">,
  topic: string,
  value: "online" | "offline",
): Promise<void> {
  return publish(client, topic, value);
}

export function createMqttOptions(availabilityTopic: string): IClientOptions {
  return {
    will: {
      topic: availabilityTopic,
      payload: "offline",
      qos: 1,
      retain: true,
    },
  };
}

export function publishQuota(
  client: Pick<MqttClient, "publish">,
  topic: string,
  quota: Partial<QuotaPayload>,
): Promise<void> {
  return publish(client, topic, JSON.stringify(quota));
}

function publish(
  client: Pick<MqttClient, "publish">,
  topic: string,
  payload: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    client.publish(
      topic,
      payload,
      { retain: true, qos: 1 } satisfies IClientPublishOptions,
      (error) => (error ? reject(error) : resolve()),
    );
  });
}
