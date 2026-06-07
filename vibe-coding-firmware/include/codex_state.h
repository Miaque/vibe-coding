#pragma once

#include <cstddef>
#include <cstdint>

enum class CodexStatus {
    Idle,
    Working,
    Wait,
    Error,
    Offline,
};

struct CodexDisplayState {
    CodexStatus status;
    int fiveHourRemaining;
    int weeklyRemaining;
    int contextUsedPercent;
    bool accountStale;
    char email[64];
};

bool parseCodexState(const uint8_t *payload, size_t length, CodexDisplayState &state);
bool parseAvailability(const uint8_t *payload, size_t length, bool &serverOnline);
CodexStatus effectiveStatus(bool mqttConnected, bool serverOnline, bool hasValidState, CodexStatus payloadStatus);
const char *statusText(CodexStatus status);
bool mqttConnectAttemptDue(
    uint32_t now,
    uint32_t lastAttemptCompletedAt,
    bool hasAttempted,
    uint32_t retryInterval
);
