#include "test_framework.h"
#include "hardware_config.h"
#include "pump_control.h"
#include <wiringPi.h>

// These tests pin down the BCM GPIO numbers assigned to each pump, LED and
// button. If a pin is rewired on the physical board, exactly one of these
// tests will fail, making it obvious which mapping needs updating.
//
// They assert the compiled-in defaults, which are what a machine falls back
// to when CONFIG/config.env omits a key. init_hardware_config() overrides
// these at runtime and is deliberately not called here.

// ----------------------------------------------------------- pump pins ---

void test_pump1_pin_is_15() {
    CHECK_EQ(pin_pump[1], 15);
    CHECK_EQ(pin_pump[1], PUMP1);
}

void test_pump2_pin_is_16() {
    CHECK_EQ(pin_pump[2], 16);
    CHECK_EQ(pin_pump[2], PUMP2);
}

void test_pump3_pin_is_6() {
    CHECK_EQ(pin_pump[3], 6);
    CHECK_EQ(pin_pump[3], PUMP3);
}

void test_pump4_pin_is_17() {
    CHECK_EQ(pin_pump[4], 17);
    CHECK_EQ(pin_pump[4], PUMP4);
}

void test_pump5_pin_is_18() {
    CHECK_EQ(pin_pump[5], 18);
    CHECK_EQ(pin_pump[5], PUMP5);
}

void test_pump6_pin_is_12() {
    CHECK_EQ(pin_pump[6], 12);
    CHECK_EQ(pin_pump[6], PUMP6);
}

// ------------------------------------------------------- map completeness ---
// Every slot must have a pump, an LED and a button — a short map means a
// slot would silently read/write GPIO 0.

void test_pin_maps_cover_every_slot() {
    CHECK_EQ((int)pin_pump.size(),   TOTAL_SLOTS);
    CHECK_EQ((int)pin_led.size(),    TOTAL_SLOTS);
    CHECK_EQ((int)pin_button.size(), TOTAL_SLOTS);
}

void test_every_slot_has_calibration() {
    CHECK_EQ((int)productMap.size(), TOTAL_SLOTS);
    for (int i = 1; i <= TOTAL_SLOTS; i++) {
        CHECK(productMap.count(i) == 1);
        CHECK(productMap[i].durationSeconds > 0.0);
    }
}

// No pin may be shared between two functions — a collision is the class of
// bug that previously caused false button triggers (BTN2/LED5 both on GPIO24).
void test_no_gpio_pin_is_used_twice() {
    std::map<int, int> seen;   // pin -> times used
    for (int i = 1; i <= TOTAL_SLOTS; i++) {
        seen[pin_pump[i]]++;
        seen[pin_led[i]]++;
        seen[pin_button[i]]++;
    }
    for (const auto &kv : seen) {
        CHECK_EQ(kv.second, 1);
    }
}

// -------------------------------------------------- relay polarity ---
// The relay board is active-low: sending LOW turns the pump ON.

void test_pump_trigger_high_is_LOW() {
    CHECK_EQ(PUMP_TRIGGER_HIGH, LOW);
}

void test_pump_trigger_low_is_HIGH() {
    CHECK_EQ(PUMP_TRIGGER_LOW, HIGH);
}

// -------------------------------------------- water sensor polarity ---
// Sensors are wired GPIO -> GND with a pull-up, so a disconnected one reads
// HIGH. The default must therefore treat HIGH as empty: a dead sensor then
// blocks its pump instead of letting it run dry.

void test_water_sensor_empty_high_defaults_to_1() {
    CHECK_EQ(WATER_SENSOR_EMPTY_HIGH, 1);
}

// The only test here that calls init_hardware_config(). It restores the value
// it changes, so the rest of the suite still sees the compiled-in defaults.
void test_water_sensor_empty_high_loads_from_config() {
    const int saved = WATER_SENSOR_EMPTY_HIGH;

    std::map<std::string, std::string> config{{"WATER_SENSOR_EMPTY_HIGH", "0"}};
    init_hardware_config(config);
    CHECK_EQ(WATER_SENSOR_EMPTY_HIGH, 0);

    config["WATER_SENSOR_EMPTY_HIGH"] = "1";
    init_hardware_config(config);
    CHECK_EQ(WATER_SENSOR_EMPTY_HIGH, 1);

    WATER_SENSOR_EMPTY_HIGH = saved;
}

// --------------------------------------------------------- button pins ---

void test_btn1_pin_is_14() { CHECK_EQ(BTN1, 14); }
void test_btn2_pin_is_24() { CHECK_EQ(BTN2, 24); }
void test_btn3_pin_is_25() { CHECK_EQ(BTN3, 25); }
void test_btn4_pin_is_10() { CHECK_EQ(BTN4, 10); }
void test_btn5_pin_is_13() { CHECK_EQ(BTN5, 13); }
void test_btn6_pin_is_23() { CHECK_EQ(BTN6, 23); }

// ------------------------------------------------------------- LED pins ---

void test_led1_pin_is_5()  { CHECK_EQ(LED1, 5);  }
void test_led2_pin_is_27() { CHECK_EQ(LED2, 27); }
void test_led3_pin_is_4()  { CHECK_EQ(LED3, 4);  }
void test_led4_pin_is_22() { CHECK_EQ(LED4, 22); }
void test_led5_pin_is_19() { CHECK_EQ(LED5, 19); }
void test_led6_pin_is_7()  { CHECK_EQ(LED6, 7);  }

// ---------------------------------------------------------- entry point ---

static void test_uncalibrated_slots_are_flagged()
{
    // The quietest fault this machine has: an uncalibrated slot pumps, lights
    // its LED, records the sale at the right price and uploads it. Only the
    // volume is wrong. Nothing else reports it, so the flag has to be right.
    init_hardware_config({});
    for (int i = 1; i <= TOTAL_SLOTS; i++)
        CHECK_EQ(product_calibrated[i], false);

    init_hardware_config({{"calibrateProduct2", "(5, 4.0)"},
                          {"calibrateProduct5", "(5, 1.5)"}});
    CHECK_EQ(product_calibrated[2], true);
    CHECK_EQ(product_calibrated[5], true);
    CHECK_EQ(product_calibrated[1], false);
    CHECK_EQ(product_calibrated[6], false);

    // A malformed value is not calibration. It falls back to the compiled
    // default, so it must be reported exactly like an absent one.
    init_hardware_config({{"calibrateProduct3", "not a tuple"}});
    CHECK_EQ(product_calibrated[3], false);

    init_hardware_config({});
}

// ------------------------------------------------- button self-check ---
//
// A button at rest must read HIGH: the boot-time pull-up holds the line up
// until a press shorts it to GND. Reading LOW with nobody touching it is the
// single symptom shared by every wiring fault -- no pull-up, a peripheral
// holding the pin, or a switch shorted across same-side tactile legs -- and
// the controller used to start silently regardless.

static void test_untouched_buttons_are_not_stuck()
{
    init_hardware_config({});
    mock_release_all_buttons();
    CHECK_EQ((int)pump_stuck_buttons().size(), 0);
}

static void test_a_button_reading_low_at_rest_is_reported()
{
    init_hardware_config({});
    mock_release_all_buttons();
    mock_set_button(pin_button[1], true);          // GPIO14 held low

    std::vector<int> stuck = pump_stuck_buttons();
    CHECK_EQ((int)stuck.size(), 1);
    CHECK_EQ(stuck[0], 1);                          // reported by SLOT, not pin

    mock_release_all_buttons();
}

static void test_every_stuck_button_is_named_not_just_the_first()
{
    // The fault that prompted this was several buttons at once, so stopping
    // at the first one would have hidden most of it.
    init_hardware_config({});
    mock_release_all_buttons();
    mock_set_button(pin_button[2], true);
    mock_set_button(pin_button[5], true);

    std::vector<int> stuck = pump_stuck_buttons();
    CHECK_EQ((int)stuck.size(), 2);
    CHECK_EQ(stuck[0], 2);
    CHECK_EQ(stuck[1], 5);

    mock_release_all_buttons();
    CHECK_EQ((int)pump_stuck_buttons().size(), 0);   // and it clears again
}

void run_hardware_tests() {
    SUITE("hardware_config");
    RUN_TEST(test_pump1_pin_is_15);
    RUN_TEST(test_pump2_pin_is_16);
    RUN_TEST(test_pump3_pin_is_6);
    RUN_TEST(test_pump4_pin_is_17);
    RUN_TEST(test_pump5_pin_is_18);
    RUN_TEST(test_pump6_pin_is_12);
    RUN_TEST(test_pin_maps_cover_every_slot);
    RUN_TEST(test_every_slot_has_calibration);
    RUN_TEST(test_no_gpio_pin_is_used_twice);
    RUN_TEST(test_pump_trigger_high_is_LOW);
    RUN_TEST(test_pump_trigger_low_is_HIGH);
    RUN_TEST(test_water_sensor_empty_high_defaults_to_1);
    RUN_TEST(test_water_sensor_empty_high_loads_from_config);
    RUN_TEST(test_btn1_pin_is_14);
    RUN_TEST(test_btn2_pin_is_24);
    RUN_TEST(test_btn3_pin_is_25);
    RUN_TEST(test_btn4_pin_is_10);
    RUN_TEST(test_btn5_pin_is_13);
    RUN_TEST(test_btn6_pin_is_23);
    RUN_TEST(test_led1_pin_is_5);
    RUN_TEST(test_led2_pin_is_27);
    RUN_TEST(test_led3_pin_is_4);
    RUN_TEST(test_led4_pin_is_22);
    RUN_TEST(test_led5_pin_is_19);
    RUN_TEST(test_led6_pin_is_7);
    RUN_TEST(test_uncalibrated_slots_are_flagged);
    RUN_TEST(test_untouched_buttons_are_not_stuck);
    RUN_TEST(test_a_button_reading_low_at_rest_is_reported);
    RUN_TEST(test_every_stuck_button_is_named_not_just_the_first);
}
