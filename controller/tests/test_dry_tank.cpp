#include "test_framework.h"
#include "pump_control.h"
#include "hardware_config.h"
#include "app_state.h"
#include <wiringPi.h>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>
#include <thread>

namespace fs = std::filesystem;

// A tank running dry part-way through a customer's pour.
//
// Before this, the empty branch switched the relay off and logged. Everything
// else stayed as it was: no sale recorded, the slot held busy until a refill,
// and then the completion branch booked the full amount dated to the refill --
// or the sale vanished entirely if the controller restarted first.
//
// All three outcomes leave the drawer short with nothing to explain it, and it
// is the honest cashier who carries the difference. Policy, chosen by the owner
// on 2026-09-04: record the full price, because that is what the customer was
// charged, and surface the partial pour separately for a person to settle.

// ------------------------------------------------ helpers ---

static const std::string TEST_DIR     = "tests/tmp_drytank";
static const std::string TEST_TXN_DIR = TEST_DIR + "/transaction";
static const std::string TEST_LOG     = TEST_DIR + "/interrupted.jsonl";

static int count_transactions(const std::string &dir)
{
    if (!fs::exists(dir)) return 0;
    int n = 0;
    for (const auto &e : fs::directory_iterator(dir)) {
        if (!e.is_regular_file()) continue;
        if (e.path().filename() == "state.dat") continue;   // not a sale
        n++;
    }
    return n;
}

static std::string read_all(const std::string &path)
{
    std::ifstream f(path);
    std::stringstream buf;
    buf << f.rdbuf();
    return buf.str();
}

static std::string read_transactions(const std::string &dir)
{
    std::string all;
    if (!fs::exists(dir)) return all;
    for (const auto &e : fs::directory_iterator(dir)) {
        if (!e.is_regular_file()) continue;
        if (e.path().filename() == "state.dat") continue;
        all += read_all(e.path().string());
    }
    return all;
}

static int count_lines(const std::string &path)
{
    std::ifstream f(path);
    int n = 0;
    std::string line;
    while (std::getline(f, line))
        if (!line.empty()) n++;
    return n;
}

static AppState fresh_state()
{
    fs::remove_all(TEST_DIR);
    fs::create_directories(TEST_TXN_DIR);

    init_hardware_config({{"PRICE2", "20"}, {"PRICE4", "25"},
                          {"calibrateProduct2", "(20, 4.0)"},
                          {"calibrateProduct4", "(25, 4.0)"}});
    pump_reset_state();

    AppState s;
    s.machineId           = "23";
    s.transactionDir      = TEST_TXN_DIR;
    s.interruptedLogPath  = TEST_LOG;
    return s;
}

// Drive a real customer press: hold the button until the debounce window
// fills and the edge fires, then release it as a finger would.
static void start_dispense(AppState &s, int slot)
{
    s.armedQty[slot] = 1;
    mock_set_button(pin_button[slot], true);
    // Held until the press lands rather than for a fixed number of loops: a
    // press on an idle pump must be held BUTTON_HOLD_MS, and how many loops
    // that takes depends on the machine running the tests.
    auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(1500);
    while (s.armedQty[slot] > 0 && std::chrono::steady_clock::now() < deadline) pump_loop(s);
    mock_release_all_buttons();
    pump_loop(s);
}

// ------------------------------------------------ tests ---

static void test_a_press_actually_starts_a_dispense()
{
    // Guards the tests below: if the press never lands they would all pass
    // by doing nothing at all.
    AppState s = fresh_state();
    start_dispense(s, 2);

    CHECK_EQ(s.armedQty[2], 0);
    CHECK_EQ(s.slotBusy[2], true);
    CHECK(s.remainingTime[2] > 0);
    CHECK_EQ(count_transactions(TEST_TXN_DIR), 0);   // not finished yet
}

static void test_dry_tank_records_the_sale_at_full_price()
{
    AppState s = fresh_state();
    start_dispense(s, 2);

    s.slotEmpty[2] = true;      // the gallon runs out mid-pour
    pump_loop(s);

    CHECK_EQ(count_transactions(TEST_TXN_DIR), 1);

    // Full price: the customer paid 20, so 20 is what the cloud is told.
    const std::string txn = read_transactions(TEST_TXN_DIR);
    CHECK(txn.find("\"amount\": 20") != std::string::npos);
    CHECK(txn.find("\"slot\": \"2\"") != std::string::npos);
}

static void test_the_line_goes_back_into_service()
{
    // The old behaviour held slotBusy forever, so the slot refused every
    // later sale until the controller was restarted.
    AppState s = fresh_state();
    start_dispense(s, 2);

    s.slotEmpty[2] = true;
    pump_loop(s);

    CHECK_EQ(s.slotBusy[2], false);

    // remainingTime is computed at the top of pump_loop, before handlePump
    // zeroes the timer, so it settles on the following tick.
    pump_loop(s);
    CHECK_EQ(s.remainingTime[2], 0);
}

static void test_refilling_does_not_book_the_sale_twice()
{
    // The trap in the old code: remainingTime kept counting while the tank was
    // empty, so a refill dropped straight into the completion branch and wrote
    // the same sale again.
    AppState s = fresh_state();
    start_dispense(s, 2);

    s.slotEmpty[2] = true;
    pump_loop(s);
    CHECK_EQ(count_transactions(TEST_TXN_DIR), 1);

    s.slotEmpty[2] = false;                      // staff refill the gallon
    for (int i = 0; i < 10; i++) pump_loop(s);

    CHECK_EQ(count_transactions(TEST_TXN_DIR), 1);
}

static void test_the_partial_pour_is_flagged_for_a_person()
{
    AppState s = fresh_state();
    start_dispense(s, 4);

    s.slotEmpty[4] = true;
    pump_loop(s);

    CHECK_EQ(count_lines(TEST_LOG), 1);

    const std::string body = read_all(TEST_LOG);
    CHECK(body.find("\"slot\":\"4\"") != std::string::npos);
    CHECK(body.find("\"amount\":25") != std::string::npos);
    CHECK(body.find("\"reason\":\"tank_empty\"") != std::string::npos);
    CHECK(body.find("\"date_created\"") != std::string::npos);
}

static void test_credits_queued_behind_the_dispense_are_released()
{
    // ARM queues while a slot is busy. Interrupting without draining that
    // queue would strand credits the cashier already took money for.
    AppState s = fresh_state();
    start_dispense(s, 2);
    s.pendingQueue[2].push(PendingArm(2, 3));

    s.slotEmpty[2] = true;
    pump_loop(s);

    CHECK_EQ(s.armedQty[2], 3);
    CHECK_EQ((int)s.pendingQueue[2].size(), 0);
}

static void test_an_empty_tank_with_nothing_running_records_nothing()
{
    // The common case by far: a slot sitting idle over an empty tank. It must
    // not manufacture a sale on every single loop.
    AppState s = fresh_state();
    s.slotEmpty[2] = true;

    for (int i = 0; i < 10; i++) pump_loop(s);

    CHECK_EQ(count_transactions(TEST_TXN_DIR), 0);
    CHECK_EQ(count_lines(TEST_LOG), 0);
}

static void test_one_interruption_writes_one_record()
{
    // handlePump runs every loop. Without isPumping being cleared, an empty
    // tank would book a sale on each turn until it was refilled.
    AppState s = fresh_state();
    start_dispense(s, 2);

    s.slotEmpty[2] = true;
    for (int i = 0; i < 10; i++) pump_loop(s);

    CHECK_EQ(count_transactions(TEST_TXN_DIR), 1);
    CHECK_EQ(count_lines(TEST_LOG), 1);
}

// ------------------------------------------------ suite ---

void run_dry_tank_tests()
{
    SUITE("Dry tank (interrupted sale)");

    RUN_TEST(test_a_press_actually_starts_a_dispense);
    RUN_TEST(test_dry_tank_records_the_sale_at_full_price);
    RUN_TEST(test_the_line_goes_back_into_service);
    RUN_TEST(test_refilling_does_not_book_the_sale_twice);
    RUN_TEST(test_the_partial_pour_is_flagged_for_a_person);
    RUN_TEST(test_credits_queued_behind_the_dispense_are_released);
    RUN_TEST(test_an_empty_tank_with_nothing_running_records_nothing);
    RUN_TEST(test_one_interruption_writes_one_record);

    fs::remove_all(TEST_DIR);
    init_hardware_config({});
}
