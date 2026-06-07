#include "codex_state.h"

#include <ArduinoJson.h>
#include <cctype>
#include <cstdio>
#include <cstring>

namespace {

int normalizePercent(JsonVariantConst value) {
    if (value.isNull()) {
        return -1;
    }

    const int percent = value.as<int>();

    if (percent < 0) {
        return 0;
    }

    if (percent > 100) {
        return 100;
    }

    return percent;
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

    CodexStatus parsedStatus = CodexStatus::Offline;
    const char *status = document["status"].as<const char *>();

    if (!parseStatus(status, parsedStatus)) {
        return false;
    }

    const char *email = document["email"].as<const char *>();

    if (isBlank(email)) {
        return false;
    }

    state.status = parsedStatus;
    state.fiveHourRemaining = normalizePercent(document["fiveHourRemaining"]);
    state.weeklyRemaining = normalizePercent(document["weeklyRemaining"]);
    state.contextUsedPercent = normalizePercent(document["contextUsedPercent"]);
    state.accountStale = document["accountStale"] | false;
    std::snprintf(state.email, sizeof(state.email), "%s", email);

    return true;
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
