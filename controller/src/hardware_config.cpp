#include "hardware_config.h"
#include "utils.h"
#include <cstdio>
#include <fstream>
#include <sstream>
#include <string>

// ------------------------------------------------------------------------------
// Final 6-slot pin map (BCM numbering) — all independent, no shared pins
// ------------------------------------------------------------------------------

int BTN1 = 14, BTN2 = 24, BTN3 = 25, BTN4 = 10, BTN5 = 13, BTN6 = 23;
int PUMP1 = 15, PUMP2 = 16, PUMP3 =  6, PUMP4 = 17, PUMP5 = 18, PUMP6 = 12;
int LED1 =  5, LED2 = 27, LED3 =  4, LED4 = 22, LED5 = 19, LED6 =  7;

int PUMP_TRIGGER_HIGH = 0;
int PUMP_TRIGGER_LOW  = 1;

int WATER_SENSOR_EMPTY_HIGH = 1;
bool product_calibrated[TOTAL_SLOTS + 1] = {false};

std::map<int, int> pin_pump {
    {1, PUMP1}, {2, PUMP2}, {3, PUMP3}, {4, PUMP4}, {5, PUMP5}, {6, PUMP6}
};
std::map<int, int> pin_led {
    {1, LED1}, {2, LED2}, {3, LED3}, {4, LED4}, {5, LED5}, {6, LED6}
};
std::map<int, int> pin_button {
    {1, BTN1}, {2, BTN2}, {3, BTN3}, {4, BTN4}, {5, BTN5}, {6, BTN6}
};

std::map<int, Product> productMap {
    {1, {1, 5, 2.777777777777778}},
    {2, {2, 5, 1.363636363636364}},
    {3, {3, 5, 1.25}},
    {4, {4, 5, 2.0}},
    {5, {5, 5, 2.0}},
    {6, {6, 5, 2.0}},
};

// ------------------------------------------------------------------------------
// Runtime initialisation from config.env
// ------------------------------------------------------------------------------

static bool parse_calibrate(const std::string &val, int &coins, double &secs)
{
    return std::sscanf(val.c_str(), "(%d, %lf)", &coins, &secs) == 2;
}

void init_hardware_config(const std::map<std::string, std::string> &config)
{
    auto load_int = [&](const std::string &key, int &dest) {
        auto it = config.find(key);
        if (it != config.end() && !it->second.empty())
            dest = std::stoi(it->second);
    };

    load_int("BTN1", BTN1); load_int("BTN2", BTN2); load_int("BTN3", BTN3);
    load_int("BTN4", BTN4); load_int("BTN5", BTN5); load_int("BTN6", BTN6);
    load_int("PUMP1", PUMP1); load_int("PUMP2", PUMP2); load_int("PUMP3", PUMP3);
    load_int("PUMP4", PUMP4); load_int("PUMP5", PUMP5); load_int("PUMP6", PUMP6);
    load_int("LED1", LED1); load_int("LED2", LED2); load_int("LED3", LED3);
    load_int("LED4", LED4); load_int("LED5", LED5); load_int("LED6", LED6);
    load_int("PUMP_TRIGGER_HIGH", PUMP_TRIGGER_HIGH);
    load_int("PUMP_TRIGGER_LOW",  PUMP_TRIGGER_LOW);
    load_int("WATER_SENSOR_EMPTY_HIGH", WATER_SENSOR_EMPTY_HIGH);

    pin_pump   = {{1, PUMP1}, {2, PUMP2}, {3, PUMP3}, {4, PUMP4}, {5, PUMP5}, {6, PUMP6}};
    pin_led    = {{1, LED1},  {2, LED2},  {3, LED3},  {4, LED4},  {5, LED5},  {6, LED6}};
    pin_button = {{1, BTN1},  {2, BTN2},  {3, BTN3},  {4, BTN4},  {5, BTN5},  {6, BTN6}};

    static const struct { int coins; double seconds; } defaults[TOTAL_SLOTS + 1] = {
        {},
        {5, 2.777777777777778},
        {5, 1.363636363636364},
        {5, 1.25},
        {5, 2.0},
        {5, 2.0},
        {5, 2.0},
    };

    for (int i = 1; i <= TOTAL_SLOTS; i++) {
        int    coins = defaults[i].coins;
        double secs  = defaults[i].seconds;
        std::string key = "calibrateProduct" + std::to_string(i);
        auto it = config.find(key);
        product_calibrated[i] = false;
        if (it != config.end()) {
            int c; double s;
            if (parse_calibrate(it->second, c, s)) { coins = c; secs = s; product_calibrated[i] = true; }
            else log_error("hardware", "Could not parse " + key + ": " + it->second);
        }
        // A separate PRICEn wins over calibrateProductN's first value. Price
        // is commercial and changes with the market; seconds are physical and
        // are set once at install. Keeping them in one tuple meant a price
        // edit could fat-finger the pour duration.
        std::string priceKey = "PRICE" + std::to_string(i);
        auto pit = config.find(priceKey);
        if (pit != config.end() && !pit->second.empty()) {
            try {
                int p = std::stoi(pit->second);
                if (p >= 0 && p <= MAX_PRICE) coins = p;
                else log_error("hardware", priceKey + " out of range: " + pit->second);
            } catch (const std::exception &) {
                log_error("hardware", "Could not parse " + priceKey + ": " + pit->second);
            }
        }

        productMap[i] = {i, coins, secs};
    }
}

// ------------------------------------------------------------------------------
// Prices
// ------------------------------------------------------------------------------

bool set_product_price(int slot, int pesos)
{
    if (slot < 1 || slot > TOTAL_SLOTS) return false;
    if (pesos < 0 || pesos > MAX_PRICE) return false;
    productMap[slot].coins = pesos;
    return true;
}

void load_prices_file(const std::string &path)
{
    if (path.empty()) return;
    std::ifstream f(path);
    if (!f.is_open()) return;   // nobody has edited prices on this machine yet

    // Deliberately a flat "slot=price" list rather than JSON: it is read by
    // the controller at boot, and a hand-repairable file beats a parser.
    std::string line;
    int applied = 0;
    while (std::getline(f, line)) {
        line = trim(line);
        if (line.empty() || line[0] == '#') continue;
        size_t eq = line.find('=');
        if (eq == std::string::npos) continue;
        try {
            int slot  = std::stoi(trim(line.substr(0, eq)));
            int pesos = std::stoi(trim(line.substr(eq + 1)));
            if (set_product_price(slot, pesos)) applied++;
            else log_error("hardware", "Ignored out-of-range price line: " + line);
        } catch (const std::exception &) {
            log_error("hardware", "Ignored malformed price line: " + line);
        }
    }
    if (applied > 0)
        log_info("hardware", "Applied " + std::to_string(applied)
                 + " saved price(s) from " + path);
}

bool save_prices_file(const std::string &path)
{
    if (path.empty()) return false;

    std::string parent = fs::path(path).parent_path().string();
    if (!parent.empty() && !ensureDirectoryExists(parent)) return false;

    std::ostringstream out;
    out << "# Prices in pesos per press, set from the dashboard.\n";
    out << "# Pour duration is NOT here -- see calibrateProductN in config.env.\n";
    for (int i = 1; i <= TOTAL_SLOTS; i++)
        out << i << " = " << productMap[i].coins << "\n";

    std::ofstream f(path, std::ios::trunc);
    if (!f.is_open()) {
        log_error("hardware", "Could not write prices to " + path);
        return false;
    }
    f << out.str();
    return f.good();
}
