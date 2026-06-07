#include "codex_state.h"

#include <ArduinoJson.h>
#include <cctype>
#include <cmath>
#include <cstdio>
#include <cstring>

namespace {

bool parsePercent(JsonVariantConst value, int &percent) {
    if (value.isNull()) {
        percent = -1;
        return true;
    }

    if (!value.is<JsonInteger>() && !value.is<JsonFloat>()) {
        return false;
    }

    const JsonFloat parsedPercent = value.as<JsonFloat>();

    if (!std::isfinite(parsedPercent)) {
        return false;
    }

    if (parsedPercent <= 0) {
        percent = 0;
        return true;
    }

    if (parsedPercent >= 100) {
        percent = 100;
        return true;
    }

    percent = static_cast<int>(parsedPercent);
    return true;
}

bool parseAccountStale(JsonVariantConst value, bool &accountStale) {
    if (!value.is<bool>()) {
        return false;
    }

    accountStale = value.as<bool>();
    return true;
}

bool isBlank(const char *value) {
    if (value == nullptr) {
        return true;
    }

    for (size_t i = 0; value[i] != '\0'; i++) {
        if (!std::isspace(static_cast<unsigned char>(value[i]))) {
            return false;
        }
    }

    return true;
}

bool parseStatus(const char *value, CodexStatus &status) {
    if (value == nullptr) {
        return false;
    }

    if (std::strcmp(value, "IDLE") == 0) {
        status = CodexStatus::Idle;
        return true;
    }

    if (std::strcmp(value, "WORKING") == 0) {
        status = CodexStatus::Working;
        return true;
    }

    if (std::strcmp(value, "WAIT") == 0) {
        status = CodexStatus::Wait;
        return true;
    }

    if (std::strcmp(value, "ERROR") == 0) {
        status = CodexStatus::Error;
        return true;
    }

    return false;
}

}  // namespace

bool parseCodexState(const uint8_t *payload, size_t length, CodexDisplayState &state) {
    if (payload == nullptr || length == 0) {
        return false;
    }

    JsonDocument document;
    DeserializationError error = deserializeJson(
        document,
        reinterpret_cast<const char *>(payload),
        length
    );

    if (error) {
        return false;
    }

    CodexDisplayState nextState = {};
    const char *status = document["status"].as<const char *>();

    if (!parseStatus(status, nextState.status)) {
        return false;
    }

    const char *email = document["email"].as<const char *>();

    if (isBlank(email)) {
        return false;
    }

    if (!parsePercent(document["fiveHourRemaining"], nextState.fiveHourRemaining)) {
        return false;
    }

    if (!parsePercent(document["weeklyRemaining"], nextState.weeklyRemaining)) {
        return false;
    }

    if (!parsePercent(document["contextUsedPercent"], nextState.contextUsedPercent)) {
        return false;
    }

    if (!parseAccountStale(document["accountStale"], nextState.accountStale)) {
        return false;
    }

    std::snprintf(nextState.email, sizeof(nextState.email), "%s", email);
    state = nextState;

    return true;
}

bool parseAvailability(const uint8_t *payload, size_t length, bool &serverOnline) {
    if (payload == nullptr) {
        return false;
    }

    if (length == 6 && std::memcmp(payload, "online", length) == 0) {
        serverOnline = true;
        return true;
    }

    if (length == 7 && std::memcmp(payload, "offline", length) == 0) {
        serverOnline = false;
        return true;
    }

    return false;
}

CodexStatus effectiveStatus(
    bool mqttConnected,
    bool serverOnline,
    bool hasValidState,
    CodexStatus payloadStatus
) {
    if (!mqttConnected || !serverOnline || !hasValidState) {
        return CodexStatus::Offline;
    }

    return payloadStatus;
}

const char *statusText(CodexStatus status) {
    switch (status) {
        case CodexStatus::Idle:
            return "IDLE";
        case CodexStatus::Working:
            return "WORKING";
        case CodexStatus::Wait:
            return "WAIT";
        case CodexStatus::Error:
            return "ERROR";
        case CodexStatus::Offline:
            return "OFFLINE";
        default:
            return "OFFLINE";
    }
}

bool mqttConnectAttemptDue(
    uint32_t now,
    uint32_t lastAttemptCompletedAt,
    bool hasAttempted,
    uint32_t retryInterval
) {
    return !hasAttempted || now - lastAttemptCompletedAt >= retryInterval;
}
