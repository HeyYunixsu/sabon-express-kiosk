#include "test_framework.h"
#include "utils.h"
#include "app_state.h"
#include <sstream>
#include <iostream>
#include <string>

// Phase 10 — Structured Logging
//
// Changes tested here:
//   1. log_info  writes "[timestamp] [module] msg" to stdout
//   2. log_error writes "[timestamp] [module] ERROR: msg" to stderr
//   3. Both include the module tag in square brackets
//   4. Timestamp prefix matches "YYYY-MM-DD HH:MM:SS" format (19 chars)

// ---------------------------------- log_info format ---

void test_log_info_writes_to_stdout()
{
    std::streambuf *orig = std::cout.rdbuf();
    std::ostringstream captured;
    std::cout.rdbuf(captured.rdbuf());

    log_info("testmod", "hello world");

    std::cout.rdbuf(orig);
    std::string out = captured.str();
    CHECK(!out.empty());
}

void test_log_info_contains_module_tag()
{
    std::streambuf *orig = std::cout.rdbuf();
    std::ostringstream captured;
    std::cout.rdbuf(captured.rdbuf());

    log_info("mymodule", "some message");

    std::cout.rdbuf(orig);
    CHECK(captured.str().find("[mymodule]") != std::string::npos);
}

void test_log_info_contains_message()
{
    std::streambuf *orig = std::cout.rdbuf();
    std::ostringstream captured;
    std::cout.rdbuf(captured.rdbuf());

    log_info("mod", "the_actual_message");

    std::cout.rdbuf(orig);
    CHECK(captured.str().find("the_actual_message") != std::string::npos);
}

void test_log_info_timestamp_format()
{
    std::streambuf *orig = std::cout.rdbuf();
    std::ostringstream captured;
    std::cout.rdbuf(captured.rdbuf());

    log_info("ts", "check");

    std::cout.rdbuf(orig);
    std::string out = captured.str();
    CHECK(out.size() >= 21);
    CHECK_EQ(out[0],  '[');
    CHECK_EQ(out[5],  '-');
    CHECK_EQ(out[8],  '-');
    CHECK_EQ(out[11], ' ');
    CHECK_EQ(out[14], ':');
    CHECK_EQ(out[17], ':');
    CHECK_EQ(out[20], ']');
}

void test_log_info_does_not_write_to_stderr()
{
    std::streambuf *orig = std::cerr.rdbuf();
    std::ostringstream captured;
    std::cerr.rdbuf(captured.rdbuf());

    log_info("mod", "info goes to stdout not stderr");

    std::cerr.rdbuf(orig);
    CHECK(captured.str().empty());
}

// ---------------------------------- log_error format ---

void test_log_error_writes_to_stderr()
{
    std::streambuf *orig = std::cerr.rdbuf();
    std::ostringstream captured;
    std::cerr.rdbuf(captured.rdbuf());

    log_error("errmod", "something broke");

    std::cerr.rdbuf(orig);
    CHECK(!captured.str().empty());
}

void test_log_error_contains_module_tag()
{
    std::streambuf *orig = std::cerr.rdbuf();
    std::ostringstream captured;
    std::cerr.rdbuf(captured.rdbuf());

    log_error("errmod", "msg");

    std::cerr.rdbuf(orig);
    CHECK(captured.str().find("[errmod]") != std::string::npos);
}

void test_log_error_contains_ERROR_label()
{
    std::streambuf *orig = std::cerr.rdbuf();
    std::ostringstream captured;
    std::cerr.rdbuf(captured.rdbuf());

    log_error("mod", "some problem");

    std::cerr.rdbuf(orig);
    CHECK(captured.str().find("ERROR") != std::string::npos);
}

void test_log_error_contains_message()
{
    std::streambuf *orig = std::cerr.rdbuf();
    std::ostringstream captured;
    std::cerr.rdbuf(captured.rdbuf());

    log_error("mod", "unique_error_msg_42");

    std::cerr.rdbuf(orig);
    CHECK(captured.str().find("unique_error_msg_42") != std::string::npos);
}

void test_log_error_does_not_write_to_stdout()
{
    std::streambuf *orig = std::cout.rdbuf();
    std::ostringstream captured;
    std::cout.rdbuf(captured.rdbuf());

    log_error("mod", "error goes to stderr not stdout");

    std::cout.rdbuf(orig);
    CHECK(captured.str().empty());
}

// ---------------------------------------------------------- entry point ---

void run_logging_tests()
{
    SUITE("logging (structured logging)");
    RUN_TEST(test_log_info_writes_to_stdout);
    RUN_TEST(test_log_info_contains_module_tag);
    RUN_TEST(test_log_info_contains_message);
    RUN_TEST(test_log_info_timestamp_format);
    RUN_TEST(test_log_info_does_not_write_to_stderr);
    RUN_TEST(test_log_error_writes_to_stderr);
    RUN_TEST(test_log_error_contains_module_tag);
    RUN_TEST(test_log_error_contains_ERROR_label);
    RUN_TEST(test_log_error_contains_message);
    RUN_TEST(test_log_error_does_not_write_to_stdout);
}
