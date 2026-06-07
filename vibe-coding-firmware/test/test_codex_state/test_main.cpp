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

void testMissingContextBecomesUnknown() {
    CodexDisplayState state = {};

    const bool parsed = parseJson(
        "{\"status\":\"IDLE\",\"fiveHourRemaining\":10,\"weeklyRemaining\":20,"
        "\"email\":\"user@example.com\"}",
        state
    );

    TEST_ASSERT_TRUE(parsed);
    TEST_ASSERT_EQUAL(-1, state.contextUsedPercent);
}

void testPercentagesClampToRange() {
    CodexDisplayState state = {};

    const bool parsed = parseJson(
        "{\"status\":\"WAIT\",\"fiveHourRemaining\":-5,\"weeklyRemaining\":120,"
        "\"contextUsedPercent\":101,\"email\":\"user@example.com\"}",
        state
    );

    TEST_ASSERT_TRUE(parsed);
    TEST_ASSERT_EQUAL(0, state.fiveHourRemaining);
    TEST_ASSERT_EQUAL(100, state.weeklyRemaining);
    TEST_ASSERT_EQUAL(100, state.contextUsedPercent);
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

}  // namespace

int main(int argc, char **argv) {
    UNITY_BEGIN();
    RUN_TEST(testCompleteStatePayload);
    RUN_TEST(testMissingContextBecomesUnknown);
    RUN_TEST(testPercentagesClampToRange);
    RUN_TEST(testBlankEmailRejectsPayload);
    RUN_TEST(testUnknownStatusRejectsPayload);
    RUN_TEST(testMqttDisconnectedIsOffline);
    RUN_TEST(testAvailabilityOfflineOverridesState);
    RUN_TEST(testValidOnlineStateReturnsPayloadStatus);
    return UNITY_END();
}
