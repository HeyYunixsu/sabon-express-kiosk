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

// Several presses on one slot before the pour finishes.
//
// Each press extends the SAME timer, so the liquid comes out as one
// continuous run -- but it is one sale per press, and the completion branch
// runs only once. It used to write a single record carrying the summed
// amount: five presses at 20 arrived as one transaction of 100.
//
// The pesos were right, which is why nothing looked broken. Every count
// derived from the records was wrong: Today's Sales on the dashboard counts
// one press per record, and so does the cloud's units-per-slot. Reported from
// the floor on 2026-09-11 -- x10 unlocked, five presses, one press shown.

// ------------------------------------------------ helpers ---

static const std::string TEST_DIR     = "tests/tmp_multipress";
static const std::string TEST_TXN_DIR = TEST_DIR + "/transaction";

// Driving a press is not instant: pump_loop paces itself against the hardware
// (~50ms a turn on a dev PC), and the first press of a pour must also be held
// BUTTON_HOLD_MS (100ms) before it lands. Two consequences, both learned the
// hard way when the first version of this file silently tested five separate
// pours:
//
//   - The 200ms press cooldown is enforced explicitly below rather than
//     trusted to that overhead, which will not hold on other hardware.
//   - Each press must add MORE run time than a press costs, or the pour ends
//     before the next press arrives. 1.0s per press against a few hundred ms
//     leaves ample headroom, and the margin grows with every press.
static const int PRESS_SECONDS = 1;
static const int PRESS_COOLDOWN_MS = 220;   // 200ms cooldown + margin

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

static std::string read_all(const fs::path &p)
{
    std::ifstream f(p);
    std::stringstream buf;
    buf << f.rdbuf();
    return buf.str();
}

// Sum the amount field across every transaction file. The records must
// account for exactly what the customer paid -- no more, no less -- however
// they end up split.
static double sum_amounts(const std::string &dir)
{
    double total = 0;
    if (!fs::exists(dir)) return total;
    for (const auto &e : fs::directory_iterator(dir)) {
        if (!e.is_regular_file()) continue;
        if (e.path().filename() == "state.dat") continue;
        const std::string body = read_all(e.path());
        const std::string key  = "\"amount\": ";
        size_t at = body.find(key);
        if (at == std::string::npos) continue;
        total += std::stod(body.substr(at + key.size()));
    }
    return total;
}

static AppState fresh_state()
{
    fs::remove_all(TEST_DIR);
    fs::create_directories(TEST_TXN_DIR);

    init_hardware_config({{"PRICE2", "20"},
                          {"calibrateProduct2", "(20, 1.0)"}});
    pump_reset_state();

    AppState s;
    s.machineId      = "23";
    s.transactionDir = TEST_TXN_DIR;
    return s;
}

// One real press: hold the button until the debounce window fills and the
// edge fires, then release it as a finger would.
static void press(AppState &s, int slot)
{
    // Held until the credit is taken, not for a fixed loop count. The first
    // press of a pour must be held BUTTON_HOLD_MS; later ones land at once.
    int before = s.armedQty[slot];
    mock_set_button(pin_button[slot], true);
    auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(1500);
    while (s.armedQty[slot] == before && std::chrono::steady_clock::now() < deadline)
        pump_loop(s);
    // Fail here, not later. Returning quietly on the deadline made a press that
    // never landed surface as a confusing transaction-count mismatch further
    // down the test, pointing at the wrong thing.
    CHECK(s.armedQty[slot] != before);
    mock_release_all_buttons();
    pump_loop(s);
}

// n presses on ONE pour. The controller's cooldown runs from when the previous
// press STARTED ITS PUMP, and press() returns just after that, so the whole
// cooldown is waited here. Timing it from when press() began broke on the Pi:
// the hold starts the pump ~200ms into a press, the Pi's faster loop put the
// next press inside the cooldown, and it was refused.
static void press_n_times(AppState &s, int slot, int n)
{
    for (int i = 0; i < n; i++) {
        if (i) std::this_thread::sleep_for(std::chrono::milliseconds(PRESS_COOLDOWN_MS));
        press(s, slot);
    }
}

// Run the loop until the pour's timer expires and the completion branch fires.
// The deadline is a stuck-test guard, not a pacing device -- a pour of n
// presses takes n seconds, so it must sit well clear of that.
static void run_until_done(AppState &s, int slot)
{
    auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(30);
    while (s.slotBusy[slot] && std::chrono::steady_clock::now() < deadline) {
        pump_loop(s);
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
    pump_loop(s);
}

// ------------------------------------------------ tests ---

static void test_five_presses_stay_one_pour()
{
    // Guards everything below. If the presses landed as five separate pours
    // the record count would come out right for the wrong reason.
    AppState s = fresh_state();
    s.armedQty[2] = 5;

    press_n_times(s, 2, 5);

    CHECK_EQ(s.armedQty[2], 0);                      // all five credits taken
    CHECK_EQ(s.slotBusy[2], true);                   // still one pour in flight
    CHECK_EQ(count_transactions(TEST_TXN_DIR), 0);   // nothing booked yet
}

static void test_five_presses_write_five_records()
{
    // The reported bug: this used to be 1 record carrying 100.
    AppState s = fresh_state();
    s.armedQty[2] = 5;

    press_n_times(s, 2, 5);
    run_until_done(s, 2);

    CHECK_EQ(count_transactions(TEST_TXN_DIR), 5);
    // The old lumped record had the total right, and splitting it must not
    // change what the customer was billed -- 5 x 20 is still 100.
    CHECK_EQ((int)sum_amounts(TEST_TXN_DIR), 100);
}

static void test_each_record_is_one_press_at_the_press_price()
{
    AppState s = fresh_state();
    s.armedQty[2] = 3;

    press_n_times(s, 2, 3);
    run_until_done(s, 2);

    CHECK_EQ(count_transactions(TEST_TXN_DIR), 3);
    // Every record carries a single press, not a share of a total.
    for (const auto &e : fs::directory_iterator(TEST_TXN_DIR)) {
        if (!e.is_regular_file()) continue;
        if (e.path().filename() == "state.dat") continue;
        const std::string body = read_all(e.path());
        CHECK(body.find("\"amount\": 20") != std::string::npos);
        CHECK(body.find("\"slot\": \"2\"") != std::string::npos);
    }
}

static void test_a_single_press_still_writes_exactly_one()
{
    // The ordinary case must not have grown an extra record.
    AppState s = fresh_state();
    s.armedQty[2] = 1;

    press_n_times(s, 2, 1);
    run_until_done(s, 2);

    CHECK_EQ(count_transactions(TEST_TXN_DIR), 1);
    CHECK_EQ((int)sum_amounts(TEST_TXN_DIR), 20);
}

static void test_a_later_pour_does_not_replay_the_earlier_presses()
{
    // The presses are held on the pump until the pour completes. If that list
    // is not cleared, the next pour writes its own presses plus every one
    // before it -- free revenue on paper, and a drawer that never reconciles.
    AppState s = fresh_state();

    s.armedQty[2] = 3;
    press_n_times(s, 2, 3);
    run_until_done(s, 2);
    CHECK_EQ(count_transactions(TEST_TXN_DIR), 3);

    s.armedQty[2] = 2;
    press_n_times(s, 2, 2);
    run_until_done(s, 2);

    CHECK_EQ(count_transactions(TEST_TXN_DIR), 5);   // 3 + 2, not 3 + 5
    CHECK_EQ((int)sum_amounts(TEST_TXN_DIR), 100);
}

static void test_no_credit_comes_back_from_nowhere()
{
    // armedUnitsReserved counts presses in flight and used to be decremented
    // by one when a whole pour finished, leaving the rest reserved for good.
    // A later jam on the slot refunds whatever is reserved into armedQty, so
    // the leftovers would come back as free credit.
    AppState s = fresh_state();
    s.armedQty[2] = 3;

    press_n_times(s, 2, 3);
    run_until_done(s, 2);

    CHECK_EQ(s.armedQty[2], 0);
    for (int i = 0; i < 20; i++) pump_loop(s);
    CHECK_EQ(s.armedQty[2], 0);                      // still nothing conjured
    CHECK_EQ(count_transactions(TEST_TXN_DIR), 3);
}

// ------------------------------------------------ suite ---

void run_multi_press_tests()
{
    SUITE("Multiple presses on one pour");

    RUN_TEST(test_five_presses_stay_one_pour);
    RUN_TEST(test_five_presses_write_five_records);
    RUN_TEST(test_each_record_is_one_press_at_the_press_price);
    RUN_TEST(test_a_single_press_still_writes_exactly_one);
    RUN_TEST(test_a_later_pour_does_not_replay_the_earlier_presses);
    RUN_TEST(test_no_credit_comes_back_from_nowhere);

    fs::remove_all(TEST_DIR);
    init_hardware_config({});
}

// ==========================================================================
// Hold before a pour starts
//
// V1's rule: a press on an IDLE pump must be held BUTTON_HOLD_MS (100ms) before
// it counts, so a noise blip on the button wire cannot start a pump, spend a
// credit and record a sale nobody made.
// ==========================================================================

static AppState hold_state()
{
    fs::remove_all(TEST_DIR);
    fs::create_directories(TEST_TXN_DIR);

    init_hardware_config({{"PRICE2", "20"},
                          {"calibrateProduct2", "(20, 5.0)"}});
    pump_reset_state();
    mock_release_all_buttons();

    AppState s;
    s.machineId      = "23";
    s.transactionDir = TEST_TXN_DIR;
    // The debounce window is module state; flush whatever an earlier test left.
    for (int i = 0; i < 4; i++) pump_loop(s);
    return s;
}

// Hold the button for a wall-clock duration, then let go.
static void hold_for(AppState &s, int slot, int ms)
{
    mock_set_button(pin_button[slot], true);
    auto until = std::chrono::steady_clock::now() + std::chrono::milliseconds(ms);
    while (std::chrono::steady_clock::now() < until) pump_loop(s);
    mock_release_all_buttons();
    pump_loop(s);
}

static void test_a_blip_on_an_idle_slot_starts_nothing()
{
    // Half the hold. Depending on how fast the loop runs, this is cut by the
    // debounce or by the hold -- either way no pump may start.
    AppState s = hold_state();
    s.armedQty[2] = 1;

    hold_for(s, 2, BUTTON_HOLD_MS / 2);

    CHECK_EQ(s.armedQty[2], 1);                      // credit untouched
    CHECK_EQ(s.slotBusy[2], false);                  // no pump started
    CHECK_EQ(count_transactions(TEST_TXN_DIR), 0);
}

static void test_a_deliberate_hold_starts_the_pour()
{
    AppState s = hold_state();
    s.armedQty[2] = 1;

    hold_for(s, 2, BUTTON_HOLD_MS * 4);

    CHECK_EQ(s.armedQty[2], 0);
    CHECK_EQ(s.slotBusy[2], true);
}

// Milliseconds from touching the button to the credit being taken. Stops
// there: the release and the loop after it are not part of what we measure.
static long long press_and_time(AppState &s, int slot)
{
    int before = s.armedQty[slot];
    auto t0 = std::chrono::steady_clock::now();
    mock_set_button(pin_button[slot], true);
    auto deadline = t0 + std::chrono::milliseconds(1500);
    while (s.armedQty[slot] == before && std::chrono::steady_clock::now() < deadline)
        pump_loop(s);
    long long took = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now() - t0).count();
    CHECK(s.armedQty[slot] != before);
    mock_release_all_buttons();
    pump_loop(s);
    return took;
}

static void test_a_press_on_a_running_pump_is_not_held()
{
    // Fast tapping must keep working: once a pour is running, the next press
    // counts on the debounced edge rather than waiting out BUTTON_HOLD_MS.
    // Without this, deleting the `if (isPumping)` line breaks nothing here.
    //
    // How long the debounce takes depends on the machine -- pump_loop paces
    // itself against the hardware, so 4 samples span ~70ms on a Pi and ~160ms
    // on a dev PC. The strict claim only means something when that window is
    // comfortably shorter than the hold, so it is measured and the assertion
    // adapts rather than going flaky on whichever machine runs it.
    AppState s = hold_state();

    auto t0 = std::chrono::steady_clock::now();
    for (int i = 0; i < 8; i++) pump_loop(s);
    long long perLoop = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now() - t0).count() / 8;
    // An instant press lands on the 4th sample, so it costs about 4 loops.
    // Only claim it beat the hold when 4 loops clearly fit inside it -- on a
    // slow dev PC they do not, and the timing simply cannot tell the two paths
    // apart there.
    long long instantMs = perLoop * 4;

    s.armedQty[2] = 2;
    press_n_times(s, 2, 1);                      // first press: held, starts the pour
    CHECK_EQ(s.slotBusy[2], true);

    std::this_thread::sleep_for(std::chrono::milliseconds(PRESS_COOLDOWN_MS));

    long long tookMs = press_and_time(s, 2);     // second press: pump already running

    CHECK_EQ(s.armedQty[2], 0);                  // it landed
    if (instantMs + 30 < BUTTON_HOLD_MS)
        CHECK(tookMs < BUTTON_HOLD_MS);          // without waiting out the hold
}

void run_button_hold_tests()
{
    SUITE("Hold before a pour starts");

    RUN_TEST(test_a_blip_on_an_idle_slot_starts_nothing);
    RUN_TEST(test_a_deliberate_hold_starts_the_pour);
    RUN_TEST(test_a_press_on_a_running_pump_is_not_held);

    fs::remove_all(TEST_DIR);
    mock_release_all_buttons();
    init_hardware_config({});
}
