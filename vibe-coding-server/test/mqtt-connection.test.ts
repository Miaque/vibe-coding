import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { waitForMqttConnection } from "../src/mqtt-connection.js";

type FakeMqttClient = EventEmitter & {
  offCount: number;
  off: (eventName: string | symbol, listener: (...args: unknown[]) => void) => FakeMqttClient;
};

function makeClient(): FakeMqttClient {
  const client = new EventEmitter() as FakeMqttClient;
  client.offCount = 0;
  const originalOff = client.off.bind(client);
  client.off = (eventName, listener) => {
    client.offCount += 1;
    return originalOff(eventName, listener) as FakeMqttClient;
  };
  return client;
}

test("waitForMqttConnection 连接成功后保留 MQTT error listener", async () => {
  const client = makeClient();
  const errors: unknown[] = [];
  const connected = waitForMqttConnection(client, (error) => {
    errors.push(error);
  });

  client.emit("connect");
  await connected;

  assert.equal(client.listenerCount("error"), 1);
  const error = new Error("late mqtt error");
  client.emit("error", error);

  assert.deepEqual(errors, [error]);
});
