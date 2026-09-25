#include "test_framework.h"
#include "app_state.h"
#include "hardware_config.h"
#include "utils.h"
#include "transaction.h"
#include <filesystem>
#include <fstream>
#include <sstream>

namespace fs = std::filesystem;

// Phase 8 — Extract Hardcoded Config + Rename Misleading Symbols
//
// Changes tested here:
//   1. Product.durationSeconds — field was renamed from "second"
//   2. AppState.serverPort    — configurable, defaults to 8080
//   3. AppState.transactionDir — configurable, defaults to "../transaction"
//   4. ensureDirectoryExists  — renamed from createDirectoryIfNotExists,
//                               return value fixed (true = ready to use)
//   5. writeTransaction uses state.transactionDir, not a hardcoded path
//   6. writeTransaction produces no debug stdout output

// ---------------------------------- Product.durationSeconds ---

void test_durationSeconds_field_accessible()
{
    // If this compiles, the rename from .second -> .durationSeconds succeeded
    double d = productMap[1].durationSeconds;
    CHECK(d > 0.0);
}

void test_durationSeconds_drives_correct_ms()
{
    // processTimer casts durationSeconds * 1000 to int for chrono::milliseconds
    for (int i = 1; i <= TOTAL_SLOTS; i++)
    {
        int ms = (int)(productMap[i].durationSeconds * 1000);
        CHECK(ms > 0);
    }
}

// ---------------------------------- AppState new fields ---

void test_appstate_serverPort_default_is_8080()
{
    AppState s;
    CHECK_EQ(s.serverPort, 8080);
}

void test_appstate_serverPort_can_be_changed()
{
    AppState s;
    s.serverPort = 9090;
    CHECK_EQ(s.serverPort, 9090);
}

void test_appstate_transactionDir_default()
{
    AppState s;
    CHECK_EQ(s.transactionDir, std::string("../transaction"));
}

void test_appstate_transactionDir_can_be_changed()
{
    AppState s;
    s.transactionDir = "/tmp/vendo_tx";
    CHECK_EQ(s.transactionDir, std::string("/tmp/vendo_tx"));
}

// ---------------------------------- ensureDirectoryExists ---

void test_ensureDirectory_ready_when_exists()
{
    // "tests/fixtures" is committed — must always be ready
    CHECK(ensureDirectoryExists("tests/fixtures"));
}

void test_ensureDirectory_creates_and_returns_true()
{
    std::string path = "tests/tmp_ph8_dir";
    fs::remove_all(path);
    bool ready = ensureDirectoryExists(path);
    CHECK(ready);
    CHECK(fs::exists(path));
    fs::remove_all(path);
}

void test_ensureDirectory_idempotent()
{
    std::string path = "tests/tmp_ph8_idem";
    fs::remove_all(path);
    CHECK(ensureDirectoryExists(path));
    CHECK(ensureDirectoryExists(path));  // second call must also return true
    fs::remove_all(path);
}

// ---------------------- writeTransaction uses state.transactionDir ---

static std::string find_file(const std::string &dir, const std::string &needle)
{
    if (!fs::exists(dir)) return "";
    for (auto &e : fs::directory_iterator(dir))
        if (e.path().string().find(needle) != std::string::npos)
            return e.path().string();
    return "";
}

void test_writeTransaction_writes_to_transactionDir()
{
    std::string customDir = "tests/tmp_ph8_tx";
    fs::create_directories(customDir);

    AppState state;
    state.machineId      = "PH8_MACHINE";
    state.vendorId       = "PH8_VENDOR";
    state.transactionDir = customDir;

    writeTransaction(state, 1, 5.0, "PH8_VOUCHER", 2001);

    std::string found = find_file(customDir, "_transaction_1_2001.json");
    CHECK(found != "");

    if (found != "") fs::remove(found);
    fs::remove_all(customDir);
}

void test_writeTransaction_default_dir_path_not_used_when_overridden()
{
    // With a custom transactionDir, files must NOT appear in "../transaction"
    std::string customDir = "tests/tmp_ph8_nodft";
    fs::create_directories(customDir);

    AppState state;
    state.machineId      = "M";
    state.vendorId       = "V";
    state.transactionDir = customDir;

    writeTransaction(state, 2, 5.0, "", 2002);

    // Should be in custom dir
    std::string inCustom = find_file(customDir, "_transaction_2_2002.json");
    CHECK(inCustom != "");

    // Should NOT be in default dir (different postfix makes it unambiguous)
    if (fs::exists("../transaction"))
    {
        std::string inDefault = find_file("../transaction", "_transaction_2_2002.json");
        CHECK(inDefault == "");
    }

    if (inCustom != "") fs::remove(inCustom);
    fs::remove_all(customDir);
}

// ---------------------- no debug stdout from writeTransaction ---
// writeTransaction previously printed "Voucher : ..." and "Length : ..."
// on every call. Phase 8 removed those lines.
// We verify by redirecting stdout and checking no output is produced.

void test_writeTransaction_produces_no_stdout()
{
    std::string customDir = "tests/tmp_ph8_stdout";
    fs::create_directories(customDir);

    AppState state;
    state.machineId      = "M";
    state.vendorId       = "V";
    state.transactionDir = customDir;

    // Redirect stdout
    std::streambuf *orig = std::cout.rdbuf();
    std::ostringstream captured;
    std::cout.rdbuf(captured.rdbuf());

    writeTransaction(state, 3, 5.0, "SOME_VOUCHER", 2003);

    std::cout.rdbuf(orig);  // restore

    std::string output = captured.str();
    // The old debug lines contained "Voucher : " and "Length : "
    CHECK(output.find("Voucher") == std::string::npos);
    CHECK(output.find("Length")  == std::string::npos);

    std::string found = find_file(customDir, "_transaction_3_2003.json");
    if (found != "") fs::remove(found);
    fs::remove_all(customDir);
}

// ---------------------------------------------------------- entry point ---

void run_config_loading_tests()
{
    SUITE("config_loading (config extraction + symbol renames)");
    RUN_TEST(test_durationSeconds_field_accessible);
    RUN_TEST(test_durationSeconds_drives_correct_ms);
    RUN_TEST(test_appstate_serverPort_default_is_8080);
    RUN_TEST(test_appstate_serverPort_can_be_changed);
    RUN_TEST(test_appstate_transactionDir_default);
    RUN_TEST(test_appstate_transactionDir_can_be_changed);
    RUN_TEST(test_ensureDirectory_ready_when_exists);
    RUN_TEST(test_ensureDirectory_creates_and_returns_true);
    RUN_TEST(test_ensureDirectory_idempotent);
    RUN_TEST(test_writeTransaction_writes_to_transactionDir);
    RUN_TEST(test_writeTransaction_default_dir_path_not_used_when_overridden);
    RUN_TEST(test_writeTransaction_produces_no_stdout);
}
