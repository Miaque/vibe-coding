#include <Arduino.h>
#include <Wire.h>
#include <WiFi.h>
#include <PubSubClient.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include "codex_state.h"
#include "generated_config.h"

#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64

#define OLED_SDA 8
#define OLED_SCL 9
#define OLED_ADDR 0x3C

namespace {

constexpr int16_t EMAIL_Y = 0;
constexpr int16_t LABEL_Y = 13;
constexpr int16_t PERCENT_Y = 24;
constexpr int16_t BAR_Y = 35;
constexpr int16_t DIVIDER_Y = 50;
constexpr int16_t FOOTER_Y = 54;
constexpr int16_t STALE_X = 122;
constexpr unsigned long BLINK_INTERVAL_MS = 500;
constexpr unsigned long WIFI_RETRY_INTERVAL_MS = 30000;
constexpr unsigned long MQTT_RETRY_INTERVAL_MS = 5000;
constexpr unsigned long STATUS_LOG_INTERVAL_MS = 5000;
constexpr uint16_t MQTT_SOCKET_TIMEOUT_SECONDS = 1;

Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, -1);
WiFiClient wifiClient;
PubSubClient mqttClient(wifiClient);

CodexDisplayState currentState = {
    CodexStatus::Offline,
    -1,
    -1,
    -1,
    false,
    "",
};
bool hasValidState = false;
bool serverOnline = false;
bool blinkVisible = true;
bool lastMqttConnected = false;
unsigned long lastBlinkToggle = 0;
unsigned long lastWifiAttempt = 0;
unsigned long lastMqttConnectCompletedAt = 0;
unsigned long lastStatusLog = 0;
bool hasMqttConnectAttempted = false;

CodexStatus currentStatus() {
    return effectiveStatus(
        WiFi.status() == WL_CONNECTED && mqttClient.connected(),
        serverOnline,
        hasValidState,
        currentState.status
    );
}

void drawEmail(const char *email, bool stale) {
    constexpr size_t MAX_CHARS = 20;
    constexpr size_t LEFT_CHARS = 8;
    constexpr size_t RIGHT_CHARS = 9;
    const char *text = email[0] == '\0' ? "Account unavailable" : email;
    const size_t length = strlen(text);

    display.setCursor(0, EMAIL_Y);

    if (length <= MAX_CHARS) {
        display.print(text);
    } else {
        for (size_t i = 0; i < LEFT_CHARS; i++) {
            display.print(text[i]);
        }

        display.print("...");
        display.print(text + length - RIGHT_CHARS);
    }

    if (stale) {
        display.setCursor(STALE_X, EMAIL_Y);
        display.print("*");
    }
}

void drawPercent(int16_t x, int percentage) {
    display.setCursor(x, PERCENT_Y);

    if (percentage < 0) {
        display.print("--%");
        return;
    }

    display.print(percentage);
    display.print("%");
}

void drawFourCellBar(int16_t x, int percentage) {
    constexpr int16_t CELL_WIDTH = 8;
    constexpr int16_t CELL_HEIGHT = 7;
    constexpr int16_t CELL_GAP = 1;
    const int filledCells = percentage < 0 ? 0 : min(4, (percentage + 24) / 25);

    for (int cell = 0; cell < 4; cell++) {
        const int16_t cellX = x + cell * (CELL_WIDTH + CELL_GAP);
        display.drawRect(cellX, BAR_Y, CELL_WIDTH, CELL_HEIGHT, SSD1306_WHITE);

        if (cell < filledCells) {
            display.fillRect(
                cellX + 2,
                BAR_Y + 2,
                CELL_WIDTH - 4,
                CELL_HEIGHT - 4,
                SSD1306_WHITE
            );
        }
    }
}

void drawFooter() {
    const CodexStatus status = currentStatus();
    const bool blinking = status == CodexStatus::Wait || status == CodexStatus::Error;

    display.fillRect(0, DIVIDER_Y + 1, SCREEN_WIDTH, SCREEN_HEIGHT - DIVIDER_Y - 1, SSD1306_BLACK);
    display.drawLine(0, DIVIDER_Y, SCREEN_WIDTH, DIVIDER_Y, SSD1306_WHITE);
    display.setCursor(0, FOOTER_Y);

    if (!blinking || blinkVisible) {
        display.print(statusText(status));
    }
}

void renderFooter() {
    drawFooter();
    display.display();
}

void renderDashboard() {
    display.clearDisplay();
    display.setTextColor(SSD1306_WHITE);
    display.setTextSize(1);

    drawEmail(currentState.email, hasValidState && currentState.accountStale);

    display.setCursor(0, LABEL_Y);
    display.print("5H");
    display.setCursor(43, LABEL_Y);
    display.print("WK");
    display.setCursor(86, LABEL_Y);
    display.print("CTX");

    drawPercent(0, currentState.fiveHourRemaining);
    drawPercent(43, currentState.weeklyRemaining);
    drawPercent(86, currentState.contextUsedPercent);

    drawFourCellBar(0, currentState.fiveHourRemaining);
    drawFourCellBar(43, currentState.weeklyRemaining);
    drawFourCellBar(86, currentState.contextUsedPercent);

    drawFooter();
    display.display();
}

void resetBlink() {
    blinkVisible = true;
    lastBlinkToggle = millis();
}

void handleStatePayload(byte *payload, unsigned int length) {
    CodexDisplayState nextState = currentState;

    if (!parseCodexState(payload, length, nextState)) {
        Serial.println("忽略无效的 state payload");
        return;
    }

    currentState = nextState;
    hasValidState = true;
    resetBlink();
    renderDashboard();
}

void handleAvailabilityPayload(byte *payload, unsigned int length) {
    if (!parseAvailability(payload, length, serverOnline)) {
        Serial.println("忽略无效的 availability payload");
        return;
    }

    resetBlink();
    renderFooter();
}

void handleMqttMessage(char *topic, byte *payload, unsigned int length) {
    if (strcmp(topic, MQTT_STATE_TOPIC_VALUE) == 0) {
        handleStatePayload(payload, length);
        return;
    }

    if (strcmp(topic, MQTT_AVAILABILITY_TOPIC_VALUE) == 0) {
        handleAvailabilityPayload(payload, length);
    }
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

void logConnectionStatus() {
    Serial.print("连接状态 WiFi=");
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

void startWifiConnection() {
    lastWifiAttempt = millis();
    Serial.print("正在连接 WiFi SSID: ");
    Serial.println(WIFI_SSID_VALUE);
    WiFi.begin(WIFI_SSID_VALUE, WIFI_PASSWORD_VALUE);
}

bool connectMqtt() {
    const bool hasCredentials = strlen(MQTT_USER_VALUE) > 0;
    bool connected = false;

    Serial.print("正在连接 MQTT broker: ");
    Serial.print(MQTT_SERVER_VALUE);
    Serial.print(":");
    Serial.println(MQTT_PORT_VALUE);

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
        Serial.print("MQTT 连接失败，状态: ");
        Serial.println(mqttClient.state());
        return false;
    }

    const bool stateSubscribed = mqttClient.subscribe(MQTT_STATE_TOPIC_VALUE);
    const bool availabilitySubscribed = mqttClient.subscribe(MQTT_AVAILABILITY_TOPIC_VALUE);

    if (!stateSubscribed || !availabilitySubscribed) {
        Serial.println("MQTT topic 订阅失败");
        mqttClient.disconnect();
        return false;
    }

    serverOnline = false;
    resetBlink();
    renderFooter();
    Serial.println("MQTT 已连接并完成订阅");
    return true;
}

void refreshConnectionState() {
    const bool mqttConnected = WiFi.status() == WL_CONNECTED && mqttClient.connected();

    if (mqttConnected == lastMqttConnected) {
        return;
    }

    lastMqttConnected = mqttConnected;

    if (!mqttConnected) {
        serverOnline = false;
    }

    resetBlink();
    renderFooter();
}

void updateBlink(unsigned long now) {
    const CodexStatus status = currentStatus();

    if (status != CodexStatus::Wait && status != CodexStatus::Error) {
        if (!blinkVisible) {
            blinkVisible = true;
            renderFooter();
        }

        return;
    }

    if (now - lastBlinkToggle >= BLINK_INTERVAL_MS) {
        lastBlinkToggle = now;
        blinkVisible = !blinkVisible;
        renderFooter();
    }
}

}  // namespace

void setup() {
    delay(500);
    Serial.begin(115200);

    Wire.begin(OLED_SDA, OLED_SCL);

    if (!display.begin(SSD1306_SWITCHCAPVCC, OLED_ADDR)) {
        while (true) {
            delay(1000);
        }
    }

    renderDashboard();

    WiFi.mode(WIFI_STA);
    WiFi.setSleep(false);
    startWifiConnection();

    mqttClient.setServer(MQTT_SERVER_VALUE, MQTT_PORT_VALUE);
    mqttClient.setBufferSize(512);
    mqttClient.setSocketTimeout(MQTT_SOCKET_TIMEOUT_SECONDS);
    mqttClient.setCallback(handleMqttMessage);
}

void loop() {
    const unsigned long now = millis();

    if (now - lastStatusLog >= STATUS_LOG_INTERVAL_MS) {
        lastStatusLog = now;
        logConnectionStatus();
    }

    if (WiFi.status() != WL_CONNECTED) {
        refreshConnectionState();

        if (now - lastWifiAttempt >= WIFI_RETRY_INTERVAL_MS) {
            startWifiConnection();
        }

        updateBlink(now);
        return;
    }

    if (!mqttClient.connected()) {
        refreshConnectionState();

        if (mqttConnectAttemptDue(
                now,
                lastMqttConnectCompletedAt,
                hasMqttConnectAttempted,
                MQTT_RETRY_INTERVAL_MS
            )) {
            connectMqtt();
            lastMqttConnectCompletedAt = millis();
            hasMqttConnectAttempted = true;
        }

        updateBlink(now);
        return;
    }

    mqttClient.loop();
    refreshConnectionState();
    updateBlink(now);
}
