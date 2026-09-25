#include "test_framework.h"
#include "pump_control.h"
#include "hardware_config.h"
#include "app_state.h"
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>

namespace fs = std::filesystem;

// Price tests.
//
// Prices are set per client rather than compiled in, which means they are
// editable at runtime -- and a price is what every future sale is worth, so
// it is precisely the lever someone skimming would reach for. The tests here
// hold three lines:
//
//   1. A change is always audited. from, to and when, on disk, before the
//      change is even persisted.
//   2. A change is never accepted mid-sale. A customer who paid 25 must not
//      have 20 recorded because the price moved between arming and pressing.
//   3. A change survives a restart, and outranks config.env. A price that
//      silently reverted on reboot would be worse than one that never saved.

// ------------------------------------------------ helpers ---

static const std::string TEST_DIR    = "tests/tmp_prices";
static const std::string PRICES_FILE = TEST_DIR + "/prices.conf";
static const std::string PRICE_LOG   = TEST_DIR + "/price_changes.jsonl";

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

static AppState fresh_state(const std::map<std::string, std::string> &config = {})
{
    fs::remove_all(TEST_DIR);
    fs::create_directories(TEST_DIR);

    init_hardware_config(config);
    pump_reset_state();

    AppState s;
    s.machineId    = "23";
    s.pricesPath   = PRICES_FILE;
    s.priceLogPath = PRICE_LOG;
    return s;
}

// ------------------------------------------------ tests ---

static void test_price_defaults_to_the_calibration_value()
{
    // The legacy layout put price and pour duration in one tuple. Machines in
    // the field still ship that way, so it must keep working untouched.
    AppState s = fresh_state({{"calibrateProduct2", "(7, 1.5)"}});

    CHECK_EQ(pump_get_price(2), 7);
    CHECK_EQ(productMap[2].durationSeconds, 1.5);
}

static void test_price_key_overrides_the_calibration_value()
{
    AppState s = fresh_state({
        {"calibrateProduct3", "(5, 4.44)"},
        {"PRICE3", "25"},
    });

    CHECK_EQ(pump_get_price(3), 25);

    // The seconds must be untouched. Price is commercial and changes with the
    // market; duration is physical and set once at install. A price edit that
    // altered how much liquid came out would be a silent giveaway.
    CHECK_EQ(productMap[3].durationSeconds, 4.44);
}

static void test_absurd_prices_are_refused()
{
    AppState s = fresh_state({{"PRICE1", "20"}});

    CHECK(pump_set_price(s, 1, -1) == PriceResult::PRICE_INVALID);
    CHECK(pump_set_price(s, 1, MAX_PRICE + 1) == PriceResult::PRICE_INVALID);
    CHECK(pump_set_price(s, 0, 20) == PriceResult::SLOT_INVALID);
    CHECK(pump_set_price(s, TOTAL_SLOTS + 1, 20) == PriceResult::SLOT_INVALID);

    // A refused change must leave the price alone, not half-apply it.
    CHECK_EQ(pump_get_price(1), 20);
    CHECK_EQ(count_lines(PRICE_LOG), 0);
}

static void test_price_change_is_refused_mid_sale()
{
    // A press books the price at the moment the button goes down. Moving it
    // between arming and pressing charges the customer one figure and records
    // another -- in either direction, and the discrepancy lands on the cashier.
    AppState s = fresh_state({{"PRICE1", "20"}});

    s.armedQty[1] = 2;
    CHECK(pump_set_price(s, 1, 25) == PriceResult::SALE_IN_PROGRESS);
    CHECK_EQ(pump_get_price(1), 20);

    // Any armed slot blocks any price: a batch sale spans several products.
    CHECK(pump_set_price(s, 4, 30) == PriceResult::SALE_IN_PROGRESS);

    // A slot mid-dispense counts too.
    s.armedQty[1] = 0;
    s.slotBusy[1] = true;
    CHECK(pump_set_price(s, 1, 25) == PriceResult::SALE_IN_PROGRESS);

    CHECK_EQ(count_lines(PRICE_LOG), 0);

    // Once the sale is done the change goes through.
    s.slotBusy[1] = false;
    CHECK(pump_set_price(s, 1, 25) == PriceResult::OK);
    CHECK_EQ(pump_get_price(1), 25);
}

static void test_every_change_is_audited()
{
    AppState s = fresh_state({{"PRICE5", "15"}});

    CHECK(pump_set_price(s, 5, 18) == PriceResult::OK);

    std::string body = read_file(PRICE_LOG);
    CHECK(body.find("\"slot\":\"5\"") != std::string::npos);
    CHECK(body.find("\"from\":15") != std::string::npos);
    CHECK(body.find("\"to\":18") != std::string::npos);
    CHECK(body.find("\"machine_id\":\"23\"") != std::string::npos);
    CHECK(body.find("\"date_created\"") != std::string::npos);

    // The previous value matters most: without it the log says a price is now
    // 18 but not that someone quietly moved it down from 25 last week.
    CHECK(pump_set_price(s, 5, 12) == PriceResult::OK);
    CHECK_EQ(count_lines(PRICE_LOG), 2);
    CHECK(read_file(PRICE_LOG).find("\"from\":18") != std::string::npos);
}

static void test_price_survives_a_restart()
{
    AppState s = fresh_state({{"PRICE6", "15"}});
    CHECK(pump_set_price(s, 6, 22) == PriceResult::OK);
    CHECK(fs::exists(PRICES_FILE));

    // Restart: config.env is read again from scratch, then the saved file.
    init_hardware_config({{"PRICE6", "15"}});
    CHECK_EQ(pump_get_price(6), 15);          // config.env value, before the overlay

    load_prices_file(PRICES_FILE);
    CHECK_EQ(pump_get_price(6), 22);          // what the operator actually set
}

static void test_a_damaged_prices_file_does_not_wipe_prices()
{
    AppState s = fresh_state({{"PRICE1", "20"}, {"PRICE2", "30"}});

    std::ofstream f(PRICES_FILE, std::ios::trunc);
    f << "# a comment\n";
    f << "not a price line\n";
    f << "2 = 35\n";
    f << "9 = 40\n";        // slot off the machine
    f << "1 = 999999\n";    // absurd
    f.close();

    load_prices_file(PRICES_FILE);

    CHECK_EQ(pump_get_price(2), 35);   // the one good line applied
    CHECK_EQ(pump_get_price(1), 20);   // the absurd one ignored, not zeroed
}

static void test_a_missing_prices_file_is_not_an_error()
{
    // A machine nobody has edited prices on is the normal case, not a fault.
    AppState s = fresh_state({{"PRICE4", "40"}});
    fs::remove(PRICES_FILE);

    load_prices_file(PRICES_FILE);
    CHECK_EQ(pump_get_price(4), 40);
}

static void test_price_reaches_the_amount_a_sale_records()
{
    // The point of all of this: productMap is what a press books, and what
    // writeTransaction sends to the cloud as "amount".
    AppState s = fresh_state({{"PRICE3", "25"}});

    CHECK_EQ(productMap[3].coins, 25);
    CHECK(pump_set_price(s, 3, 28) == PriceResult::OK);
    CHECK_EQ(productMap[3].coins, 28);
}

static void test_every_result_has_a_distinct_label()
{
    const PriceResult all[] = {
        PriceResult::OK,            PriceResult::SLOT_INVALID,
        PriceResult::PRICE_INVALID, PriceResult::SALE_IN_PROGRESS,
        PriceResult::NOT_SAVED,
    };
    for (PriceResult r : all) {
        std::string label = price_result_text(r);
        CHECK(!label.empty());
        CHECK(label != "unknown");
    }
}

// ------------------------------------------------ suite ---

void run_price_tests()
{
    SUITE("Prices (per-client, audited)");

    RUN_TEST(test_price_defaults_to_the_calibration_value);
    RUN_TEST(test_price_key_overrides_the_calibration_value);
    RUN_TEST(test_absurd_prices_are_refused);
    RUN_TEST(test_price_change_is_refused_mid_sale);
    RUN_TEST(test_every_change_is_audited);
    RUN_TEST(test_price_survives_a_restart);
    RUN_TEST(test_a_damaged_prices_file_does_not_wipe_prices);
    RUN_TEST(test_a_missing_prices_file_is_not_an_error);
    RUN_TEST(test_price_reaches_the_amount_a_sale_records);
    RUN_TEST(test_every_result_has_a_distinct_label);

    fs::remove_all(TEST_DIR);

    // Leave the compiled defaults in place for whatever runs next.
    init_hardware_config({});
}
