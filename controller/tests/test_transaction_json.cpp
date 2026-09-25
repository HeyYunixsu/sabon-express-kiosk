#include "test_framework.h"
#include "transaction.h"
#include <fstream>
#include <sstream>
#include <filesystem>

namespace fs = std::filesystem;

// Phase 2 removed LCD + formatter and fixed the loop() bug so writeTransaction()
// is now actually called when a pump finishes.  These tests exercise the
// underlying JSON-writing path (writeTransactionJson) that writeTransaction
// delegates to, confirming the pipeline produces well-formed output.

// ------------------------------------------------ helper ---

static std::string read_file(const std::string &path)
{
    std::ifstream f(path);
    std::stringstream buf;
    buf << f.rdbuf();
    return buf.str();
}

// -------------------------------- writeTransactionJson ---

void test_save_json_creates_file()
{
    Transaction t;
    t.machineId  = "M1";
    t.vendorId    = "V1";
    t.voucherId   = "VOUCH001";
    t.amount      = 5.0;
    t.slot        = "1";
    t.dateCreated = "2024-01-01 12:00:00";

    std::string path = "tests/tmp_phase2_create.json";
    fs::remove(path);

    bool ok = writeTransactionJson(t, path);

    CHECK(ok);
    CHECK(fs::exists(path));

    fs::remove(path);
}

void test_save_json_all_fields_present()
{
    Transaction t;
    t.machineId  = "machine_42";
    t.vendorId    = "vendor_XYZ";
    t.voucherId   = "V999";
    t.amount      = 10.0;
    t.slot        = "3";
    t.dateCreated = "2024-06-15 08:30:00";

    std::string path = "tests/tmp_phase2_fields.json";
    writeTransactionJson(t, path);
    std::string content = read_file(path);
    fs::remove(path);

    CHECK(content.find("machine_42")         != std::string::npos);
    CHECK(content.find("vendor_XYZ")         != std::string::npos);
    CHECK(content.find("V999")               != std::string::npos);
    CHECK(content.find("\"slot\"")           != std::string::npos);
    CHECK(content.find("\"amount\"")         != std::string::npos);
    CHECK(content.find("\"date_created\"")   != std::string::npos);
    CHECK(content.find("\"machine_id\"")     != std::string::npos);
    CHECK(content.find("\"vendor_id\"")      != std::string::npos);
    CHECK(content.find("\"voucher_id\"")     != std::string::npos);
}

void test_save_json_amount_value_written()
{
    Transaction t;
    t.machineId = "M"; t.vendorId = "V"; t.voucherId = "";
    t.amount = 15.5; t.slot = "2"; t.dateCreated = "2024-01-01 00:00:00";

    std::string path = "tests/tmp_phase2_amount.json";
    writeTransactionJson(t, path);
    std::string content = read_file(path);
    fs::remove(path);

    CHECK(content.find("15.5") != std::string::npos);
}

void test_save_json_returns_false_for_bad_path()
{
    Transaction t;
    t.machineId = "x"; t.vendorId = "x"; t.amount = 0; t.slot = "1";

    bool ok = writeTransactionJson(t, "/no_such_dir/bad.json");

    CHECK(!ok);
}

void test_save_json_overwrites_existing_file()
{
    std::string path = "tests/tmp_phase2_overwrite.json";

    Transaction t1;
    t1.machineId = "FIRST"; t1.vendorId = "V"; t1.voucherId = "";
    t1.amount = 1.0; t1.slot = "1"; t1.dateCreated = "2024-01-01 00:00:00";
    writeTransactionJson(t1, path);

    Transaction t2;
    t2.machineId = "SECOND"; t2.vendorId = "V"; t2.voucherId = "";
    t2.amount = 2.0; t2.slot = "1"; t2.dateCreated = "2024-01-01 00:00:00";
    writeTransactionJson(t2, path);

    std::string content = read_file(path);
    fs::remove(path);

    CHECK(content.find("SECOND") != std::string::npos);
    CHECK(content.find("FIRST")  == std::string::npos);
}

// ---------------------------------------------------------- entry point ---

void run_transaction_json_tests()
{
    SUITE("transaction_json (transaction JSON saving)");
    RUN_TEST(test_save_json_creates_file);
    RUN_TEST(test_save_json_all_fields_present);
    RUN_TEST(test_save_json_amount_value_written);
    RUN_TEST(test_save_json_returns_false_for_bad_path);
    RUN_TEST(test_save_json_overwrites_existing_file);
}
