#include "test_framework.h"
#include "pump_control.h"
#include "hardware_config.h"
#include "app_state.h"
#include <wiringPi.h>
#include <chrono>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>

namespace fs = std::filesystem;

// DISPENSE / PAUSE / RESUME — starting a pour without a button, and holding it.
//
// The kiosk has no buttons, so a granted press needs a command to turn it into
// a pour. Pause exists because the customer holds their own bottle.
//
// The test that matters most here is the freeze. Setting isPaused on its own
// does not work: remainingTime is recomputed from the wall clock every tick, so
// it drains to zero while the relay is off, and the completion branch is
// guarded by isPumping -- which the pause cleared. Nothing is recorded, the
// pour is abandoned, and the jam timeout later refunds the press. The customer
// keeps what poured AND gets the credit back.
//
// So these tests care about two things above the rest:
//
//   1. A paused pour does not lose the measure that was paid for.
//   2. A paused pour is never silently abandoned -- it either finishes on
//      resume, or is ended and recorded at the pause limit. Never neither.

// ------------------------------------------------ helpers ---

// Never point these at ../transaction. The runner starts in controller/, so
// that path is the machine's live directory -- anything landing there is
// POSTed to the cloud as a real sale.
static const std::string TEST_DIR     = "tests/tmp_dispense";
static const std::string TEST_TXN_DIR = TEST_DIR + "/transaction";
static const std::string TEST_INT_LOG = TEST_DIR + "/interrupted_sales.jsonl";

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

static int count_lines(const std::string &path)
{
    std::ifstream f(path);
    if (!f) return 0;
    int n = 0;
    std::string line;
    while (std::getline(f, line))
        if (!line.empty()) n++;
    return n;
}

static std::string read_file(const std::string &path)
{
    std::ifstream f(path);
    std::stringstream buf;
    buf << f.rdbuf();
    return buf.str();
}

static AppState fresh_state()
{
    fs::remove_all(TEST_DIR);
    fs::create_directories(TEST_TXN_DIR);

    init_hardware_config({});
    pump_reset_state();

    AppState s;
    s.machineId          = "23";
    s.transactionDir     = TEST_TXN_DIR;
    s.interruptedLogPath = TEST_INT_LOG;
    return s;
}

// Spin the pump loop for a wall-clock span. The loop is driven by
// steady_clock, as it is in production, so time in these tests is real.
static void spin_for_ms(AppState &s, int ms)
{
    const auto deadline = std::chrono::steady_clock::now()
                        + std::chrono::milliseconds(ms);
    while (std::chrono::steady_clock::now() < deadline)
        pump_loop(s);
}

// Slot 3 pours for 1.25s by default -- the shortest of the six, which keeps
// these tests quick while still exercising a real pour end to end.
static const int SLOT = 3;
static int pour_ms() { return (int)(productMap[SLOT].durationSeconds * 1000); }

// ------------------------------------------------ tests ---

static void test_dispense_requires_armed_credit()
{
    // The whole point of the credit system: a command must not be able to
    // manufacture product that nobody paid for.
    AppState s = fresh_state();

    CHECK(pump_dispense(s, SLOT) == DispenseResult::NO_CREDIT);
    CHECK_EQ(s.slotBusy[SLOT], false);
    CHECK_EQ(count_transactions(TEST_TXN_DIR), 0);
}

static void test_dispense_consumes_exactly_one_unit()
{
    // One command, one press -- exactly what one finger on a button does.
    AppState s = fresh_state();
    s.armedQty[SLOT] = 3;

    CHECK(pump_dispense(s, SLOT) == DispenseResult::OK);
    CHECK_EQ(s.armedQty[SLOT], 2);
    CHECK_EQ(s.slotBusy[SLOT], true);
}

static void test_pause_freezes_the_remainder()
{
    // THE regression test. Without the freeze, remainingTime is still measured
    // against the wall clock while the relay is off, so the paid-for measure
    // drains away during the pause and the pour is abandoned with no record.
    AppState s = fresh_state();
    s.armedQty[SLOT] = 1;

    CHECK(pump_dispense(s, SLOT) == DispenseResult::OK);
    spin_for_ms(s, 200);                       // let some of it actually pour
    CHECK(pump_pause(s, SLOT) == PauseResult::OK);

    const long long frozen = s.remainingTime[SLOT];
    CHECK(frozen > 0);                         // there is a measure left to protect

    // Wait out more than the whole pour. A wall-clock countdown would be long
    // past zero by now.
    spin_for_ms(s, pour_ms() + 500);

    // The remainder is still there, within a tick or two of where it froze.
    CHECK(s.remainingTime[SLOT] > 0);
    CHECK(std::llabs(s.remainingTime[SLOT] - frozen) < 100);

    // And the pour was not quietly abandoned: still open, still nothing booked.
    CHECK_EQ(s.slotBusy[SLOT], true);
    CHECK_EQ(count_transactions(TEST_TXN_DIR), 0);
}

static void test_resume_finishes_the_paid_measure()
{
    // The customer gets what they paid for, not what was left when they
    // stopped to reposition their bottle.
    AppState s = fresh_state();
    s.armedQty[SLOT] = 1;

    CHECK(pump_dispense(s, SLOT) == DispenseResult::OK);
    spin_for_ms(s, 200);
    CHECK(pump_pause(s, SLOT) == PauseResult::OK);

    const long long frozen = s.remainingTime[SLOT];
    spin_for_ms(s, 600);                        // held, nothing pouring
    CHECK(pump_resume(s, SLOT) == ResumeResult::OK);

    // Still not finished: the frozen remainder has to run before it can be.
    CHECK(s.remainingTime[SLOT] > 0);

    spin_for_ms(s, (int)frozen + 400);

    CHECK_EQ(s.slotBusy[SLOT], false);
    CHECK_EQ(count_transactions(TEST_TXN_DIR), 1);   // one press, one sale
    CHECK_EQ(count_lines(TEST_INT_LOG), 0);          // a clean finish, not an interruption
}

static void test_pause_timeout_records_and_keeps_the_rest()
{
    // A customer who walks away mid-pour must not hold the nozzle forever, and
    // must not get free product either. The consumed press is charged in full
    // -- that is what they were charged -- and the presses never started stay
    // as credit.
    AppState s = fresh_state();
    s.armedQty[SLOT]  = 3;
    s.pauseMaxSeconds = 1;     // 120 in production; a test cannot wait that

    CHECK(pump_dispense(s, SLOT) == DispenseResult::OK);
    CHECK_EQ(s.armedQty[SLOT], 2);
    spin_for_ms(s, 200);
    CHECK(pump_pause(s, SLOT) == PauseResult::OK);

    spin_for_ms(s, 1400);        // past the limit

    CHECK_EQ(s.slotBusy[SLOT], false);                // slot returned to service
    CHECK_EQ(count_transactions(TEST_TXN_DIR), 1);    // the consumed press, recorded
    CHECK_EQ(count_lines(TEST_INT_LOG), 1);           // and surfaced for a person
    CHECK_EQ(s.armedQty[SLOT], 2);                    // the rest is still credit

    // Full price, and named so staff can tell it from a dry tank.
    const std::string row = read_file(TEST_INT_LOG);
    CHECK(row.find("\"reason\":\"pause_timeout\"") != std::string::npos);
}

static void test_a_paused_pour_is_never_refunded_as_credit()
{
    // The free-product hole. A pour abandoned during a pause used to sit until
    // the jam timeout refunded its press, so the customer kept the product that
    // had already poured and got the credit back too.
    //
    // The pause limit now closes the pour long before the jam deadline, so the
    // press is either recorded or still in flight -- never handed back.
    AppState s = fresh_state();
    s.armedQty[SLOT]  = 1;
    s.pauseMaxSeconds = 1;

    CHECK(pump_dispense(s, SLOT) == DispenseResult::OK);
    CHECK_EQ(s.armedQty[SLOT], 0);      // consumed
    spin_for_ms(s, 200);
    CHECK(pump_pause(s, SLOT) == PauseResult::OK);
    spin_for_ms(s, 1400);

    // Never refunded into armedQty, and the sale exists.
    CHECK_EQ(s.armedQty[SLOT], 0);
    CHECK_EQ(count_transactions(TEST_TXN_DIR), 1);
}

static void test_paused_total_accumulates_across_cycles()
{
    // Measured per pour, not per pause. Reset on each resume, a customer
    // tapping resume every two minutes would hold the slot indefinitely and
    // the limit would be decorative.
    AppState s = fresh_state();
    s.armedQty[SLOT]  = 1;
    s.pauseMaxSeconds = 1;

    CHECK(pump_dispense(s, SLOT) == DispenseResult::OK);

    // Three pauses of ~400ms each, resumed in between. No single pause reaches
    // the 1s limit; together they pass it.
    for (int i = 0; i < 3; i++) {
        if (!s.slotBusy[SLOT]) break;
        CHECK(pump_pause(s, SLOT) == PauseResult::OK);
        spin_for_ms(s, 400);
        if (s.slotBusy[SLOT]) pump_resume(s, SLOT);
        spin_for_ms(s, 20);
    }
    spin_for_ms(s, 300);

    // Ended by the accumulated total, and recorded either way -- what must
    // never happen is the slot still being held.
    CHECK_EQ(s.slotBusy[SLOT], false);
    CHECK_EQ(count_transactions(TEST_TXN_DIR), 1);
}

static void test_dispense_on_a_paused_slot_is_refused()
{
    // Refused rather than treated as a resume: a client that has lost track of
    // the slot would otherwise restart a pour under a customer who is not
    // holding their bottle under the nozzle.
    AppState s = fresh_state();
    s.armedQty[SLOT] = 2;

    CHECK(pump_dispense(s, SLOT) == DispenseResult::OK);
    spin_for_ms(s, 100);
    CHECK(pump_pause(s, SLOT) == PauseResult::OK);

    const int before = s.armedQty[SLOT];
    CHECK(pump_dispense(s, SLOT) == DispenseResult::SLOT_PAUSED);
    CHECK_EQ(s.armedQty[SLOT], before);      // no unit consumed by the refusal
}

static void test_machine_pause_is_distinct_from_a_slot_pause()
{
    // Two different things that both used to be called "paused". A kiosk has
    // to tell them apart: one is staff holding the machine, the other is the
    // customer holding their own pour.
    AppState s = fresh_state();
    s.armedQty[SLOT] = 1;
    s.paused = true;

    CHECK(pump_dispense(s, SLOT) == DispenseResult::MACHINE_PAUSED);
    CHECK_EQ(s.armedQty[SLOT], 1);           // not consumed
}

static void test_pause_and_resume_refuse_when_there_is_nothing_to_hold()
{
    AppState s = fresh_state();

    // Nothing pouring.
    CHECK(pump_pause(s, SLOT) == PauseResult::NOT_POURING);
    CHECK(pump_resume(s, SLOT) == ResumeResult::NOT_PAUSED);

    // A prime is a staff burst, not a customer's pour, so there is nothing to
    // hold there either.
    CHECK(pump_start_prime(s, SLOT) == PrimeResult::STARTED);
    CHECK(pump_pause(s, SLOT) == PauseResult::NOT_POURING);
}

static void test_pausing_twice_is_reported_not_silently_accepted()
{
    AppState s = fresh_state();
    s.armedQty[SLOT] = 1;

    CHECK(pump_dispense(s, SLOT) == DispenseResult::OK);
    CHECK(pump_pause(s, SLOT) == PauseResult::OK);
    CHECK(pump_pause(s, SLOT) == PauseResult::ALREADY_PAUSED);
}

static void test_slots_off_the_machine_are_rejected()
{
    AppState s = fresh_state();

    for (int bad : {0, -1, TOTAL_SLOTS + 1, 99}) {
        CHECK(pump_dispense(s, bad) == DispenseResult::SLOT_INVALID);
        CHECK(pump_pause(s, bad)    == PauseResult::SLOT_INVALID);
        CHECK(pump_resume(s, bad)   == ResumeResult::SLOT_INVALID);
    }
}

static void test_pause_limit_is_bounded()
{
    // An unbounded limit is a nozzle held open all day; too small a one stops a
    // customer swapping a bottle.
    CHECK_EQ(clamp_pause_max("120"), 120);
    CHECK_EQ(clamp_pause_max("5"), 15);        // below the floor
    CHECK_EQ(clamp_pause_max("9000"), 600);    // above the ceiling
    CHECK_EQ(clamp_pause_max("banana"), 120);  // unparseable falls back
    CHECK_EQ(clamp_pause_max(""), 120);
}

static void test_every_result_has_a_distinct_label()
{
    // The ack token is what the kiosk shows a customer. Two results sharing a
    // label means a screen that cannot say what went wrong.
    const DispenseResult dispense[] = {
        DispenseResult::OK, DispenseResult::SLOT_INVALID, DispenseResult::NO_CREDIT,
        DispenseResult::SLOT_EMPTY, DispenseResult::MAX_ACTIVE, DispenseResult::PRIMING,
        DispenseResult::MACHINE_PAUSED, DispenseResult::SLOT_PAUSED,
        DispenseResult::COOLDOWN,
    };
    const size_t n = sizeof(dispense) / sizeof(dispense[0]);
    for (size_t i = 0; i < n; i++) {
        CHECK(std::string(dispense_result_text(dispense[i])) != "unknown");
        for (size_t j = i + 1; j < n; j++)
            CHECK(std::string(dispense_result_text(dispense[i]))
               != std::string(dispense_result_text(dispense[j])));
    }

    // The two kinds of paused must never collapse into one token.
    CHECK(std::string(dispense_result_text(DispenseResult::MACHINE_PAUSED))
       != std::string(dispense_result_text(DispenseResult::SLOT_PAUSED)));

    CHECK(std::string(pause_result_text(PauseResult::OK)) == "ok");
    CHECK(std::string(pause_result_text(PauseResult::NOT_POURING)) == "not_pouring");
    CHECK(std::string(pause_result_text(PauseResult::ALREADY_PAUSED)) == "already_paused");
    CHECK(std::string(resume_result_text(ResumeResult::NOT_PAUSED)) == "not_paused");
}

// ------------------------------------------------ suite ---

void run_dispense_command_tests()
{
    SUITE("Dispense / pause / resume (no-button pours)");

    RUN_TEST(test_dispense_requires_armed_credit);
    RUN_TEST(test_dispense_consumes_exactly_one_unit);
    RUN_TEST(test_pause_freezes_the_remainder);
    RUN_TEST(test_resume_finishes_the_paid_measure);
    RUN_TEST(test_pause_timeout_records_and_keeps_the_rest);
    RUN_TEST(test_a_paused_pour_is_never_refunded_as_credit);
    RUN_TEST(test_paused_total_accumulates_across_cycles);
    RUN_TEST(test_dispense_on_a_paused_slot_is_refused);
    RUN_TEST(test_machine_pause_is_distinct_from_a_slot_pause);
    RUN_TEST(test_pause_and_resume_refuse_when_there_is_nothing_to_hold);
    RUN_TEST(test_pausing_twice_is_reported_not_silently_accepted);
    RUN_TEST(test_slots_off_the_machine_are_rejected);
    RUN_TEST(test_pause_limit_is_bounded);
    RUN_TEST(test_every_result_has_a_distinct_label);

    // Hand the next suite a clean machine. pumps[] is module state shared by
    // every suite, and the integration tests that follow do not reset it --
    // they only reset their own log. A pour left open here keeps a slot busy
    // and its press reserved, so ARM there would queue instead of arming and
    // the jam timeout would refund a press into their armedQty.
    pump_reset_state();
}
