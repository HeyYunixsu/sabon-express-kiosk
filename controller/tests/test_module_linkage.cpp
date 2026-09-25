#include "test_framework.h"
#include "utils.h"
#include "hardware_config.h"
#include "socket_server.h"
#include "transaction.h"
#include "app_state.h"
#include <filesystem>

namespace fs = std::filesystem;

// Phase 6 — Build System Polish (updated for cashier-dashboard model)
//
// Regression guard: confirms every compiled module exposes at least one
// callable symbol.  voucher_manager was removed — tests now validate
// armedQty/pendingQueue instead.

// ------------------------------------------ working directory layout ---

void test_cwd_has_src_directory()
{
    CHECK(fs::exists("src"));
}

void test_cwd_has_includes_directory()
{
    CHECK(fs::exists("includes"));
}

void test_cwd_has_tests_directory()
{
    CHECK(fs::exists("tests"));
}

void test_fixture_file_exists()
{
    CHECK(fs::exists("tests/fixtures/test.env"));
}

// ------------------------------------------ module linkage sentinels ---

void test_utils_module_links()
{
    CHECK_EQ(trim("  hi  "), std::string("hi"));
}

void test_hardware_module_links()
{
    CHECK_EQ((int)pin_pump.size(), TOTAL_SLOTS);
    CHECK_EQ((int)pin_led.size(), TOTAL_SLOTS);
}

void test_socket_module_links()
{
    CHECK(isFirstWordTest("ARM,1,3", "ARM"));
}

void test_transaction_module_links()
{
    Transaction t;
    t.machineId = "smoke"; t.vendorId = ""; t.voucherId = "";
    t.amount = 0; t.slot = "1"; t.dateCreated = "2024-01-01 00:00:00";
    CHECK(!writeTransactionJson(t, "/no_such_dir/smoke.json"));
}

// ------------------------------------------ armed state smoke checks ---

void test_armedQty_defaults_to_zero()
{
    AppState s;
    for (int i = 1; i <= TOTAL_SLOTS; i++)
        CHECK_EQ(s.armedQty[i], 0);
}

void test_pendingQueue_starts_empty()
{
    AppState s;
    for (int i = 1; i <= TOTAL_SLOTS; i++)
        CHECK(s.pendingQueue[i].empty());
}

void test_slotBusy_defaults_false()
{
    AppState s;
    for (int i = 1; i <= TOTAL_SLOTS; i++)
        CHECK(!s.slotBusy[i]);
}

// ---------------------------------------------------------- entry point ---

void run_module_linkage_tests()
{
    SUITE("module_linkage (build polish + armed-state smoke)");
    RUN_TEST(test_cwd_has_src_directory);
    RUN_TEST(test_cwd_has_includes_directory);
    RUN_TEST(test_cwd_has_tests_directory);
    RUN_TEST(test_fixture_file_exists);
    RUN_TEST(test_utils_module_links);
    RUN_TEST(test_hardware_module_links);
    RUN_TEST(test_socket_module_links);
    RUN_TEST(test_transaction_module_links);
    RUN_TEST(test_armedQty_defaults_to_zero);
    RUN_TEST(test_pendingQueue_starts_empty);
    RUN_TEST(test_slotBusy_defaults_false);
}
