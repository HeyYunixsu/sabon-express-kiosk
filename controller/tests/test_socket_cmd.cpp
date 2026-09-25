#include "test_framework.h"
#include "socket_server.h"

// Tests for isFirstWordTest() — the command-parsing helper in socket_server.
// Updated for ARM command (replaces COIN/VOUCHER).

void test_exact_word_matches() {
    CHECK(isFirstWordTest("ARM", "ARM"));
}

void test_match_with_comma_delimiter() {
    CHECK(isFirstWordTest("ARM,1,3", "ARM"));
}

void test_match_with_space_delimiter() {
    CHECK(isFirstWordTest("STATUS check", "STATUS"));
}

void test_longer_word_does_not_match() {
    // "ARMED" must NOT match keyword "ARM"
    CHECK(!isFirstWordTest("ARMED,1,3", "ARM"));
}

void test_different_word_does_not_match() {
    CHECK(!isFirstWordTest("WTRLVL,0,0,0,0", "ARM"));
}

void test_arm_command_matches() {
    CHECK(isFirstWordTest("ARM,2,5", "ARM"));
}

void test_wtrlvl_command_matches() {
    CHECK(isFirstWordTest("WTRLVL,0,1,0,1", "WTRLVL"));
}

void test_status_command_matches() {
    CHECK(isFirstWordTest("STATUS", "STATUS"));
}

void test_empty_string_does_not_match() {
    CHECK(!isFirstWordTest("", "ARM"));
}

void test_shorter_than_keyword_does_not_match() {
    CHECK(!isFirstWordTest("AR", "ARM"));
}

void test_keyword_as_prefix_of_longer_word_no_match() {
    // "WTRLVLED" must NOT match "WTRLVL"
    CHECK(!isFirstWordTest("WTRLVLED,x,5", "WTRLVL"));
}

// ---------------------------------------------------------- entry point ---

void run_socket_cmd_tests() {
    SUITE("socket_server (command parsing)");
    RUN_TEST(test_exact_word_matches);
    RUN_TEST(test_match_with_comma_delimiter);
    RUN_TEST(test_match_with_space_delimiter);
    RUN_TEST(test_longer_word_does_not_match);
    RUN_TEST(test_different_word_does_not_match);
    RUN_TEST(test_arm_command_matches);
    RUN_TEST(test_wtrlvl_command_matches);
    RUN_TEST(test_status_command_matches);
    RUN_TEST(test_empty_string_does_not_match);
    RUN_TEST(test_shorter_than_keyword_does_not_match);
    RUN_TEST(test_keyword_as_prefix_of_longer_word_no_match);
}
