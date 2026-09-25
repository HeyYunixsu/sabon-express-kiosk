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

// Credits a customer paid for that never became product.
//
// The old code zeroed armedQty after 120 seconds and logged the word
// "refunded". Nothing was refunded. The credits vanished, and the only trace
// was a prose PM2 line that rotates out after seven days -- so a drawer that
// was 60 pesos heavy than the books had nothing to explain it, and the
// cashier carried the difference.

static const std::string TEST_DIR = "tests/tmp_unclaimed";
static const std::string TEST_TXN_DIR = TEST_DIR + "/transaction";
static const std::string TEST_LOG = TEST_DIR + "/unclaimed_credits.jsonl";

static std::string read_all(const std::string &path)
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

static AppState fresh_state()
{
    fs::remove_all(TEST_DIR);
    fs::create_directories(TEST_TXN_DIR);

    init_hardware_config({{"PRICE2", "20"}, {"PRICE4", "25"}});
    pump_reset_state();

    AppState s;
    s.machineId         = "23";
    s.transactionDir    = TEST_TXN_DIR;
    s.armTimeoutSeconds = 1;          // so a test need not wait five minutes
    s.unclaimedLogPath  = TEST_LOG;
    return s;
}

static void test_timeout_value_is_clamped()
{
    CHECK_EQ(clamp_arm_timeout("300"), 300);
    CHECK_EQ(clamp_arm_timeout("600"), 600);

    // Too short is unusable at the counter; too long leaves a live button on
    // an unattended machine.
    CHECK_EQ(clamp_arm_timeout("5"), 30);
    CHECK_EQ(clamp_arm_timeout("99999"), 1800);

    // A typo in config.env must not take the machine down at boot.
    CHECK_EQ(clamp_arm_timeout("abc"), 300);
    CHECK_EQ(clamp_arm_timeout(""), 300);
}

static void test_resolve_config_path_joins_relative_paths()
{
    // Unset. A relative path must join to the base -- this is the case that
    // used to silently split the controller (cwd = <repo>/controller) from
    // the dashboard (resolves against the repo root) whenever a client set a
    // relative PRIME_LOG/INTERRUPTED_LOG/UNCLAIMED_LOG/PRICE_LOG in config.env.
    CHECK_EQ(resolve_config_path("/repo", "logs/prime_events.jsonl"), "/repo/logs/prime_events.jsonl");
}

static void test_resolve_config_path_leaves_absolute_paths_unchanged()
{
    // Unix-style absolute.
    CHECK_EQ(resolve_config_path("/repo", "/var/log/prime_events.jsonl"), "/var/log/prime_events.jsonl");
    // Windows-style absolute -- both slash directions. This code builds and
    // runs its tests on Windows as well as the Pi.
    CHECK_EQ(resolve_config_path("/repo", "C:\\logs\\prime_events.jsonl"), "C:\\logs\\prime_events.jsonl");
    CHECK_EQ(resolve_config_path("/repo", "C:/logs/prime_events.jsonl"), "C:/logs/prime_events.jsonl");
}

static void test_resolve_config_path_empty_stays_empty()
{
    // An unconfigured key must stay empty so the caller's own default applies
    // -- resolving "" against the base would otherwise silently point every
    // unset log at the repo root itself.
    CHECK_EQ(resolve_config_path("/repo", ""), "");
}

static void test_credits_expire_at_the_configured_time()
{
    AppState s = fresh_state();
    s.armTimeoutSeconds = 1;
    s.armedQty[2] = 3;
    pump_loop(s);                     // stamps armTimestamp
    CHECK_EQ(s.armedQty[2], 3);       // not yet

    std::this_thread::sleep_for(std::chrono::milliseconds(1100));
    pump_loop(s);
    CHECK_EQ(s.armedQty[2], 0);
}

static void test_expired_credits_are_recorded()
{
    AppState s = fresh_state();
    s.armTimeoutSeconds = 1;
    s.armedQty[2] = 3;
    pump_loop(s);

    std::this_thread::sleep_for(std::chrono::milliseconds(1100));
    pump_loop(s);

    CHECK_EQ(count_lines(TEST_LOG), 1);

    const std::string body = read_all(TEST_LOG);
    CHECK(body.find("\"slot\":\"2\"") != std::string::npos);
    CHECK(body.find("\"qty\":3") != std::string::npos);
    CHECK(body.find("\"reason\":\"timeout\"") != std::string::npos);
    CHECK(body.find("\"date_created\"") != std::string::npos);

    // The peso figure is what reconciles against the drawer: 3 presses at the
    // slot 2 price of 20.
    CHECK(body.find("\"amount\":60") != std::string::npos);
}

static void test_queued_credits_are_recorded_too()
{
    // ARM queues behind a busy slot. Those credits were paid for exactly like
    // the armed ones, so dropping them on a timeout without a record is the
    // same bug in a quieter place.
    AppState s = fresh_state();
    s.armTimeoutSeconds = 1;
    s.armedQty[2] = 2;
    s.pendingQueue[2].push(PendingArm(2, 4));
    pump_loop(s);

    std::this_thread::sleep_for(std::chrono::milliseconds(1100));
    pump_loop(s);

    CHECK_EQ(s.armedQty[2], 0);
    CHECK_EQ((int)s.pendingQueue[2].size(), 0);
    CHECK_EQ(count_lines(TEST_LOG), 1);
    CHECK(read_all(TEST_LOG).find("\"qty\":6") != std::string::npos);
}

static void test_one_timeout_writes_one_record()
{
    // The expiry check runs every loop. Without armedQty reaching zero it
    // would append a line on every turn for as long as the machine ran.
    AppState s = fresh_state();
    s.armTimeoutSeconds = 1;
    s.armedQty[4] = 1;
    pump_loop(s);

    std::this_thread::sleep_for(std::chrono::milliseconds(1100));
    for (int i = 0; i < 20; i++) pump_loop(s);

    CHECK_EQ(count_lines(TEST_LOG), 1);
}

static void test_an_idle_machine_records_nothing()
{
    // By far the common case: nothing armed, nobody at the counter.
    AppState s = fresh_state();
    s.armTimeoutSeconds = 1;

    std::this_thread::sleep_for(std::chrono::milliseconds(1100));
    for (int i = 0; i < 20; i++) pump_loop(s);

    CHECK_EQ(count_lines(TEST_LOG), 0);
}

static void test_a_dispensing_slot_does_not_expire()
{
    // The customer is mid-pour. Writing their credit off underneath them
    // would be worse than the bug this feature fixes.
    AppState s = fresh_state();
    s.armTimeoutSeconds = 1;
    s.armedQty[2] = 2;
    s.slotBusy[2] = true;
    pump_loop(s);

    std::this_thread::sleep_for(std::chrono::milliseconds(1100));
    for (int i = 0; i < 10; i++) pump_loop(s);

    CHECK_EQ(s.armedQty[2], 2);
    CHECK_EQ(count_lines(TEST_LOG), 0);
}

static void test_cancelled_credits_are_recorded()
{
    AppState s = fresh_state();
    pump_record_unclaimed(s, 4, 2, "cancelled");

    CHECK_EQ(count_lines(TEST_LOG), 1);
    const std::string body = read_all(TEST_LOG);
    CHECK(body.find("\"reason\":\"cancelled\"") != std::string::npos);
    CHECK(body.find("\"slot\":\"4\"") != std::string::npos);
    CHECK(body.find("\"amount\":50") != std::string::npos);   // 2 x 25
}

static void test_cancelling_nothing_records_nothing()
{
    // Cancel All on an idle machine is a common stray tap. It must not write
    // a row saying zero credits went missing.
    AppState s = fresh_state();
    pump_record_unclaimed(s, 4, 0, "cancelled");

    CHECK_EQ(count_lines(TEST_LOG), 0);
}

void run_unclaimed_tests()
{
    SUITE("Unclaimed credits");

    RUN_TEST(test_timeout_value_is_clamped);
    RUN_TEST(test_resolve_config_path_joins_relative_paths);
    RUN_TEST(test_resolve_config_path_leaves_absolute_paths_unchanged);
    RUN_TEST(test_resolve_config_path_empty_stays_empty);
    RUN_TEST(test_credits_expire_at_the_configured_time);
    RUN_TEST(test_expired_credits_are_recorded);
    RUN_TEST(test_queued_credits_are_recorded_too);
    RUN_TEST(test_one_timeout_writes_one_record);
    RUN_TEST(test_an_idle_machine_records_nothing);
    RUN_TEST(test_a_dispensing_slot_does_not_expire);
    RUN_TEST(test_cancelled_credits_are_recorded);
    RUN_TEST(test_cancelling_nothing_records_nothing);

    fs::remove_all(TEST_DIR);
    init_hardware_config({});
}
