import assert from "node:assert/strict";
import test from "node:test";

import { publishQuota } from "../src/publisher.js";

test("publishQuota publishes retained JSON", async () => {
  const calls = [];
  const client = {
    publish(topic, payload, options, callback) {
      calls.push({ topic, payload, options });
      callback();
    },
  };

  await publishQuota(client, "oled/codex/quota", {
    fiveHourRemaining: 72,
    stale: false,
  });

  assert.deepEqual(calls, [
    {
      topic: "oled/codex/quota",
      payload: '{"fiveHourRemaining":72,"stale":false}',
      options: { retain: true, qos: 1 },
    },
  ]);
});
