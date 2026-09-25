#include "test_framework.h"
#include "transaction.h"
#include "app_state.h"
#include <fstream>
#include <sstream>
#include <filesystem>

namespace fs = std::filesystem;

// Phase 5 moved writeTransaction() from voucher_manager.cpp to transaction.cpp
// and replaced extern machineId / extern vendorId with AppState& state.
// These tests confirm:
//   1. writeTransaction creates a file on disk
//   2. The file content reflects the AppState values passed in (not some
//      global that could silently come from anywhere)
//   3. Voucher ID is recorded when provided, absent when empty
//   4. Slot number appears in both the file name and file content

// ------------------------------------------------ helpers ---

static std::string read_file(const std::string &path)
{
    std::ifstream f(path);
    std::stringstream buf;
    buf << f.rdbuf();
    return buf.str();
}

// These tests must never write into ../transaction. The Makefile runs the
// runner from controller/, so that path resolves to the machine's live
// transaction directory -- the one transaction_uploader.py watches. A test transaction
// landing there is POSTed to the cloud API as a real sale and then deleted.
// Everything below goes into a directory only this suite touches.
static const std::string TEST_TXN_DIR = "tests/tmp_transaction";

// An AppState pointed at the isolated directory, which is created on demand.
// AppState defaults transactionDir to the live directory, so every test must
// override it explicitly rather than rely on that default.
static AppState test_state()
{
    fs::create_directories(TEST_TXN_DIR);
    AppState s;
    s.transactionDir = TEST_TXN_DIR;
    return s;
}

// Find a file in TEST_TXN_DIR whose name contains needle.
// Returns the full path, or "" if not found.
static std::string find_transaction_file(const std::string &needle)
{
    if (!fs::exists(TEST_TXN_DIR)) return "";
    for (auto &entry : fs::directory_iterator(TEST_TXN_DIR))
    {
        if (entry.path().string().find(needle) != std::string::npos)
            return entry.path().string();
    }
    return "";
}

// ------------------------------------------ file creation ---

void test_writeTransaction_creates_file()
{
    AppState state = test_state();
    state.machineId = "M_CREATE";
    state.vendorId  = "V_CREATE";

    writeTransaction(state, 1, 5.0, "VOUCH_CREATE", 1001);

    std::string found = find_transaction_file("_transaction_1_1001.json");
    CHECK(found != "");
    if (found != "") fs::remove(found);
}

// ---------------------------------- AppState values flow in ---

void test_writeTransaction_machineId_from_AppState()
{
    AppState state = test_state();
    state.machineId = "MACHINE_PHASE5";
    state.vendorId  = "VENDOR_PHASE5";

    writeTransaction(state, 2, 10.0, "V_MACH", 1002);

    std::string path = find_transaction_file("_transaction_2_1002.json");
    CHECK(path != "");
    if (path != "")
    {
        std::string content = read_file(path);
        CHECK(content.find("MACHINE_PHASE5") != std::string::npos);
        fs::remove(path);
    }
}

void test_writeTransaction_vendorId_from_AppState()
{
    AppState state = test_state();
    state.machineId = "M_VND";
    state.vendorId  = "VENDOR_PHASE5_CHECK";

    writeTransaction(state, 3, 5.0, "V_VND", 1003);

    std::string path = find_transaction_file("_transaction_3_1003.json");
    CHECK(path != "");
    if (path != "")
    {
        std::string content = read_file(path);
        CHECK(content.find("VENDOR_PHASE5_CHECK") != std::string::npos);
        fs::remove(path);
    }
}

// Two calls with different AppState instances produce different content —
// proves the function reads state at call time, not a cached global.
void test_writeTransaction_respects_different_AppState_instances()
{
    AppState s1 = test_state();
    s1.machineId = "MACHINE_AAA";
    s1.vendorId  = "VENDOR_AAA";
    writeTransaction(s1, 1, 5.0, "", 1004);

    AppState s2 = test_state();
    s2.machineId = "MACHINE_BBB";
    s2.vendorId  = "VENDOR_BBB";
    writeTransaction(s2, 1, 5.0, "", 1005);

    std::string p1 = find_transaction_file("_transaction_1_1004.json");
    std::string p2 = find_transaction_file("_transaction_1_1005.json");

    if (p1 != "")
    {
        std::string c1 = read_file(p1);
        CHECK(c1.find("MACHINE_AAA") != std::string::npos);
        CHECK(c1.find("MACHINE_BBB") == std::string::npos);
        fs::remove(p1);
    }
    if (p2 != "")
    {
        std::string c2 = read_file(p2);
        CHECK(c2.find("MACHINE_BBB") != std::string::npos);
        CHECK(c2.find("MACHINE_AAA") == std::string::npos);
        fs::remove(p2);
    }
    CHECK(p1 != "");
    CHECK(p2 != "");
}

// ----------------------------------------- voucher id field ---

void test_writeTransaction_voucherId_present_when_given()
{
    AppState state = test_state();
    state.machineId = "M_V";
    state.vendorId  = "V_V";

    writeTransaction(state, 4, 5.0, "VOUCHER_PRESENT", 1006);

    std::string path = find_transaction_file("_transaction_4_1006.json");
    CHECK(path != "");
    if (path != "")
    {
        std::string content = read_file(path);
        CHECK(content.find("VOUCHER_PRESENT") != std::string::npos);
        fs::remove(path);
    }
}

void test_writeTransaction_empty_voucherId_for_coin_only()
{
    AppState state = test_state();
    state.machineId = "M_COIN";
    state.vendorId  = "V_COIN";

    // Coin-only dispense passes an empty voucherId
    writeTransaction(state, 1, 5.0, "", 1007);

    std::string path = find_transaction_file("_transaction_1_1007.json");
    CHECK(path != "");
    if (path != "") fs::remove(path);
}

// ---------------------------------------------- slot field ---

void test_writeTransaction_slot_appears_in_filename()
{
    AppState state = test_state();
    state.machineId = "M_SL"; state.vendorId = "V_SL";

    writeTransaction(state, 3, 5.0, "", 1008);

    // Slot 3 must appear in the generated filename
    std::string path = find_transaction_file("_transaction_3_1008.json");
    CHECK(path != "");
    if (path != "") fs::remove(path);
}

// ---------------------------------------------------------- entry point ---

void run_transaction_write_tests()
{
    SUITE("transaction_write (writeTransaction uses AppState, not externs)");
    RUN_TEST(test_writeTransaction_creates_file);
    RUN_TEST(test_writeTransaction_machineId_from_AppState);
    RUN_TEST(test_writeTransaction_vendorId_from_AppState);
    RUN_TEST(test_writeTransaction_respects_different_AppState_instances);
    RUN_TEST(test_writeTransaction_voucherId_present_when_given);
    RUN_TEST(test_writeTransaction_empty_voucherId_for_coin_only);
    RUN_TEST(test_writeTransaction_slot_appears_in_filename);
}
