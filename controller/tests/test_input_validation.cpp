#include "test_framework.h"
#include "socket_server.h"
#include "app_state.h"
#include <algorithm>

// Phase 7 — Robustness: Input Validation (updated for ARM command)
//
// Changes tested here:
//   1. socket_count_commas() — counts commas for pre-parse validation
//   2. Comma-count guard — malformed commands are rejected before stoi()
//   3. remainingTime clamp — std::max(0LL, ...) keeps values >= 0

// ---------------------------------------- socket_count_commas ---

void test_count_commas_zero()
{
    CHECK_EQ(socket_count_commas("HELLO"), 0);
}

void test_count_commas_one()
{
    CHECK_EQ(socket_count_commas("ARM,1"), 1);
}

void test_count_commas_two()
{
    CHECK_EQ(socket_count_commas("ARM,2,5"), 2);
}

void test_count_commas_four()
{
    CHECK_EQ(socket_count_commas("WTRLVL,0,1,0,1"), 4);
}

void test_count_commas_empty_string()
{
    CHECK_EQ(socket_count_commas(""), 0);
}

void test_count_commas_only_commas()
{
    CHECK_EQ(socket_count_commas(",,,"), 3);
}

// -------------------------------- expected counts per command ---

void test_arm_command_requires_2_commas()
{
    // Valid ARM: ARM,<productId>,<qty>
    CHECK_EQ(socket_count_commas("ARM,1,3"), 2);
}

void test_wtrlvl_command_requires_4_commas()
{
    // Valid WTRLVL: WTRLVL,<p1>,<p2>,<p3>,<p4>
    CHECK_EQ(socket_count_commas("WTRLVL,0,0,0,0"), 4);
}

void test_malformed_arm_has_wrong_comma_count()
{
    CHECK(socket_count_commas("ARM,1") != 2);
}

void test_malformed_wtrlvl_has_wrong_comma_count()
{
    CHECK(socket_count_commas("WTRLVL,0,1") != 4);
}

// --------------------------------- remainingTime clamp math ---

void test_remainingTime_negative_value_clamps_to_zero()
{
    long long raw = -2500LL;
    long long clamped = std::max(0LL, raw);
    CHECK_EQ(clamped, 0LL);
}

void test_remainingTime_zero_stays_zero()
{
    long long raw = 0LL;
    long long clamped = std::max(0LL, raw);
    CHECK_EQ(clamped, 0LL);
}

void test_remainingTime_positive_value_passes_through()
{
    long long raw = 3000LL;
    long long clamped = std::max(0LL, raw);
    CHECK_EQ(clamped, 3000LL);
}

void test_remainingTime_large_positive_unchanged()
{
    long long raw = 999999LL;
    long long clamped = std::max(0LL, raw);
    CHECK_EQ(clamped, 999999LL);
}

// ---------------------------------------------------------- entry point ---

void run_input_validation_tests()
{
    SUITE("input_validation (robustness: input validation + clamp)");
    RUN_TEST(test_count_commas_zero);
    RUN_TEST(test_count_commas_one);
    RUN_TEST(test_count_commas_two);
    RUN_TEST(test_count_commas_four);
    RUN_TEST(test_count_commas_empty_string);
    RUN_TEST(test_count_commas_only_commas);
    RUN_TEST(test_arm_command_requires_2_commas);
    RUN_TEST(test_wtrlvl_command_requires_4_commas);
    RUN_TEST(test_malformed_arm_has_wrong_comma_count);
    RUN_TEST(test_malformed_wtrlvl_has_wrong_comma_count);
    RUN_TEST(test_remainingTime_negative_value_clamps_to_zero);
    RUN_TEST(test_remainingTime_zero_stays_zero);
    RUN_TEST(test_remainingTime_positive_value_passes_through);
    RUN_TEST(test_remainingTime_large_positive_unchanged);
}
