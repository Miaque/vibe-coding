#include <Arduino.h>
#include <Wire.h>
#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include "generated_config.h"

#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64

#define OLED_SDA 8
#define OLED_SCL 9
#define OLED_ADDR 0x3C

Adafruit_SSD1306 display(
    SCREEN_WIDTH,
    SCREEN_HEIGHT,
    &Wire,
    -1
);

WiFiClient wifiClient;
PubSubClient mqttClient(wifiClient);

char displayMessage[128] = "Waiting for MQTT message...";
int targetWifiChannel = 0;
unsigned long lastWifiAttempt = 0;
unsigned long lastReconnectAttempt = 0;
unsigned long lastStatusLog = 0;

void renderMessage(const char *status);

struct QuotaState {
    int fiveHourRemaining;
    int weeklyRemaining;
    bool stale;
    char planType[12];
    char email[64];
};

int normalizeRemaining(JsonVariantConst value) {
    if (value.isNull()) {
        return -1;
    }

    return constrain(value.as<int>(), 0, 100);
}

void drawProgressBar(int16_t x, int16_t y, int16_t width, int percentage) {
    display.drawRect(x, y, width, 8, SSD1306_WHITE);

    if (percentage < 0) {
        display.setCursor(x + width / 2 - 3, y);
        display.print("?");
        return;
    }

    int16_t fillWidth = map(percentage, 0, 100, 0, width - 4);

    if (fillWidth > 0) {
        display.fillRect(x + 2, y + 2, fillWidth, 4, SSD1306_WHITE);
    }
}

void drawQuotaRow(const char *label, int16_t y, int percentage) {
    display.setTextSize(1);
    display.setCursor(0, y);
    display.print(label);

    drawProgressBar(19, y, 76, percentage);

    display.setCursor(100, y);

    if (percentage < 0) {
        display.print("--%");
    } else {
        if (percentage < 100) {
            display.print(" ");
        }

        if (percentage < 10) {
            display.print(" ");
        }

        display.print(percentage);
        display.print("%");
    }
}

void drawEmail(const char *email) {
    const int16_t maxChars = 21;
    const int16_t visibleSideChars = 9;

    display.setCursor(0, 10);

    if (email[0] == '\0') {
        display.print("Account unavailable");
        return;
    }

    size_t length = strlen(email);

    if (length <= maxChars) {
        display.print(email);
        return;
    }

    for (int16_t i = 0; i < visibleSideChars; i++) {
        display.print(email[i]);
    }

    display.print("...");
    display.print(email + length - visibleSideChars);
}

void renderQuota(const QuotaState &quota) {
    display.clearDisplay();
    display.setTextColor(SSD1306_WHITE);
    display.setTextSize(1);

    display.setCursor(0, 0);
    display.print("CODEX");

    if (quota.stale) {
        display.setCursor(92, 0);
        display.print("STALE");
    } else if (quota.planType[0] != '\0') {
        int16_t planX = max(36, SCREEN_WIDTH - static_cast<int>(strlen(quota.planType) * 6));
        display.setCursor(planX, 0);

        for (size_t i = 0; quota.planType[i] != '\0'; i++) {
            display.print(static_cast<char>(toupper(quota.planType[i])));
        }
    }

    drawEmail(quota.email);
    display.drawLine(0, 20, SCREEN_WIDTH, 20, SSD1306_WHITE);
    drawQuotaRow("5H", 28, quota.fiveHourRemaining);
    drawQuotaRow("WK", 47, quota.weeklyRemaining);
    display.display();
}

bool parseQuota(const byte *payload, unsigned int length, QuotaState &quota) {
    JsonDocument document;
    DeserializationError error = deserializeJson(document, payload, length);

    if (error) {
        Serial.print("Quota JSON parse failed: ");
        Serial.println(error.c_str());
        return false;
    }

    quota.fiveHourRemaining = normalizeRemaining(document["fiveHourRemaining"]);
    quota.weeklyRemaining = normalizeRemaining(document["weeklyRemaining"]);
    quota.stale = document["stale"] | false;

    const char *planType = document["planType"] | "";
    snprintf(quota.planType, sizeof(quota.planType), "%s", planType);

    const char *email = document["email"] | "";
    snprintf(quota.email, sizeof(quota.email), "%s", email);
    return true;
}

const char *wifiStatusText(wl_status_t status) {
    switch (status) {
        case WL_IDLE_STATUS:
            return "idle";
        case WL_NO_SSID_AVAIL:
            return "no ssid";
        case WL_SCAN_COMPLETED:
            return "scan done";
        case WL_CONNECTED:
            return "connected";
        case WL_CONNECT_FAILED:
            return "connect failed";
        case WL_CONNECTION_LOST:
            return "conn lost";
        case WL_DISCONNECTED:
            return "disconnected";
        default:
            return "unknown";
    }
}

const char *mqttStateText(int state) {
    switch (state) {
        case MQTT_CONNECTION_TIMEOUT:
            return "connection timeout";
        case MQTT_CONNECTION_LOST:
            return "connection lost";
        case MQTT_CONNECT_FAILED:
            return "connect failed";
        case MQTT_DISCONNECTED:
            return "disconnected";
        case MQTT_CONNECTED:
            return "connected";
        case MQTT_CONNECT_BAD_PROTOCOL:
            return "bad protocol";
        case MQTT_CONNECT_BAD_CLIENT_ID:
            return "bad client id";
        case MQTT_CONNECT_UNAVAILABLE:
            return "server unavailable";
        case MQTT_CONNECT_BAD_CREDENTIALS:
            return "bad credentials";
        case MQTT_CONNECT_UNAUTHORIZED:
            return "unauthorized";
        default:
            return "unknown";
    }
}

bool scanTargetWifi() {
    renderMessage("Scanning WiFi");
    Serial.println("Scanning WiFi networks...");

    int networkCount = WiFi.scanNetworks(false, true);
    int bestRssi = -1000;
    int bestChannel = 0;
    int bestEncryption = 0;
    bool found = false;

    for (int i = 0; i < networkCount; i++) {
        if (WiFi.SSID(i) == WIFI_SSID_VALUE && WiFi.RSSI(i) > bestRssi) {
            found = true;
            bestRssi = WiFi.RSSI(i);
            bestChannel = WiFi.channel(i);
            bestEncryption = WiFi.encryptionType(i);
        }
    }

    targetWifiChannel = found ? bestChannel : 0;

    if (found) {
        snprintf(
            displayMessage,
            sizeof(displayMessage),
            "SSID: %s\nRSSI: %d dBm\nCH: %d AUTH: %d",
            WIFI_SSID_VALUE,
            bestRssi,
            bestChannel,
            bestEncryption
        );

        Serial.print("Target SSID found, RSSI: ");
        Serial.print(bestRssi);
        Serial.print(" dBm, channel: ");
        Serial.print(bestChannel);
        Serial.print(", auth: ");
        Serial.println(bestEncryption);
    } else {
        snprintf(
            displayMessage,
            sizeof(displayMessage),
            "SSID not found: %s\nNetworks: %d",
            WIFI_SSID_VALUE,
            networkCount
        );

        Serial.print("Target SSID not found. Network count: ");
        Serial.println(networkCount);
    }

    WiFi.scanDelete();
    renderMessage(found ? "WiFi scan found" : "WiFi scan missed");
    delay(1500);
    return found;
}

void drawWrappedText(const char *text, int16_t x, int16_t y) {
    const int16_t lineHeight = 10;
    const int16_t maxCharsPerLine = 21;
    int16_t line = 0;
    int16_t column = 0;

    display.setCursor(x, y);

    for (size_t i = 0; text[i] != '\0' && y + line * lineHeight < SCREEN_HEIGHT; i++) {
        char current = text[i];

        if (current == '\r') {
            continue;
        }

        if (current == '\n' || column >= maxCharsPerLine) {
            line++;
            column = 0;

            if (y + line * lineHeight >= SCREEN_HEIGHT) {
                break;
            }

            display.setCursor(x, y + line * lineHeight);

            if (current == '\n') {
                continue;
            }
        }

        display.print(current);
        column++;
    }
}

void renderMessage(const char *status) {
    display.clearDisplay();

    display.setTextColor(SSD1306_WHITE);
    display.setTextSize(1);

    display.setCursor(0, 0);
    display.print(status);

    display.drawLine(0, 10, SCREEN_WIDTH, 10, SSD1306_WHITE);
    drawWrappedText(displayMessage, 0, 16);

    display.display();
}

void handleMqttMessage(char *topic, byte *payload, unsigned int length) {
    QuotaState quota;

    if (!parseQuota(payload, length, quota)) {
        snprintf(displayMessage, sizeof(displayMessage), "Topic: %s\nInvalid quota JSON", topic);
        renderMessage("MQTT payload error");
        return;
    }

    Serial.print("Quota updated from topic: ");
    Serial.println(topic);
    renderQuota(quota);
}

void logConnectionStatus() {
    Serial.print("Status WiFi=");
    Serial.print(wifiStatusText(WiFi.status()));
    Serial.print(" IP=");
    Serial.print(WiFi.localIP());
    Serial.print(" MQTT=");
    Serial.print(mqttClient.connected() ? "connected" : "disconnected");
    Serial.print(" mqttState=");
    Serial.print(mqttClient.state());
    Serial.print(" ");
    Serial.println(mqttStateText(mqttClient.state()));
}

bool connectWifi() {
    Serial.print("Connecting WiFi SSID: ");
    Serial.println(WIFI_SSID_VALUE);
    Serial.print("WiFi MAC: ");
    Serial.println(WiFi.macAddress());
    Serial.print("WiFi password length: ");
    Serial.println(strlen(WIFI_PASSWORD_VALUE));

    WiFi.mode(WIFI_STA);
    WiFi.setSleep(false);
    WiFi.disconnect(false);
    delay(100);
    scanTargetWifi();

    if (targetWifiChannel > 0) {
        WiFi.begin(WIFI_SSID_VALUE, WIFI_PASSWORD_VALUE, targetWifiChannel);
    } else {
        WiFi.begin(WIFI_SSID_VALUE, WIFI_PASSWORD_VALUE);
    }

    renderMessage("Connecting WiFi");

    unsigned long startedAt = millis();

    while (WiFi.status() != WL_CONNECTED && millis() - startedAt < 15000) {
        delay(500);
    }

    wl_status_t status = WiFi.status();

    if (status != WL_CONNECTED) {
        snprintf(
            displayMessage,
            sizeof(displayMessage),
            "SSID: %s\nStatus: %s",
            WIFI_SSID_VALUE,
            wifiStatusText(status)
        );
        renderMessage("WiFi failed");

        Serial.print("WiFi failed, status: ");
        Serial.println(wifiStatusText(status));
        return false;
    }

    snprintf(
        displayMessage,
        sizeof(displayMessage),
        "IP: %s\nSSID: %s",
        WiFi.localIP().toString().c_str(),
        WIFI_SSID_VALUE
    );
    renderMessage("WiFi connected");

    Serial.print("WiFi connected, IP: ");
    Serial.println(WiFi.localIP());
    return true;
}

bool connectMqtt() {
    const bool hasCredentials = strlen(MQTT_USER_VALUE) > 0;
    bool connected = false;

    Serial.print("Connecting MQTT broker: ");
    Serial.print(MQTT_SERVER_VALUE);
    Serial.print(":");
    Serial.println(MQTT_PORT_VALUE);
    Serial.print("MQTT client id: ");
    Serial.println(MQTT_CLIENT_ID_VALUE);
    Serial.print("MQTT topic: ");
    Serial.println(MQTT_TOPIC_VALUE);
    Serial.print("MQTT username configured: ");
    Serial.println(hasCredentials ? "yes" : "no");

    if (hasCredentials) {
        connected = mqttClient.connect(
            MQTT_CLIENT_ID_VALUE,
            MQTT_USER_VALUE,
            MQTT_PASSWORD_VALUE
        );
    } else {
        connected = mqttClient.connect(MQTT_CLIENT_ID_VALUE);
    }

    if (!connected) {
        int state = mqttClient.state();
        snprintf(
            displayMessage,
            sizeof(displayMessage),
            "Broker: %s:%d\nState: %d %s",
            MQTT_SERVER_VALUE,
            MQTT_PORT_VALUE,
            state,
            mqttStateText(state)
        );

        Serial.print("MQTT connect failed, state: ");
        Serial.print(state);
        Serial.print(" ");
        Serial.println(mqttStateText(state));
        renderMessage("MQTT failed");
        return false;
    }

    if (!mqttClient.subscribe(MQTT_TOPIC_VALUE)) {
        snprintf(
            displayMessage,
            sizeof(displayMessage),
            "Topic: %s\nBroker connected\nSubscribe failed",
            MQTT_TOPIC_VALUE
        );
        Serial.print("MQTT subscribe failed, topic: ");
        Serial.println(MQTT_TOPIC_VALUE);
        renderMessage("MQTT sub failed");
        return false;
    }

    snprintf(
        displayMessage,
        sizeof(displayMessage),
        "Broker: %s:%d\nTopic: %s",
        MQTT_SERVER_VALUE,
        MQTT_PORT_VALUE,
        MQTT_TOPIC_VALUE
    );
    Serial.println("MQTT connected");
    renderMessage("MQTT connected");
    return true;
}

void setup() {
    delay(500);
    Serial.begin(115200);

    Wire.begin(OLED_SDA, OLED_SCL);

    if (!display.begin(
            SSD1306_SWITCHCAPVCC,
            OLED_ADDR
        )) {
        while (true) {
            delay(1000);
        }
    }

    renderMessage("Display ready");

    connectWifi();

    mqttClient.setServer(MQTT_SERVER_VALUE, MQTT_PORT_VALUE);
    mqttClient.setBufferSize(512);
    mqttClient.setCallback(handleMqttMessage);

    if (WiFi.status() == WL_CONNECTED) {
        connectMqtt();
    } else {
        Serial.println("MQTT skipped because WiFi is not connected");
    }
}

void loop() {
    unsigned long now = millis();

    if (now - lastStatusLog > 5000) {
        lastStatusLog = now;
        logConnectionStatus();
    }

    if (WiFi.status() != WL_CONNECTED) {
        if (now - lastWifiAttempt > 30000) {
            lastWifiAttempt = now;
            connectWifi();
        }

        return;
    }

    if (!mqttClient.connected()) {
        if (now - lastReconnectAttempt > 5000) {
            lastReconnectAttempt = now;

            if (connectMqtt()) {
                lastReconnectAttempt = 0;
            }
        }

        return;
    }

    mqttClient.loop();
}
