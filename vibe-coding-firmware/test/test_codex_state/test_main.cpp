#include <cstdio>
#include <cstring>
#include <unity.h>

#include "codex_state.h"

void setUp() {
}

void tearDown() {
}

namespace {

bool parseJson(const char *json, CodexDisplayState &state) {
    return parseCodexState(
        reinterpret_cast<const uint8_t *>(json),
        std::strlen(json),
        state
    );
}

CodexDisplayState sentinelState() {
    CodexDisplayState state = {};
    state.status = CodexStatus::Error;
    state.fiveHourRemaining = 11;
    state.weeklyRemaining = 22;
    state.contextUsedPercent = 33;
    state.accountStale = true;
    std::snprintf(state.email, sizeof(state.email), "%s", "sentinel@example.com");
    return state;
}

void assertSentinelState(const CodexDisplayState &state) {
    TEST_ASSERT_EQUAL(CodexStatus::Error, state.status);
    TEST_ASSERT_EQUAL(11, state.fiveHourRemaining);
    TEST_ASSERT_EQUAL(22, state.weeklyRemaining);
    TEST_ASSERT_EQUAL(33, state.contextUsedPercent);
    TEST_ASSERT_TRUE(state.accountStale);
    TEST_ASSERT_EQUAL_STRING("sentinel@example.com", state.email);
}

void assertInvalidPreservesState(const char *json) {
    CodexDisplayState state = sentinelState();

    TEST_ASSERT_FALSE(parseJson(json, state));
    assertSentinelState(state);
}

void testCompleteStatePayload() {
    CodexDisplayState state = {};

    const bool parsed = parseJson(
        "{\"status\":\"WORKING\",\"fiveHourRemaining\":42,\"weeklyRemaining\":87,"
        "\"contextUsedPercent\":33,\"accountStale\":true,\"email\":\"user@example.com\"}",
        state
    );

    TEST_ASSERT_TRUE(parsed);
    TEST_ASSERT_EQUAL(CodexStatus::Working, state.status);
    TEST_ASSERT_EQUAL(42, state.fiveHourRemaining);
    TEST_ASSERT_EQUAL(87, state.weeklyRemaining);
    TEST_ASSERT_EQUAL(33, state.contextUsedPercent);
    TEST_ASSERT_TRUE(state.accountStale);
    TEST_ASSERT_EQUAL_STRING("user@example.com", state.email);
}

void testFloatPercentagesUseIntegerConversionAndClamp() {
    CodexDisplayState state = {};

    const bool parsed = parseJson(
        "{\"status\":\"WAIT\",\"fiveHourRemaining\":72.9,\"weeklyRemaining\":-0.5,"
        "\"contextUsedPercent\":100.9,\"accountStale\":false,\"email\":\"user@example.com\"}",
        state
    );

    TEST_ASSERT_TRUE(parsed);
    TEST_ASSERT_EQUAL(72, state.fiveHourRemaining);
    TEST_ASSERT_EQUAL(0, state.weeklyRemaining);
    TEST_ASSERT_EQUAL(100, state.contextUsedPercent);
}

void testOutOfRangeNumbersClampBeforeIntegerConversion() {
    CodexDisplayState positiveState = {};
    CodexDisplayState negativeState = {};

    TEST_ASSERT_TRUE(parseJson(
        "{\"status\":\"WAIT\",\"fiveHourRemaining\":2147483648,"
        "\"weeklyRemaining\":1e100,\"contextUsedPercent\":72.9,"
        "\"accountStale\":false,\"email\":\"user@example.com\"}",
        positiveState
    ));
    TEST_ASSERT_EQUAL(100, positiveState.fiveHourRemaining);
    TEST_ASSERT_EQUAL(100, positiveState.weeklyRemaining);
    TEST_ASSERT_EQUAL(72, positiveState.contextUsedPercent);

    TEST_ASSERT_TRUE(parseJson(
        "{\"status\":\"WAIT\",\"fiveHourRemaining\":-1e100,\"weeklyRemaining\":20,"
        "\"contextUsedPercent\":30,\"accountStale\":false,\"email\":\"user@example.com\"}",
        negativeState
    ));
    TEST_ASSERT_EQUAL(0, negativeState.fiveHourRemaining);
}

void testMissingContextBecomesUnknown() {
    CodexDisplayState state = {};

    const bool parsed = parseJson(
        "{\"status\":\"IDLE\",\"fiveHourRemaining\":10,\"weeklyRemaining\":20,"
        "\"accountStale\":false,\"email\":\"user@example.com\"}",
        state
    );

    TEST_ASSERT_TRUE(parsed);
    TEST_ASSERT_EQUAL(-1, state.contextUsedPercent);
}

void testMissingOrNullPercentagesBecomeUnknown() {
    CodexDisplayState missingState = {};
    CodexDisplayState nullState = {};

    TEST_ASSERT_TRUE(parseJson(
        "{\"status\":\"IDLE\",\"accountStale\":false,\"email\":\"user@example.com\"}",
        missingState
    ));
    TEST_ASSERT_EQUAL(-1, missingState.fiveHourRemaining);
    TEST_ASSERT_EQUAL(-1, missingState.weeklyRemaining);
    TEST_ASSERT_EQUAL(-1, missingState.contextUsedPercent);

    TEST_ASSERT_TRUE(parseJson(
        "{\"status\":\"IDLE\",\"fiveHourRemaining\":null,\"weeklyRemaining\":null,"
        "\"contextUsedPercent\":null,\"accountStale\":false,\"email\":\"user@example.com\"}",
        nullState
    ));
    TEST_ASSERT_EQUAL(-1, nullState.fiveHourRemaining);
    TEST_ASSERT_EQUAL(-1, nullState.weeklyRemaining);
    TEST_ASSERT_EQUAL(-1, nullState.contextUsedPercent);
}

void testPercentagesClampToRange() {
    CodexDisplayState state = {};

    const bool parsed = parseJson(
        "{\"status\":\"WAIT\",\"fiveHourRemaining\":-5,\"weeklyRemaining\":120,"
        "\"contextUsedPercent\":101,\"accountStale\":false,\"email\":\"user@example.com\"}",
        state
    );

    TEST_ASSERT_TRUE(parsed);
    TEST_ASSERT_EQUAL(0, state.fiveHourRemaining);
    TEST_ASSERT_EQUAL(100, state.weeklyRemaining);
    TEST_ASSERT_EQUAL(100, state.contextUsedPercent);
}

void testPercentageStringRejectsPayload() {
    assertInvalidPreservesState(
        "{\"status\":\"IDLE\",\"fiveHourRemaining\":\"72\",\"weeklyRemaining\":20,"
        "\"contextUsedPercent\":30,\"accountStale\":false,\"email\":\"user@example.com\"}"
    );
    assertInvalidPreservesState(
        "{\"status\":\"IDLE\",\"fiveHourRemaining\":10,\"weeklyRemaining\":\"bad\","
        "\"contextUsedPercent\":30,\"accountStale\":false,\"email\":\"user@example.com\"}"
    );
    assertInvalidPreservesState(
        "{\"status\":\"IDLE\",\"fiveHourRemaining\":10,\"weeklyRemaining\":20,"
        "\"contextUsedPercent\":\"30\",\"accountStale\":false,\"email\":\"user@example.com\"}"
    );
}

void testPercentageBooleanRejectsPayload() {
    assertInvalidPreservesState(
        "{\"status\":\"IDLE\",\"fiveHourRemaining\":true,\"weeklyRemaining\":20,"
        "\"contextUsedPercent\":30,\"accountStale\":false,\"email\":\"user@example.com\"}"
    );
    assertInvalidPreservesState(
        "{\"status\":\"IDLE\",\"fiveHourRemaining\":10,\"weeklyRemaining\":false,"
        "\"contextUsedPercent\":30,\"accountStale\":false,\"email\":\"user@example.com\"}"
    );
    assertInvalidPreservesState(
        "{\"status\":\"IDLE\",\"fiveHourRemaining\":10,\"weeklyRemaining\":20,"
        "\"contextUsedPercent\":true,\"accountStale\":false,\"email\":\"user@example.com\"}"
    );
}

void testPercentageObjectRejectsPayload() {
    assertInvalidPreservesState(
        "{\"status\":\"IDLE\",\"fiveHourRemaining\":{},\"weeklyRemaining\":20,"
        "\"contextUsedPercent\":30,\"accountStale\":false,\"email\":\"user@example.com\"}"
    );
    assertInvalidPreservesState(
        "{\"status\":\"IDLE\",\"fiveHourRemaining\":10,\"weeklyRemaining\":{},"
        "\"contextUsedPercent\":30,\"accountStale\":false,\"email\":\"user@example.com\"}"
    );
    assertInvalidPreservesState(
        "{\"status\":\"IDLE\",\"fiveHourRemaining\":10,\"weeklyRemaining\":20,"
        "\"contextUsedPercent\":{},\"accountStale\":false,\"email\":\"user@example.com\"}"
    );
}

void testAccountStaleFalseIsValid() {
    CodexDisplayState state = {};

    TEST_ASSERT_TRUE(parseJson(
        "{\"status\":\"IDLE\",\"fiveHourRemaining\":10,\"weeklyRemaining\":20,"
        "\"contextUsedPercent\":30,\"accountStale\":false,\"email\":\"user@example.com\"}",
        state
    ));
    TEST_ASSERT_FALSE(state.accountStale);
}

void testAccountStaleMissingOrNullRejectsPayload() {
    assertInvalidPreservesState(
        "{\"status\":\"IDLE\",\"fiveHourRemaining\":10,\"weeklyRemaining\":20,"
        "\"contextUsedPercent\":30,\"email\":\"user@example.com\"}"
    );
    assertInvalidPreservesState(
        "{\"status\":\"IDLE\",\"fiveHourRemaining\":10,\"weeklyRemaining\":20,"
        "\"contextUsedPercent\":30,\"accountStale\":null,\"email\":\"user@example.com\"}"
    );
}

void testAccountStaleStringOrNumberRejectsPayload() {
    assertInvalidPreservesState(
        "{\"status\":\"IDLE\",\"fiveHourRemaining\":10,\"weeklyRemaining\":20,"
        "\"contextUsedPercent\":30,\"accountStale\":\"false\",\"email\":\"user@example.com\"}"
    );
    assertInvalidPreservesState(
        "{\"status\":\"IDLE\",\"fiveHourRemaining\":10,\"weeklyRemaining\":20,"
        "\"contextUsedPercent\":30,\"accountStale\":0,\"email\":\"user@example.com\"}"
    );
}

void testParseFailurePreservesState() {
    assertInvalidPreservesState(
        "{\"status\":\"BUSY\",\"fiveHourRemaining\":10,\"weeklyRemaining\":20,"
        "\"contextUsedPercent\":30,\"accountStale\":false,\"email\":\"user@example.com\"}"
    );
}

void testBlankEmailRejectsPayload() {
    CodexDisplayState state = {};

    TEST_ASSERT_FALSE(parseJson(
        "{\"status\":\"IDLE\",\"fiveHourRemaining\":10,\"weeklyRemaining\":20,"
        "\"contextUsedPercent\":30,\"email\":\"  \\t\"}",
        state
    ));
}

void testUnknownStatusRejectsPayload() {
    CodexDisplayState state = {};

    TEST_ASSERT_FALSE(parseJson(
        "{\"status\":\"BUSY\",\"fiveHourRemaining\":10,\"weeklyRemaining\":20,"
        "\"contextUsedPercent\":30,\"email\":\"user@example.com\"}",
        state
    ));
}

void testMqttDisconnectedIsOffline() {
    TEST_ASSERT_EQUAL(
        CodexStatus::Offline,
        effectiveStatus(false, true, true, CodexStatus::Working)
    );
}

void testAvailabilityOfflineOverridesState() {
    TEST_ASSERT_EQUAL(
        CodexStatus::Offline,
        effectiveStatus(true, false, true, CodexStatus::Working)
    );
    TEST_ASSERT_EQUAL(
        CodexStatus::Offline,
        effectiveStatus(true, true, false, CodexStatus::Working)
    );
}

void testValidOnlineStateReturnsPayloadStatus() {
    TEST_ASSERT_EQUAL(
        CodexStatus::Wait,
        effectiveStatus(true, true, true, CodexStatus::Wait)
    );
    TEST_ASSERT_EQUAL_STRING("WAIT", statusText(CodexStatus::Wait));
    TEST_ASSERT_EQUAL_STRING("OFFLINE", statusText(CodexStatus::Offline));
}

void testAvailabilityAcceptsExactPayloads() {
    bool serverOnline = false;

    TEST_ASSERT_TRUE(parseAvailability(
        reinterpret_cast<const uint8_t *>("online"),
        6,
        serverOnline
    ));
    TEST_ASSERT_TRUE(serverOnline);

    TEST_ASSERT_TRUE(parseAvailability(
        reinterpret_cast<const uint8_t *>("offline"),
        7,
        serverOnline
    ));
    TEST_ASSERT_FALSE(serverOnline);
}

void testInvalidAvailabilityPreservesCurrentValue() {
    bool serverOnline = true;

    TEST_ASSERT_FALSE(parseAvailability(
        reinterpret_cast<const uint8_t *>("online\n"),
        7,
        serverOnline
    ));
    TEST_ASSERT_TRUE(serverOnline);

    TEST_ASSERT_FALSE(parseAvailability(
        reinterpret_cast<const uint8_t *>("ONLINE"),
        6,
        serverOnline
    ));
    TEST_ASSERT_TRUE(serverOnline);

    TEST_ASSERT_FALSE(parseAvailability(nullptr, 0, serverOnline));
    TEST_ASSERT_TRUE(serverOnline);
}

void testFirstMqttConnectAttemptIsImmediate() {
    TEST_ASSERT_TRUE(mqttConnectAttemptDue(100, 0, false, 5000));
}

void testMqttConnectRetryWaitsForInterval() {
    TEST_ASSERT_FALSE(mqttConnectAttemptDue(5999, 1000, true, 5000));
    TEST_ASSERT_TRUE(mqttConnectAttemptDue(6000, 1000, true, 5000));
}

void testMqttConnectRetryHandlesMillisWrap() {
    TEST_ASSERT_FALSE(mqttConnectAttemptDue(48, UINT32_MAX - 100, true, 150));
    TEST_ASSERT_TRUE(mqttConnectAttemptDue(49, UINT32_MAX - 100, true, 150));
}

}  // namespace

int main(int argc, char **argv) {
    UNITY_BEGIN();
    RUN_TEST(testCompleteStatePayload);
    RUN_TEST(testFloatPercentagesUseIntegerConversionAndClamp);
    RUN_TEST(testOutOfRangeNumbersClampBeforeIntegerConversion);
    RUN_TEST(testMissingContextBecomesUnknown);
    RUN_TEST(testMissingOrNullPercentagesBecomeUnknown);
    RUN_TEST(testPercentagesClampToRange);
    RUN_TEST(testPercentageStringRejectsPayload);
    RUN_TEST(testPercentageBooleanRejectsPayload);
    RUN_TEST(testPercentageObjectRejectsPayload);
    RUN_TEST(testAccountStaleFalseIsValid);
    RUN_TEST(testAccountStaleMissingOrNullRejectsPayload);
    RUN_TEST(testAccountStaleStringOrNumberRejectsPayload);
    RUN_TEST(testParseFailurePreservesState);
    RUN_TEST(testBlankEmailRejectsPayload);
    RUN_TEST(testUnknownStatusRejectsPayload);
    RUN_TEST(testMqttDisconnectedIsOffline);
    RUN_TEST(testAvailabilityOfflineOverridesState);
    RUN_TEST(testValidOnlineStateReturnsPayloadStatus);
    RUN_TEST(testAvailabilityAcceptsExactPayloads);
    RUN_TEST(testInvalidAvailabilityPreservesCurrentValue);
    RUN_TEST(testFirstMqttConnectAttemptIsImmediate);
    RUN_TEST(testMqttConnectRetryWaitsForInterval);
    RUN_TEST(testMqttConnectRetryHandlesMillisWrap);
    return UNITY_END();
}
