export function publishQuota(client, topic, quota) {
  return new Promise((resolve, reject) => {
    client.publish(
      topic,
      JSON.stringify(quota),
      { retain: true, qos: 1 },
      (error) => (error ? reject(error) : resolve()),
    );
  });
}
