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

// Prime / purge tests.
//
// Replacing an empty gallon lets air into the hose, so a prime runs a pump
// briefly to push it out. The defining property is that a prime dispenses
// product and records NO sale -- which is also exactly what someone stealing
// from the till would want. So the tests here care about two things in equal
// measure:
//
//   1. A prime never produces a transaction file. Not even a zero-peso one:
//      the uploader sends every file in the transaction directory to the
//      cloud, so a stray record would corrupt the revenue report this feature
//      is otherwise careful not to touch.
//   2. A prime always leaves a trace in the non-revenue log. A prime that
//      vanished would make "I was only priming" an unfalsifiable excuse.
//
// Everything else is a guard: priming must not run a dry pump, must not
// interleave with a customer's dispense, and must release the slot afterwards.

// ------------------------------------------------ helpers ---

// Never point these at ../transaction. The runner starts in controller/, so
// that path is the machine's live directory -- anything landing there is
// POSTed to the cloud as a real sale.
static const std::string TEST_DIR      = "tests/tmp_prime";
static const std::string TEST_TXN_DIR  = TEST_DIR + "/transaction";
static const std::string TEST_LOG_PATH = TEST_DIR + "/prime_events.jsonl";

// Counts sales only. state.dat also lives in this directory -- an existing
// wart worth knowing about, since the uploader scans every file in there and
// chokes on that one -- so it is excluded rather than counted as a sale.
static int count_transactions(const std::string &dir)
{
    if (!fs::exists(dir)) return 0;
    int n = 0;
    for (const auto &e : fs::directory_iterator(dir)) {
        if (!e.is_regular_file()) continue;
        if (e.path().filename() == "state.dat") continue;
        n++;
    }
    return n;
}

static std::string read_file(const std::string &path)
{
    std::ifstream f(path);
    std::stringstream buf;
    buf << f.rdbuf();
    return buf.str();
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

// A clean machine: empty temp directories, pumps back to power-on state, and
// hardware maps populated so pump_loop() writes to real pin numbers.
static AppState fresh_state()
{
    fs::remove_all(TEST_DIR);
    fs::create_directories(TEST_TXN_DIR);

    init_hardware_config({});
    pump_reset_state();

    AppState s;
    s.machineId      = "23";
    s.transactionDir = TEST_TXN_DIR;
    s.primeLogPath   = TEST_LOG_PATH;
    return s;
}

// ------------------------------------------------ tests ---

static void test_prime_starts_and_reserves_the_slot()
{
    AppState s = fresh_state();

    CHECK(pump_start_prime(s, 3) == PrimeResult::STARTED);

    // slotBusy keeps a sale from being armed into the middle of the burst.
    CHECK_EQ(s.slotBusy[3], true);

    // A prime is maintenance, not a sale: it must not stage credit, and it
    // must not move the transaction state machine.
    CHECK_EQ(s.armedQty[3], 0);
    CHECK(s.phase == TxnPhase::IDLE);
    CHECK_EQ(s.bundleComplete, false);
}

static void test_prime_writes_no_transaction()
{
    AppState s = fresh_state();

    CHECK_EQ(count_transactions(TEST_TXN_DIR), 0);
    CHECK(pump_start_prime(s, 1) == PrimeResult::STARTED);
    CHECK_EQ(count_transactions(TEST_TXN_DIR), 0);
}

static void test_prime_appends_a_non_revenue_record()
{
    AppState s = fresh_state();

    CHECK(pump_start_prime(s, 2) == PrimeResult::STARTED);
    CHECK(fs::exists(TEST_LOG_PATH));

    std::string body = read_file(TEST_LOG_PATH);
    CHECK(body.find("\"slot\":\"2\"") != std::string::npos);
    CHECK(body.find("\"machine_id\":\"23\"") != std::string::npos);
    CHECK(body.find("\"date_created\"") != std::string::npos);

    // No "amount" field anywhere: a prime is not revenue and must never be
    // mistaken for it by whatever reads this file later.
    CHECK(body.find("amount") == std::string::npos);
}

static void test_every_prime_is_logged_separately()
{
    AppState s = fresh_state();

    CHECK(pump_start_prime(s, 1) == PrimeResult::STARTED);
    CHECK(pump_start_prime(s, 2) == PrimeResult::STARTED);
    CHECK_EQ(count_lines(TEST_LOG_PATH), 2);

    // Refusals move no product, so they must not pad the log and make the
    // count useless for spotting a pattern.
    CHECK(pump_start_prime(s, 99) == PrimeResult::SLOT_INVALID);
    CHECK_EQ(count_lines(TEST_LOG_PATH), 2);
}

static void test_prime_rejects_slots_off_the_machine()
{
    AppState s = fresh_state();

    CHECK(pump_start_prime(s, 0)  == PrimeResult::SLOT_INVALID);
    CHECK(pump_start_prime(s, -1) == PrimeResult::SLOT_INVALID);
    CHECK(pump_start_prime(s, TOTAL_SLOTS + 1) == PrimeResult::SLOT_INVALID);
    CHECK(pump_start_prime(s, 9999) == PrimeResult::SLOT_INVALID);

    CHECK(pump_start_prime(s, 1) == PrimeResult::STARTED);
    CHECK(pump_start_prime(s, TOTAL_SLOTS) == PrimeResult::STARTED);
}

static void test_prime_refused_while_paused()
{
    AppState s = fresh_state();
    s.paused = true;

    CHECK(pump_start_prime(s, 1) == PrimeResult::MACHINE_PAUSED);
    CHECK_EQ(s.slotBusy[1], false);
}

static void test_prime_refused_on_an_empty_tank()
{
    // Priming a genuinely dry tank runs the pump against air, which is what
    // damages it. The real case is a freshly refilled gallon, where the
    // sensor already reads full.
    AppState s = fresh_state();
    s.slotEmpty[4] = true;

    CHECK(pump_start_prime(s, 4) == PrimeResult::SLOT_EMPTY);
    CHECK_EQ(s.slotBusy[4], false);
    CHECK(pump_start_prime(s, 5) == PrimeResult::STARTED);
}

static void test_prime_allowed_while_a_customer_holds_credits()
{
    // The case the feature exists for: a gallon runs out mid-sale, staff
    // replace it, and the hose now has air -- while the waiting customer still
    // holds credits on that slot. Refusing here would send them a press of air
    // and charge for it.
    AppState s = fresh_state();

    s.armedQty[1] = 2;
    CHECK(pump_start_prime(s, 1) == PrimeResult::STARTED);
    CHECK_EQ(s.armedQty[1], 2);       // their credits are not spent by priming

    // Queued credits are no obstacle either.
    AppState t = fresh_state();
    t.pendingQueue[2].push(PendingArm(2, 3));
    CHECK(pump_start_prime(t, 2) == PrimeResult::STARTED);
    CHECK_EQ((int)t.pendingQueue[2].size(), 1);
}

static void test_prime_refused_only_by_a_dispense_in_flight()
{
    // A pump actually running for a customer is the one thing that must not be
    // interrupted -- the two share pump.timer.
    AppState s = fresh_state();

    s.slotBusy[1] = true;
    CHECK(pump_start_prime(s, 1) == PrimeResult::SLOT_BUSY);
    CHECK_EQ(count_lines(TEST_LOG_PATH), 0);

    s.slotBusy[1] = false;
    CHECK(pump_start_prime(s, 1) == PrimeResult::STARTED);
}

static void test_a_press_during_a_prime_is_denied_not_given_away()
{
    // Without this the press would spend the credit, extend the prime's timer,
    // and then reach the completion branch as a prime -- which writes no
    // transaction. Product out, nothing recorded, and the customer's credit
    // gone. Denying costs them a few seconds and nothing else.
    AppState s = fresh_state();
    s.armedQty[3] = 1;

    CHECK(pump_start_prime(s, 3) == PrimeResult::STARTED);

    // Hold the button as a customer would, mid-burst.
    mock_set_button(pin_button[3], true);
    for (int i = 0; i < 8; i++) pump_loop(s);
    mock_release_all_buttons();

    CHECK_EQ(s.armedQty[3], 1);                    // credit untouched
    CHECK_EQ(count_transactions(TEST_TXN_DIR), 0); // and nothing booked
}

static void test_prime_obeys_the_two_pump_rail_limit()
{
    // Same limit dispensing uses -- the supply cannot hold three pumps.
    AppState s = fresh_state();

    CHECK(pump_start_prime(s, 1) == PrimeResult::STARTED);
    CHECK(pump_start_prime(s, 2) == PrimeResult::STARTED);
    CHECK(pump_start_prime(s, 3) == PrimeResult::TOO_MANY_ACTIVE);
    CHECK_EQ(s.slotBusy[3], false);
}

static void test_prime_releases_the_slot_when_the_tank_reads_empty()
{
    // A sensor going empty mid-burst must not strand slotBusy. Left set, the
    // line is locked out of service until the controller restarts.
    AppState s = fresh_state();

    CHECK(pump_start_prime(s, 2) == PrimeResult::STARTED);
    CHECK_EQ(s.slotBusy[2], true);

    s.slotEmpty[2] = true;
    pump_loop(s);

    CHECK_EQ(s.slotBusy[2], false);
    CHECK_EQ(count_transactions(TEST_TXN_DIR), 0);

    // Recoverable: refilling makes the slot usable again.
    s.slotEmpty[2] = false;
    CHECK(pump_start_prime(s, 2) == PrimeResult::STARTED);
}

static void test_a_completed_prime_frees_the_slot_and_books_nothing()
{
    // The whole point of the feature, so it is worth running the real burst
    // end to end rather than asserting on the branch that starts it.
    AppState s = fresh_state();

    CHECK(pump_start_prime(s, 1) == PrimeResult::STARTED);

    const auto deadline = std::chrono::steady_clock::now()
                        + std::chrono::milliseconds(
                              (int)(pump_prime_seconds() * 1000) + 3000);
    while (s.slotBusy[1] && std::chrono::steady_clock::now() < deadline)
        pump_loop(s);

    CHECK_EQ(s.slotBusy[1], false);
    CHECK_EQ(count_transactions(TEST_TXN_DIR), 0);   // no sale, ever
    CHECK_EQ(count_lines(TEST_LOG_PATH), 1);  // exactly one non-revenue record

    // And the slot is immediately usable for a real sale again.
    CHECK(pump_start_prime(s, 1) == PrimeResult::STARTED);
}

static void test_credits_queued_during_a_prime_are_released()
{
    // ARM queues instead of arming while a slot is busy, and a prime sets
    // busy. If the prime finished without draining that queue, credits the
    // cashier already took money for would sit there forever.
    AppState s = fresh_state();

    CHECK(pump_start_prime(s, 3) == PrimeResult::STARTED);
    s.pendingQueue[3].push(PendingArm(3, 2));   // what ARM does to a busy slot

    const auto deadline = std::chrono::steady_clock::now()
                        + std::chrono::milliseconds(
                              (int)(pump_prime_seconds() * 1000) + 3000);
    while (s.slotBusy[3] && std::chrono::steady_clock::now() < deadline)
        pump_loop(s);

    CHECK_EQ(s.slotBusy[3], false);
    CHECK_EQ(s.armedQty[3], 2);
    CHECK_EQ((int)s.pendingQueue[3].size(), 0);
    CHECK_EQ(count_transactions(TEST_TXN_DIR), 0);   // still no sale from the prime
}

static void test_prime_burst_is_bounded()
{
    // An unbounded burst empties a gallon onto the floor unattended.
    CHECK(pump_prime_seconds() >= 0.5);
    CHECK(pump_prime_seconds() <= 15.0);
}

static void test_every_result_has_a_distinct_label()
{
    // The dashboard shows these to staff, so a missing case would surface as
    // "unknown" and tell them nothing about what to do next.
    const PrimeResult all[] = {
        PrimeResult::STARTED,      PrimeResult::SLOT_INVALID,
        PrimeResult::SLOT_BUSY,    PrimeResult::SLOT_EMPTY,
        PrimeResult::MACHINE_PAUSED, PrimeResult::TOO_MANY_ACTIVE,
    };
    for (PrimeResult r : all) {
        std::string label = prime_result_text(r);
        CHECK(!label.empty());
        CHECK(label != "unknown");
    }
}

// ------------------------------------------------ suite ---

void run_prime_tests()
{
    SUITE("Prime / purge (non-revenue dispense)");

    RUN_TEST(test_prime_starts_and_reserves_the_slot);
    RUN_TEST(test_prime_writes_no_transaction);
    RUN_TEST(test_prime_appends_a_non_revenue_record);
    RUN_TEST(test_every_prime_is_logged_separately);
    RUN_TEST(test_prime_rejects_slots_off_the_machine);
    RUN_TEST(test_prime_refused_while_paused);
    RUN_TEST(test_prime_refused_on_an_empty_tank);
    RUN_TEST(test_prime_allowed_while_a_customer_holds_credits);
    RUN_TEST(test_prime_refused_only_by_a_dispense_in_flight);
    RUN_TEST(test_a_press_during_a_prime_is_denied_not_given_away);
    RUN_TEST(test_prime_obeys_the_two_pump_rail_limit);
    RUN_TEST(test_prime_releases_the_slot_when_the_tank_reads_empty);
    RUN_TEST(test_a_completed_prime_frees_the_slot_and_books_nothing);
    RUN_TEST(test_credits_queued_during_a_prime_are_released);
    RUN_TEST(test_prime_burst_is_bounded);
    RUN_TEST(test_every_result_has_a_distinct_label);

    fs::remove_all(TEST_DIR);
}
