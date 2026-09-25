#ifndef HARDWARE_CONFIG_H
#define HARDWARE_CONFIG_H

#include <wiringPi.h>
#include <map>
#include <string>

// ------------------------------------------------------------------------------
// Final 6-slot pin map — every slot has independent button + LED + pump GPIOs.
// No shared/multiplexed pins anywhere. BCM numbering.
// ------------------------------------------------------------------------------

extern int BTN1, BTN2, BTN3, BTN4, BTN5, BTN6;
extern int PUMP1, PUMP2, PUMP3, PUMP4, PUMP5, PUMP6;
extern int LED1, LED2, LED3, LED4, LED5, LED6;

extern int PUMP_TRIGGER_HIGH;  // Active-low relay: LOW (0) turns pump ON
extern int PUMP_TRIGGER_LOW;   // HIGH (1) turns pump OFF

// Which level a water level sensor reports when its slot is EMPTY.
//   1 (default) — empty reads HIGH
//   0           — empty reads LOW
// Sensors are wired GPIO -> GND with a pull-up, so a disconnected or broken
// sensor reads HIGH. The default therefore fails safe: a dead sensor looks
// empty and the pump is blocked rather than allowed to run dry. Flip this only
// if a full slot reports empty on real hardware.
extern int WATER_SENSOR_EMPTY_HIGH;


struct Product {
    int id;
    // Price per press, in whole pesos. Reaches the cloud as the transaction
    // "amount". Named `coins` for the coin-slot era; kept because the field is
    // referenced widely, but it is a price, not a coin count.
    int coins;
    // How long the pump runs per press. Physical calibration set at install --
    // deliberately NOT editable alongside price, so a price change can never
    // alter how much liquid comes out.
    double durationSeconds;
};

extern std::map<int, int> pin_pump;
extern std::map<int, int> pin_led;
extern std::map<int, int> pin_button;
extern std::map<int, Product> productMap;

// How long a press on an IDLE pump must be held before it starts a pour, in
// milliseconds -- V1's fixed 100ms. Presses on a pump already running are not
// held.
const int BUTTON_HOLD_MS = 100;

const int TOTAL_SLOTS = 6;
// True where calibrateProductN was present in config.env. False means the slot
// is pouring on a compiled-in default measured on a different machine, which
// looks identical in every log and every screen -- the pump runs, the sale
// records, and only the volume in the customer's bottle is wrong.
extern bool product_calibrated[TOTAL_SLOTS + 1];


void init_hardware_config(const std::map<std::string, std::string> &config);

// ---------------------------------------------------------------------------
// Prices
//
// Set per client, so they live apart from the pin map and the pour
// calibration. Resolution order, last one wins:
//   1. compiled defaults
//   2. calibrateProductN's first value  (legacy layout, still honoured)
//   3. PRICEn in config.env
//   4. the prices file, written when someone edits prices on the dashboard
// ---------------------------------------------------------------------------

// Highest accepted price, in pesos. A fat-fingered extra zero should be
// refused rather than silently charged to the cloud report.
const int MAX_PRICE = 10000;

// Returns false if the slot or price is out of range; the price is unchanged.
bool set_product_price(int slot, int pesos);

// Overlay prices from `path`. Missing file is not an error -- it just means
// nobody has edited prices on this machine yet.
void load_prices_file(const std::string &path);

// Persist all six prices to `path`. Returns false if it could not be written,
// which matters: a price that is not saved silently reverts on restart.
bool save_prices_file(const std::string &path);

#endif
