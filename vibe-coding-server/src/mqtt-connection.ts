import type { MqttClient } from "mqtt";

export function waitForMqttConnection(
  client: Pick<MqttClient, "on" | "once" | "off">,
  onError: (error: Error) => void = (error) => console.error("MQTT 连接错误：", error),
): Promise<void> {
  return new Promise((resolve, reject) => {
    let connected = false;
    const handleConnect = () => {
      connected = true;
      resolve();
    };
    const handleError = (error: Error) => {
      if (!connected) {
        client.off("connect", handleConnect);
        client.off("error", handleError);
        reject(error);
        return;
      }

      onError(error);
    };

    client.once("connect", handleConnect);
    client.on("error", handleError);
  });
}
