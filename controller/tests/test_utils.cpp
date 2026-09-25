#include "test_framework.h"
#include "utils.h"
#include <filesystem>

namespace fs = std::filesystem;

// ------------------------------------------------------------------ trim ---

void test_trim_basic() {
    CHECK_EQ(trim("  hello  "), std::string("hello"));
}

void test_trim_leading_only() {
    CHECK_EQ(trim("   world"), std::string("world"));
}

void test_trim_trailing_only() {
    CHECK_EQ(trim("world   "), std::string("world"));
}

void test_trim_no_whitespace() {
    CHECK_EQ(trim("nochange"), std::string("nochange"));
}

void test_trim_empty_string() {
    CHECK_EQ(trim(""), std::string(""));
}

void test_trim_all_whitespace() {
    CHECK_EQ(trim("   \t  "), std::string(""));
}

// ---------------------------------------------------------------- loadEnv ---

void test_loadEnv_reads_key_value() {
    auto env = loadEnv("tests/fixtures/test.env");
    CHECK_EQ(env["vendorId"], std::string("vendor_123"));
    CHECK_EQ(env["machineId"], std::string("42"));
}

void test_loadEnv_ignores_comments() {
    auto env = loadEnv("tests/fixtures/test.env");
    CHECK(env.find("# this is a comment") == env.end());
}

void test_loadEnv_ignores_lines_without_equals() {
    auto env = loadEnv("tests/fixtures/test.env");
    CHECK(env.find("INVALID_LINE_NO_EQUALS") == env.end());
}

void test_loadEnv_strips_whitespace_from_key_and_value() {
    auto env = loadEnv("tests/fixtures/test.env");
    CHECK_EQ(env["spaces_key"], std::string("spaces_value"));
}

void test_loadEnv_strips_double_quotes() {
    auto env = loadEnv("tests/fixtures/test.env");
    CHECK_EQ(env["quoted_key"], std::string("double quoted"));
}

void test_loadEnv_strips_single_quotes() {
    auto env = loadEnv("tests/fixtures/test.env");
    CHECK_EQ(env["single_key"], std::string("single quoted"));
}

void test_loadEnv_missing_file_returns_empty_map() {
    auto env = loadEnv("tests/fixtures/nonexistent_file.env");
    CHECK(env.empty());
}

// -------------------------------------------------- format_current_time ---

void test_format_current_time_length_and_format() {
    auto now = std::chrono::system_clock::now();
    std::string result = format_current_time(now);
    CHECK_EQ((int)result.length(), 19);
    CHECK_EQ(result[4],  '-');
    CHECK_EQ(result[7],  '-');
    CHECK_EQ(result[10], ' ');
    CHECK_EQ(result[13], ':');
    CHECK_EQ(result[16], ':');
}

// ------------------------------------------ ensureDirectoryExists ---
// Phase 8 renamed createDirectoryIfNotExists -> ensureDirectoryExists and
// fixed the return value: now returns true when the directory is ready to
// use (whether it already existed OR was just created).

void test_ensureDirectory_creates_new_dir() {
    std::string path = "tests/tmp_test_dir";
    fs::remove_all(path);
    bool ready = ensureDirectoryExists(path);
    CHECK(ready);
    CHECK(fs::exists(path));
    fs::remove_all(path);
}

void test_ensureDirectory_returns_true_if_already_exists() {
    // Phase 8 fix: existing directory now returns true (ready to use)
    std::string path = "tests/fixtures";
    bool ready = ensureDirectoryExists(path);
    CHECK(ready);
}

// ---------------------------------------------------------- entry point ---

void run_utils_tests() {
    SUITE("utils");
    RUN_TEST(test_trim_basic);
    RUN_TEST(test_trim_leading_only);
    RUN_TEST(test_trim_trailing_only);
    RUN_TEST(test_trim_no_whitespace);
    RUN_TEST(test_trim_empty_string);
    RUN_TEST(test_trim_all_whitespace);
    RUN_TEST(test_loadEnv_reads_key_value);
    RUN_TEST(test_loadEnv_ignores_comments);
    RUN_TEST(test_loadEnv_ignores_lines_without_equals);
    RUN_TEST(test_loadEnv_strips_whitespace_from_key_and_value);
    RUN_TEST(test_loadEnv_strips_double_quotes);
    RUN_TEST(test_loadEnv_strips_single_quotes);
    RUN_TEST(test_loadEnv_missing_file_returns_empty_map);
    RUN_TEST(test_format_current_time_length_and_format);
    RUN_TEST(test_ensureDirectory_creates_new_dir);
    RUN_TEST(test_ensureDirectory_returns_true_if_already_exists);
}
