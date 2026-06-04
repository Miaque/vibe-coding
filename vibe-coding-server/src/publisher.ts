import type { IClientPublishOptions, MqttClient } from "mqtt";

import type { QuotaPayload } from "./quota.js";

export function publishQuota(
  client: Pick<MqttClient, "publish">,
  topic: string,
  quota: Partial<QuotaPayload>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    client.publish(
      topic,
      JSON.stringify(quota),
      { retain: true, qos: 1 } satisfies IClientPublishOptions,
      (error) => (error ? reject(error) : resolve()),
    );
  });
}
