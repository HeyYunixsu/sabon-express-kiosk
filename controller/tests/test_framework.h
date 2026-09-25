#pragma once
#include <iostream>
#include <sstream>
#include <string>

// C++17 inline globals — one shared instance across all translation units
inline int g_passes = 0;
inline int g_failures = 0;
inline int g_test_fail_count = 0;

template<typename T>
inline std::string _to_str(const T& val) {
    std::ostringstream oss;
    oss << std::boolalpha << val;
    return oss.str();
}

// CHECK: assert a boolean expression
#define CHECK(expr) \
    do { \
        if (!(expr)) { \
            std::cout << "\n    FAIL: " #expr \
                      << " (" << __FILE__ << ":" << __LINE__ << ")"; \
            ++g_failures; ++g_test_fail_count; \
        } else { \
            ++g_passes; \
        } \
    } while(0)

// CHECK_EQ: assert two values are equal, print both on failure
#define CHECK_EQ(a, b) \
    do { \
        auto _a = (a); \
        auto _b = (b); \
        if (!(_a == _b)) { \
            std::cout << "\n    FAIL: " #a " == " #b \
                      << "\n       got:      " << _to_str(_a) \
                      << "\n       expected: " << _to_str(_b) \
                      << " (" << __FILE__ << ":" << __LINE__ << ")"; \
            ++g_failures; ++g_test_fail_count; \
        } else { \
            ++g_passes; \
        } \
    } while(0)

// RUN_TEST: run a void test function and report pass/fail
#define RUN_TEST(fn) \
    do { \
        g_test_fail_count = 0; \
        std::cout << "  " << #fn << "..."; \
        fn(); \
        if (g_test_fail_count == 0) \
            std::cout << " PASS\n"; \
        else \
            std::cout << "\n  => " << g_test_fail_count << " check(s) failed\n"; \
    } while(0)

// SUITE: print a section header
#define SUITE(name) \
    std::cout << "\n[" << (name) << "]\n"
