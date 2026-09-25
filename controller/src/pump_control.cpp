// =============================================================================
// pump_control.cpp — 6-slot independent button+LED dispense state machine
//
// All pins fully independent — no shared/multiplexed pins.
// Buttons: INPUT only (active-low, button wired GPIO->GND) — pull-up set at boot via config.txt.
// LEDs:    OUTPUT, digitalWrite every loop.
// LED7 (Bundle Complete): GPIO26, OUTPUT, driven by state.bundleComplete.
//
// Transaction flow (millis()-driven, non-blocking):
//   IDLE ──ARM_BATCH──> ARMED ──button press──> DISPENSING
//     ^                   │  ▲                      │
//     │                   └── more credit left ─────┘
//     │                          │
//     └── all credits consumed ──┘──> COMPLETE (LED7 on)
//
// Jam protection: armedUnitsReserved tracks in-flight dispenses.
// Post-press deadline expires → refund to armedQty.
// =============================================================================

#include "pump_control.h"
#include "hardware_config.h"
#include "transaction.h"
#include "utils.h"
#include <wiringPi.h>
#include <cctype>
#include <cstdio>
#include <sstream>
#include <chrono>
#include <algorithm>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

// ------------------------------------------------------------------------------
// Module-private state
// ------------------------------------------------------------------------------
struct PumpState {
    int id = 0;
    bool isPumping = false;
    bool isPaused = false;
    double amount = 0;
    // What each press in the current pour cost, in order. The pour is one
    // continuous run -- five presses just extend the same timer -- but it is
    // five separate sales, and one record per press is the only way the press
    // count can be right on the dashboard and in the cloud. Stored per press
    // rather than divided out of a total afterwards because prices are
    // editable mid-pour, so the presses are not always worth the same.
    std::vector<double> pressAmounts;
    // Pour remainder in ms at the moment of pause. Both remainders are stored
    // and then rewritten onto the deadlines each tick while paused, rather
    // than decremented, so an hour-long pause accumulates no drift.
    long long remainingTimeWhenPaused = 0;
    long long postPressRemainingWhenPaused = 0;
    // Total paused time for THIS pour, summed across every pause. Per-pause
    // would reset on each resume, and a customer tapping resume every two
    // minutes would hold the nozzle forever.
    long long pausedTotalMs = 0;
    std::chrono::time_point<std::chrono::steady_clock> pauseStartedAt{};
    std::chrono::time_point<std::chrono::steady_clock> timer{};
    bool buttonWasPressedLastFrame = false;
    // When the current press began: the first raw LOW reading, not the moment
    // the debounce window filled. BUTTON_HOLD_MS is measured from here.
    std::chrono::time_point<std::chrono::steady_clock> pressStartTime{};
    bool rawWasLow = false;
    // Set from the debounced edge of a press on an idle pump until it has been
    // held BUTTON_HOLD_MS (then it fires) or let go (then it does not).
    bool processingTrigger = false;
    int armedUnitsReserved = 0;
    std::chrono::time_point<std::chrono::steady_clock> postPressDeadline{};
    std::chrono::time_point<std::chrono::steady_clock> armTimestamp{};  // when last armed
    // True while this pump is running a maintenance prime rather than a sale.
    // The completion branch checks it and skips writeTransaction() entirely --
    // not even a zero-peso record, which would still reach the cloud and
    // pollute the revenue report we are trying to keep honest.
    bool isPriming = false;
};

static PumpState      pumps[TOTAL_SLOTS + 1];   // index 1..TOTAL_SLOTS
static AppState      *g_state_ptr = nullptr;
static int            g_pump_start_cooldown_ms = 200;
static double         g_prime_seconds = 3.0;
static std::chrono::time_point<std::chrono::steady_clock> g_last_pump_start =
    std::chrono::steady_clock::now() - std::chrono::seconds(1);

// ------------------------------------------------------------------------------
// Dispense Trigger
// ------------------------------------------------------------------------------
// Takes the state it is to act on. It used to read a module-global pointer
// set only by pump_setup(), so pump_loop(state) silently ignored its own
// argument and wrote through whatever was last registered -- identical in
// production, a dangling pointer anywhere else.
// Returns COOLDOWN ONLY when the press was refused by the start cooldown, so
// the caller can hold on to it and try again. Every other outcome -- accepted,
// or denied for no credit, an empty slot, a pause -- consumes the press, as V1
// did. Callers that only care whether to keep the press test against COOLDOWN.
//
// It returns a result rather than a bool because the kiosk has to tell a
// customer WHY nothing happened. The reasons were already worked out here for
// the log line below and then thrown away; this hands them back instead.
static DispenseResult executeDispenseTrigger(AppState &state, int pumpIdx) {
    auto current_time = std::chrono::steady_clock::now();

    if (std::chrono::duration_cast<std::chrono::milliseconds>(
            current_time - g_last_pump_start).count() < g_pump_start_cooldown_ms) {
        // Logged, as V1 did. Returning silently swallowed the press: the
        // button edge is already consumed, so nothing fires until it is
        // released and pressed again, and nothing said why.
        log_info("pump", "Slot " + std::to_string(pumpIdx) + ": DENIED  reason=cooldown"
                  "  (another pump started under "
                  + std::to_string(g_pump_start_cooldown_ms) + "ms ago)");
        return DispenseResult::COOLDOWN;
    }

    PumpState  &pump    = pumps[pumpIdx];
    Product    &product = productMap[pumpIdx];
    int         pump_pin = pin_pump[pumpIdx];

    int activePumps = 0;
    for (int i = 1; i <= TOTAL_SLOTS; i++)
        if (pumps[i].timer > current_time) activePumps++;

    bool atleast2PumpOn = (activePumps >= 2);
    bool pumpAlreadyOn  = (pump.timer > current_time);
    bool isSlotEmpty    = state.slotEmpty[pumpIdx];
    bool isMachinePaused = state.paused;

    // A press during a prime would consume the credit, extend the prime's
    // timer, and then reach the completion branch as a prime -- which writes
    // no transaction. The customer would get product for free and the sale
    // would never exist. Deny instead: the credit is untouched, and the burst
    // is over in a few seconds.
    if (state.armedQty[pumpIdx] > 0 && !pump.isPriming &&
        (!atleast2PumpOn || pumpAlreadyOn) &&
        !isSlotEmpty && !isMachinePaused) {

        state.armedQty[pumpIdx]--;
        state.slotBusy[pumpIdx] = true;
        state.phase = TxnPhase::DISPENSING;
        pump.armedUnitsReserved++;
        pump.amount += product.coins;
        pump.pressAmounts.push_back(product.coins);

        int ms = (int)(product.durationSeconds * 1000);
        std::chrono::milliseconds extension(ms);
        if (current_time >= pump.timer)
            pump.timer = current_time + extension;
        else
            pump.timer += extension;

        pump.postPressDeadline = current_time + extension + std::chrono::seconds(30);
        g_last_pump_start = current_time;
        // Reset timeout for all armed slots — any press extends the session
        for (int j = 1; j <= TOTAL_SLOTS; j++) {
            if (state.armedQty[j] > 0) pumps[j].armTimestamp = current_time;
        }
        digitalWrite(pump_pin, PUMP_TRIGGER_HIGH);
        saveStateToDisk(state, state.transactionDir);

        log_info("pump", "Slot " + std::to_string(pumpIdx) + ": ACCEPTED"
                  "  armedQty=" + std::to_string(state.armedQty[pumpIdx])
                  + "  reserved=" + std::to_string(pump.armedUnitsReserved)
                  + "  run_ms=" + std::to_string(ms));
        return DispenseResult::OK;
    }

    DispenseResult refusal =
        isMachinePaused ? DispenseResult::MACHINE_PAUSED :
        isSlotEmpty     ? DispenseResult::SLOT_EMPTY     :
        pump.isPriming  ? DispenseResult::PRIMING        :
        (atleast2PumpOn && !pumpAlreadyOn) ? DispenseResult::MAX_ACTIVE :
        DispenseResult::NO_CREDIT;
    log_info("pump", "Slot " + std::to_string(pumpIdx) + ": DENIED  reason="
              + dispense_result_text(refusal)
              + "  armedQty=" + std::to_string(state.armedQty[pumpIdx]));
    return refusal;
}

// Defined below, beside the prime record it mirrors.
static void appendInterruptedLog(AppState &state, int slot, double amount,
                                 const std::string &reason);

// Defined below, beside the commands that made the distinction necessary.
static bool pourIsOpen(const PumpState &pump);

// A pour that closes for any reason -- finished, dry tank, jam refund, pause
// timeout -- must not leave pause bookkeeping behind. The next pour on this
// slot would start with its limit part-used and its deadlines frozen at stale
// remainders.
static void clearPauseState(PumpState &pump)
{
    pump.isPaused                     = false;
    pump.pausedTotalMs                = 0;
    pump.remainingTimeWhenPaused      = 0;
    pump.postPressRemainingWhenPaused = 0;
}

// A slot that stops being busy must take its next queued ARM with it.
// ARM queues rather than arms while slotBusy is set, so any path that clears
// the flag without draining the queue strands credits a cashier already took
// money for. Returns true if armedQty changed and needs persisting.
static bool releaseSlot(AppState &state, int id)
{
    state.slotBusy[id] = false;
    if (state.pendingQueue[id].empty()) return false;

    PendingArm next = state.pendingQueue[id].front();
    state.pendingQueue[id].pop();
    state.armedQty[id] += next.qty;
    log_info("pump", "Slot " + std::to_string(id)
              + ": dequeued pending  qty=" + std::to_string(next.qty));
    return true;
}

// ------------------------------------------------------------------------------
// Per-pump state machine
// ------------------------------------------------------------------------------
static void handlePump(PumpState &pump, AppState &state) {
    if (state.slotEmpty[pump.id]) {
        if (pump.isPriming) {
            // The sensor read empty mid-prime. Release the slot: priming sets
            // slotBusy, and leaving it set would lock the line out of service
            // until the controller restarts.
            log_info("pump", "Pump " + std::to_string(pump.id) + ": PRIME ABORTED  reason=empty");
            pump.isPriming = false;
            pump.isPumping = false;
            pump.timer = std::chrono::steady_clock::now();
            if (releaseSlot(state, pump.id))
                saveStateToDisk(state, state.transactionDir);
        } else if (pourIsOpen(pump)) {
            // The tank ran dry part-way through a customer's pour. Closing the
            // dispense here rather than just switching the relay off: leaving
            // it open recorded no sale at all, held the slot busy until a
            // refill, and then booked the full amount dated to the refill --
            // or lost it entirely if the controller restarted first. Every one
            // of those outcomes leaves the drawer short with nothing to explain
            // it, and the honest cashier carries the difference.
            //
            // Full price, because that is what the customer was charged. The
            // partial pour is surfaced separately for a person to settle.
            log_info("pump", "Pump " + std::to_string(pump.id)
                      + ": INTERRUPTED  reason=empty  amount="
                      + std::to_string(pump.amount));

            // One record per press, same as a clean finish. The tank ran
            // dry part-way, but every press was paid for, and lumping them
            // into one record would under-count the units sold on top of the
            // short pour somebody already has to settle.
            pump.armedUnitsReserved = 0;
            int postfix = 0;
            for (double pressAmount : pump.pressAmounts)
                writeTransaction(state, pump.id, pressAmount, "", postfix++);
            appendInterruptedLog(state, pump.id, pump.amount, "tank_empty");

            pump.pressAmounts.clear();
            pump.amount = 0;
            pump.isPumping = false;
            pump.postPressDeadline = std::chrono::steady_clock::time_point{};
            // Zero the timer. Left running, remainingTime is still counting
            // down when the tank is refilled, and the completion branch books
            // the same sale a second time.
            pump.timer = std::chrono::steady_clock::now();
            clearPauseState(pump);
            releaseSlot(state, pump.id);
            saveStateToDisk(state, state.transactionDir);
        }
        digitalWrite(pin_pump[pump.id], PUMP_TRIGGER_LOW);
    } else if (state.remainingTime[pump.id] > 0) {
        if (pump.isPaused) {
            pump.isPumping = false;
            digitalWrite(pin_pump[pump.id], PUMP_TRIGGER_LOW);
        } else {
            if (!pump.isPumping)
                log_info("pump", "Pump " + std::to_string(pump.id) + ": RUNNING");
            pump.isPumping = true;
            digitalWrite(pin_pump[pump.id], PUMP_TRIGGER_HIGH);
        }
    } else {
        digitalWrite(pin_pump[pump.id], PUMP_TRIGGER_LOW);
        if (pump.isPriming) {
            // Checked before isPumping: both are true during a prime, and a
            // prime must never fall through to the sale-recording branch.
            log_info("pump", "Pump " + std::to_string(pump.id) + ": PRIME DONE  (no sale recorded)");
            pump.isPriming = false;
            pump.isPumping = false;
            pump.amount = 0;
            if (releaseSlot(state, pump.id))
                saveStateToDisk(state, state.transactionDir);
        } else if (pourIsOpen(pump)) {
            log_info("pump", "Pump " + std::to_string(pump.id) + ": DONE  amount="
                      + std::to_string(pump.amount));
            // One transaction per press. Presses extend a single pour, so
            // this branch runs once no matter how many were made -- writing
            // one lumped record booked five sales as one. The pesos were
            // right, so nothing looked broken, but every count derived from
            // the records was short: the dashboard's press count, and the
            // units-per-slot the cloud reports.
            //
            // Zeroed rather than decremented: the pour is finished, so no
            // press is still in flight. Decrementing by one left the rest
            // reserved for good, and a later jam on this slot refunded the
            // accumulated total into armedQty as free credit.
            pump.armedUnitsReserved = 0;
            int postfix = 0;
            for (double pressAmount : pump.pressAmounts)
                writeTransaction(state, pump.id, pressAmount, "", postfix++);
            pump.pressAmounts.clear();
            pump.amount = 0;
            pump.isPumping = false;
            pump.postPressDeadline = std::chrono::steady_clock::time_point{};
            clearPauseState(pump);
            releaseSlot(state, pump.id);

            saveStateToDisk(state, state.transactionDir);

            if (!state.anyArmed()) {
                state.phase = TxnPhase::COMPLETE;
                state.bundleComplete = true;
                log_info("pump", "BUNDLE COMPLETE — all slots dispensed");
            }
        }
    }
}

// ------------------------------------------------------------------------------
// Public API
// ------------------------------------------------------------------------------
std::vector<int> pump_stuck_buttons() {
    std::vector<int> stuck;
    for (int i = 1; i <= TOTAL_SLOTS; i++)
        if (digitalRead(pin_button[i]) == LOW) stuck.push_back(i);
    return stuck;
}

void pump_reset_state() {
    auto now = std::chrono::steady_clock::now();
    for (int i = 1; i <= TOTAL_SLOTS; i++) {
        pumps[i] = PumpState{};
        pumps[i].id = i;
        pumps[i].timer = now;
    }
    // The start cooldown is pump state too. Leaving it set meant the first
    // press after a reset could be swallowed by a cooldown from before it --
    // and since the button edge is consumed either way, no later press fired
    // until the button was physically released.
    g_last_pump_start = now - std::chrono::seconds(1);
}

int clamp_arm_timeout(const std::string &raw)
{
    int v = 300;
    try {
        v = std::stoi(raw);
    } catch (const std::exception &) {
        log_error("pump", "ARM_TIMEOUT_SECONDS is not a number - using 300");
        return 300;
    }
    if (v < 30)   { log_error("pump", "ARM_TIMEOUT_SECONDS below 30 - using 30");     return 30;   }
    if (v > 1800) { log_error("pump", "ARM_TIMEOUT_SECONDS above 1800 - using 1800"); return 1800; }
    return v;
}

// See the comment on the declaration in pump_control.h: this exists so a
// relative configured path resolves against the same base the dashboard
// uses, instead of against the controller's own working directory.
//
// fs::path::is_absolute() cannot be used for this: on a Windows build it only
// recognises a drive-letter form, so a Unix-style path like "/var/log/x" --
// exactly what config.env holds on the Pi -- comes back "not absolute" when
// the very same test runs on Windows. Both forms are checked by hand instead,
// since this code builds and its tests run on Windows as well as the Pi.
std::string resolve_config_path(const std::string &base, const std::string &value) {
    if (value.empty()) return value;

    bool unixAbsolute = value.front() == '/' || value.front() == '\\';
    bool windowsAbsolute = value.size() >= 3
        && std::isalpha(static_cast<unsigned char>(value[0]))
        && value[1] == ':' && (value[2] == '/' || value[2] == '\\');
    if (unixAbsolute || windowsAbsolute) return value;

    return base + "/" + value;
}

void pump_setup(AppState &state) {
    g_state_ptr = &state;
    pump_reset_state();

    std::string binDir = get_binary_dir();
    auto config = loadEnv(binDir + "/../CONFIG/config.env");

    if (config.count("machineId"))       state.machineId  = config["machineId"];
    if (config.count("vendorId"))        state.vendorId   = config["vendorId"];
    if (config.count("SOCKET_PORT"))     state.serverPort = std::stoi(config["SOCKET_PORT"]);
    else if (config.count("SERVER_PORT"))state.serverPort = std::stoi(config["SERVER_PORT"]);
    if (config.count("TRANSACTION_DIR")) state.transactionDir = config["TRANSACTION_DIR"];
    else state.transactionDir = binDir + "/../transaction";
    if (config.count("PUMP_START_COOLDOWN_MS")) g_pump_start_cooldown_ms = std::stoi(config["PUMP_START_COOLDOWN_MS"]);
    if (config.count("PRIME_SECONDS")) {
        double v = std::stod(config["PRIME_SECONDS"]);
        // Clamped rather than trusted. A typo here runs a pump unattended:
        // too short is useless, too long empties a gallon onto the floor.
        if (v < 0.5)  { log_error("pump", "PRIME_SECONDS below 0.5 - using 0.5"); v = 0.5; }
        if (v > 15.0) { log_error("pump", "PRIME_SECONDS above 15 - using 15");  v = 15.0; }
        g_prime_seconds = v;
    }
    if (config.count("ARM_TIMEOUT_SECONDS"))
        state.armTimeoutSeconds = clamp_arm_timeout(config["ARM_TIMEOUT_SECONDS"]);
    if (config.count("PAUSE_MAX_S"))
        state.pauseMaxSeconds = clamp_pause_max(config["PAUSE_MAX_S"]);

    // Prime events live outside transactionDir on purpose: the uploader sends
    // every file in that directory to the cloud as a sale.
    //
    // Each configured path below is resolved against binDir + "/.." (the repo
    // root) when relative, so a relative value in config.env lands in the
    // same place the dashboard looks for it. See resolve_config_path().
    const std::string repoRoot = binDir + "/..";

    if (config.count("PRIME_LOG")) state.primeLogPath = resolve_config_path(repoRoot, config["PRIME_LOG"]);
    else state.primeLogPath = binDir + "/../logs/prime_events.jsonl";

    if (config.count("INTERRUPTED_LOG")) state.interruptedLogPath = resolve_config_path(repoRoot, config["INTERRUPTED_LOG"]);
    else state.interruptedLogPath = binDir + "/../logs/interrupted_sales.jsonl";

    if (config.count("UNCLAIMED_LOG")) state.unclaimedLogPath = resolve_config_path(repoRoot, config["UNCLAIMED_LOG"]);
    else state.unclaimedLogPath = binDir + "/../logs/unclaimed_credits.jsonl";

    if (config.count("PRICES_FILE")) state.pricesPath = config["PRICES_FILE"];
    else state.pricesPath = binDir + "/../CONFIG/prices.conf";

    if (config.count("PRICE_LOG")) state.priceLogPath = resolve_config_path(repoRoot, config["PRICE_LOG"]);
    else state.priceLogPath = binDir + "/../logs/price_changes.jsonl";

    // Apply config.env pin/calibration overrides BEFORE logging the map,
    // otherwise the startup log reports compiled-in defaults, not real pins.
    init_hardware_config(config);

    // Saved prices last: an edit made on the dashboard must outrank whatever
    // config.env shipped with, or a restart would quietly undo it.
    load_prices_file(state.pricesPath);

    log_info("pump", "6-Slot Independent Logic v4.0");
    for (int i = 1; i <= TOTAL_SLOTS; i++) {
        log_info("pump", "Slot " + std::to_string(i)
            + ": BTN=" + std::to_string(pin_button[i])
            + " PUMP=" + std::to_string(pin_pump[i])
            + " LED=" + std::to_string(pin_led[i])
            + " RUN_MS=" + std::to_string((int)(productMap[i].durationSeconds * 1000))
            + " PRICE=" + std::to_string(productMap[i].coins)
            + (product_calibrated[i] ? "" : "  [UNCALIBRATED]"));
    }

    // An uncalibrated slot is the quietest fault this machine has. The pump
    // runs, the LED lights, the sale records at the right price, the cloud
    // gets its transaction -- and the customer walks away with the wrong
    // amount of liquid, because the pour time came from a different machine's
    // tubing. Nothing else in the system will ever mention it, so it is said
    // here, loudly, on every boot until someone measures the pumps.
    std::string uncal;
    for (int i = 1; i <= TOTAL_SLOTS; i++)
        if (!product_calibrated[i]) uncal += (uncal.empty() ? "" : ",") + std::to_string(i);
    if (!uncal.empty()) {
        log_error("pump", "NOT CALIBRATED: slot(s) " + uncal
                  + " have no calibrateProductN in config.env and are pouring "
                    "compiled-in defaults measured on another machine.");
        log_error("pump", "  Every press on those slots dispenses the wrong volume. "
                          "See docs/INSTALLATION.md section 7b to measure them.");
    }
    log_info("pump", std::string("Water sensor: empty reads ")
        + (WATER_SENSOR_EMPTY_HIGH ? "HIGH" : "LOW")
        + " (WATER_SENSOR_EMPTY_HIGH=" + std::to_string(WATER_SENSOR_EMPTY_HIGH) + ")");
    log_info("pump", "Button hold: " + std::to_string(BUTTON_HOLD_MS)
             + "ms to start a pour (V1 rule)");
    wiringPiSetupGpio();

    // Buttons: V1's setup with the polarity flipped for GND wiring. V1 wired
    // its buttons to 3V3 and pulled them DOWN; these are wired GPIO -> GND, so
    // they are pulled UP and a press reads LOW. Keep gpio=X=ip,pu in
    // /boot/firmware/config.txt as well: wiringPi's pull control has been
    // unreliable on this Debian, and the boot setting holds the line up even
    // if this call does nothing.
    for (int i = 1; i <= TOTAL_SLOTS; i++) {
        pinMode(pin_button[i], INPUT);
        pullUpDnControl(pin_button[i], PUD_UP);
    }

    // Say out loud whether the buttons are actually wired. Until now the
    // controller started silently whatever state they were in, so a dead
    // button was discovered by a customer pressing it and nothing happening --
    // with no line anywhere saying which slot or why.
    {
        std::vector<int> stuck = pump_stuck_buttons();
        if (stuck.empty()) {
            log_info("pump", "Buttons: all " + std::to_string(TOTAL_SLOTS)
                      + " resting HIGH (wiring and pull-ups OK)");
        } else {
            std::string list;
            for (size_t k = 0; k < stuck.size(); k++) {
                if (k) list += ", ";
                list += "BTN" + std::to_string(stuck[k])
                      + " (GPIO" + std::to_string(pin_button[stuck[k]]) + ")";
            }
            log_error("pump", "Button(s) reading LOW with nothing pressed: " + list);
            log_error("pump", "  A resting button must read HIGH. Held down, shorted to "
                              "GND, missing gpio=<pin>=ip,pu in /boot/firmware/config.txt, "
                              "or a peripheral owns the pin.");
            log_error("pump", "  Check with: pinctrl get <pin>   -- want 'ip    pu | hi'");
        }
    }

    // Pumps: OUTPUT, off
    for (int i = 1; i <= TOTAL_SLOTS; i++) {
        pinMode(pin_pump[i], OUTPUT);
        digitalWrite(pin_pump[i], PUMP_TRIGGER_LOW);
    }

    // LEDs: OUTPUT, off
    for (int i = 1; i <= TOTAL_SLOTS; i++) {
        pinMode(pin_led[i], OUTPUT);
        digitalWrite(pin_led[i], LOW);
    }

    if (!state.primeLogPath.empty()) {
        std::string parent = fs::path(state.primeLogPath).parent_path().string();
        if (!parent.empty()) ensureDirectoryExists(parent);
    }
    log_info("pump", "Prime burst: " + std::to_string(g_prime_seconds)
             + "s  log=" + state.primeLogPath);

    if (ensureDirectoryExists(state.transactionDir)) {
        log_info("pump", "Transaction dir: " + state.transactionDir);
        if (loadStateFromDisk(state, state.transactionDir))
            log_info("pump", "Restored armed state from disk");
    }
}

void pump_loop(AppState &state) {
    // No lock needed: main() calls pump_loop() and server_app_loop()
    // sequentially on one thread, and buttons are polled rather than driven by
    // a wiringPi ISR, so nothing here runs concurrently.
    auto current_time = std::chrono::steady_clock::now();

    // 1. Button scan — 4-sample rolling window (80ms debounce).
    //    GPIO conflict (BTN2/LED5 both on GPIO24) was the root cause of
    //    false triggers, not rail sag. Conflict fixed (LED5 → GPIO26).
    //    4 samples is sufficient with 5ms LED stagger.
    static int   sampleBuf[TOTAL_SLOTS + 1][4] = {{0}};
    static int   sampleIdx[TOTAL_SLOTS + 1]   = {0};

    for (int i = 1; i <= TOTAL_SLOTS; i++) {
        int raw = (digitalRead(pin_button[i]) == LOW) ? 1 : 0;
        if (raw && !pumps[i].rawWasLow) pumps[i].pressStartTime = current_time;
        pumps[i].rawWasLow = raw;
        sampleBuf[i][sampleIdx[i]] = raw;
        sampleIdx[i] = (sampleIdx[i] + 1) % 4;

        int sum = 0;
        for (int s = 0; s < 4; s++) sum += sampleBuf[i][s];
        bool pressed = (sum == 4);

        // Restored from V1: a press on an IDLE pump must be held BUTTON_HOLD_MS
        // before it counts; a press on a pump already running goes straight
        // through, so a customer can tap quickly for more.
        //
        // The V2 port kept the fields but tested `isPumping || processingTrigger`
        // one line after setting processingTrigger -- always true -- so every
        // debounced press fired at once. V1 held for relay noise, and V2 then
        // showed exactly that: pumps starting on slots nobody touched, each
        // spending a credit and recording a sale that never poured.
        //
        // ponytail: the hold guards only the press that STARTS a pour. Noise on
        // a slot already running still passes instantly, as it did in V1. If the
        // log shows that, the fix is 10k pull-ups at the header, not a longer
        // hold that breaks fast tapping.
        if (pressed) {
            if (!pumps[i].buttonWasPressedLastFrame) {
                pumps[i].buttonWasPressedLastFrame = true;
                if (pumps[i].isPumping) executeDispenseTrigger(state, i);
                else                    pumps[i].processingTrigger = true;
            }
            if (pumps[i].processingTrigger) {
                auto held = std::chrono::duration_cast<std::chrono::milliseconds>(
                    current_time - pumps[i].pressStartTime).count();
                if (held >= BUTTON_HOLD_MS) {
                    // Keep the press if the cooldown refused it. Clearing the
                    // flag first threw it away: the button is still down, so no
                    // new edge follows, and a customer holding through the
                    // cooldown got nothing until they let go and held again.
                    if (executeDispenseTrigger(state, i) != DispenseResult::COOLDOWN)
                        pumps[i].processingTrigger = false;
                }
            }
        } else {
            if (pumps[i].processingTrigger) {
                // Let go before the hold completed. The duration is logged so
                // noise can be told apart from a customer tapping too lightly.
                auto held = std::chrono::duration_cast<std::chrono::milliseconds>(
                    current_time - pumps[i].pressStartTime).count();
                log_info("pump", "Slot " + std::to_string(i) + ": IGNORED  reason=short_press"
                          "  held=" + std::to_string(held) + "ms  need="
                          + std::to_string(BUTTON_HOLD_MS) + "ms");
            }
            pumps[i].buttonWasPressedLastFrame = false;
            pumps[i].processingTrigger = false;
        }
    }

    // 1b. Track ARM timestamps
    static int prevArmedQty[TOTAL_SLOTS + 1] = {0};
    for (int i = 1; i <= TOTAL_SLOTS; i++) {
        if (state.armedQty[i] > prevArmedQty[i]) {
            pumps[i].armTimestamp = current_time;
        }
        prevArmedQty[i] = state.armedQty[i];
    }

    // 1c. Arm timeout — write off and record expired armed slots
    for (int i = 1; i <= TOTAL_SLOTS; i++) {
        if (state.armedQty[i] > 0 && !state.slotBusy[i]) {
            auto armedFor = std::chrono::duration_cast<std::chrono::seconds>(
                current_time - pumps[i].armTimestamp).count();
            if (armedFor >= state.armTimeoutSeconds) {
                // Queued credits were paid for exactly like the armed ones,
                // so they are counted before the queue is thrown away.
                int lost = state.armedQty[i];
                while (!state.pendingQueue[i].empty()) {
                    lost += state.pendingQueue[i].front().qty;
                    state.pendingQueue[i].pop();
                }

                // This said "refunded" for as long as the code existed, and
                // nothing was ever refunded.
                log_info("pump", "Slot " + std::to_string(i) + ": TIMEOUT  wrote off "
                          + std::to_string(lost) + " credits");
                pump_record_unclaimed(state, i, lost, "timeout");

                state.armedQty[i] = 0;
                saveStateToDisk(state, state.transactionDir);
            }
        }
    }

    // 2. LED outputs with blink (last 10s before the timeout = 1Hz blink)
    for (int i = 1; i <= TOTAL_SLOTS; i++) {
        if (state.armedQty[i] > 0 && !state.slotBusy[i]) {
            auto remaining = state.armTimeoutSeconds
                - std::chrono::duration_cast<std::chrono::seconds>(
                      current_time - pumps[i].armTimestamp).count();
            if (remaining <= 10 && remaining > 0) {
                // Blink every 500ms
                bool on = (std::chrono::duration_cast<std::chrono::milliseconds>(
                    current_time.time_since_epoch()).count() % 1000) < 500;
                digitalWrite(pin_led[i], on ? HIGH : LOW);
            } else {
                digitalWrite(pin_led[i], HIGH);
            }
            if (i > 1) delayMicroseconds(5000);  // stagger
        } else if (state.armedQty[i] > 0 && state.slotBusy[i]) {
            digitalWrite(pin_led[i], HIGH);  // busy = solid on
        } else if (pumps[i].isPriming) {
            digitalWrite(pin_led[i], HIGH);  // priming = solid on, so staff see which line runs
        } else {
            digitalWrite(pin_led[i], LOW);
        }
    }
    delayMicroseconds(3000);  // 3ms rail settle after LED writes
    // 2b. Hold the clock still for a paused pour.
    //
    // Every deadline on a pump is an absolute time compared against now, so a
    // pause that did not touch them let the pour drain away with the relay off:
    // remainingTime reached zero, and because the pause had cleared isPumping
    // the completion branch did not fire, so the pour was abandoned with no
    // sale written -- and the jam timeout then refunded the press. The customer
    // kept what had poured and got their credit back.
    //
    // Rewriting the deadlines themselves, rather than correcting for an offset
    // at each place they are read, keeps every other comparison against
    // pump.timer honest for free: the activePumps rail count, pumpAlreadyOn,
    // and the prime guard all still see a truthful absolute deadline.
    //
    // Written from a stored remainder rather than decremented, so a pause of
    // any length accumulates no drift.
    for (int i = 1; i <= TOTAL_SLOTS; i++) {
        if (!pumps[i].isPaused) continue;
        pumps[i].timer = current_time
                       + std::chrono::milliseconds(pumps[i].remainingTimeWhenPaused);
        pumps[i].postPressDeadline = current_time
                       + std::chrono::milliseconds(pumps[i].postPressRemainingWhenPaused);
    }

    // 3. Remaining times
    for (int i = 1; i <= TOTAL_SLOTS; i++) {
        auto diff = std::chrono::duration_cast<std::chrono::milliseconds>(
            pumps[i].timer - current_time).count();
        state.remainingTime[i] = std::max(0LL, (long long)diff);
    }

    // 4. Pump state machines
    for (int i = 1; i <= TOTAL_SLOTS; i++)
        handlePump(pumps[i], state);

    // 4b. Pause timeout.
    //
    // A customer who walks away mid-pour must not hold a nozzle indefinitely,
    // and must not be handed free product either. Ending the pour the same way
    // a dry tank does: every consumed press recorded at full price -- that is
    // what they were charged -- and surfaced for a person to settle. Presses
    // never consumed were never taken out of armedQty, so they stay as credit
    // with nothing extra to do.
    //
    // This is also what keeps a paused pour away from the jam refund below: the
    // pour is closed here long before postPressDeadline could hand the press
    // back as credit on top of the product that already poured.
    for (int i = 1; i <= TOTAL_SLOTS; i++) {
        PumpState &pump = pumps[i];
        if (!pump.isPaused || !pourIsOpen(pump)) continue;

        long long heldMs = pump.pausedTotalMs
            + std::chrono::duration_cast<std::chrono::milliseconds>(
                  current_time - pump.pauseStartedAt).count();
        if (heldMs < (long long)state.pauseMaxSeconds * 1000) continue;

        log_info("pump", "Pump " + std::to_string(i)
                  + ": PAUSE TIMEOUT  held_ms=" + std::to_string(heldMs)
                  + "  amount=" + std::to_string(pump.amount));

        pump.armedUnitsReserved = 0;
        int postfix = 0;
        for (double pressAmount : pump.pressAmounts)
            writeTransaction(state, i, pressAmount, "", postfix++);
        appendInterruptedLog(state, i, pump.amount, "pause_timeout");

        pump.pressAmounts.clear();
        pump.amount = 0;
        pump.isPumping = false;
        clearPauseState(pump);
        pump.postPressDeadline = std::chrono::steady_clock::time_point{};
        // Zero the timer, as the dry-tank path does. Left running, the
        // completion branch books the same presses a second time.
        pump.timer = current_time;
        digitalWrite(pin_pump[i], PUMP_TRIGGER_LOW);
        releaseSlot(state, i);
        saveStateToDisk(state, state.transactionDir);
    }

    // 5. Jam timeout detection
    for (int i = 1; i <= TOTAL_SLOTS; i++) {
        if (pumps[i].armedUnitsReserved > 0 &&
            pumps[i].postPressDeadline.time_since_epoch().count() > 0 &&
            current_time > pumps[i].postPressDeadline) {
            state.armedQty[i] += pumps[i].armedUnitsReserved;
            log_error("pump", "Slot " + std::to_string(i) + ": JAM TIMEOUT  refunded "
                      + std::to_string(pumps[i].armedUnitsReserved));
            pumps[i].armedUnitsReserved = 0;
            pumps[i].postPressDeadline = std::chrono::steady_clock::time_point{};
            pumps[i].amount = 0;
            // Refunded, not sold -- these presses must not be written as
            // sales by whatever pour comes next on this slot.
            pumps[i].pressAmounts.clear();
            clearPauseState(pumps[i]);
            state.slotBusy[i] = false;
            digitalWrite(pin_pump[i], PUMP_TRIGGER_LOW);
            saveStateToDisk(state, state.transactionDir);
        }
    }

    // 6. Software pause toggle — no physical stop button.
    //    state.paused can be set via socket command or dashboard.
    std::this_thread::sleep_for(std::chrono::milliseconds(20));
}

// ------------------------------------------------------------------------------
// Prime / purge
// ------------------------------------------------------------------------------

// Wrap a value in JSON quotes. These records are written from a handful of
// known fields, none of which contain quotes or backslashes.
static std::string q(const std::string &v) { return "\"" + v + "\""; }

// Append one non-revenue record. A prime dispenses product and books no sale,
// so if it left no trace "I was only priming" would be an unfalsifiable
// excuse and the honest-revenue number would stop being enforceable.
static void appendPrimeLog(AppState &state, int slot, double seconds)
{
    std::ostringstream j;
    j << "{" << q("machine_id") << ":" << q(state.machineId)
      << "," << q("slot")       << ":" << q(std::to_string(slot))
      << "," << q("seconds")    << ":" << seconds
      << "," << q("date_created") << ":" << q(format_current_time()) << "}";
    appendJsonLine(state.primeLogPath, j.str());
}

// A sale that was charged in full but only partly delivered. Not revenue data
// -- the transaction already carries that -- this exists so the event reaches
// a person instead of only a log file nobody reads.
static void appendInterruptedLog(AppState &state, int slot, double amount,
                                 const std::string &reason)
{
    std::ostringstream j;
    j << "{" << q("machine_id") << ":" << q(state.machineId)
      << "," << q("slot")       << ":" << q(std::to_string(slot))
      << "," << q("amount")     << ":" << amount
      << "," << q("reason")     << ":" << q(reason)
      << "," << q("date_created") << ":" << q(format_current_time()) << "}";
    appendJsonLine(state.interruptedLogPath, j.str());
}

// Money is already in the drawer for these. Recording the qty and the price at
// the time means a written-off credit still reconciles against the till later,
// even after prices move.
void pump_record_unclaimed(AppState &state, int slot, int qty, const std::string &reason)
{
    if (qty <= 0) return;

    std::ostringstream j;
    j << "{" << q("machine_id") << ":" << q(state.machineId)
      << "," << q("slot")   << ":" << q(std::to_string(slot))
      << "," << q("qty")    << ":" << qty
      << "," << q("amount") << ":" << (qty * pump_get_price(slot))
      << "," << q("reason") << ":" << q(reason)
      << "," << q("date_created") << ":" << q(format_current_time()) << "}";
    appendJsonLine(state.unclaimedLogPath, j.str());
}

const char *prime_result_text(PrimeResult r)
{
    switch (r) {
        case PrimeResult::STARTED:         return "started";
        case PrimeResult::SLOT_INVALID:    return "invalid_slot";
        case PrimeResult::SLOT_BUSY:       return "slot_busy";
        case PrimeResult::SLOT_EMPTY:      return "slot_empty";
        case PrimeResult::MACHINE_PAUSED:  return "paused";
        case PrimeResult::TOO_MANY_ACTIVE: return "max_active";
    }
    return "unknown";
}

double pump_prime_seconds() { return g_prime_seconds; }

// ------------------------------------------------------------------------------
// Prices
// ------------------------------------------------------------------------------

PriceResult pump_set_price(AppState &state, int slot, int pesos)
{
    if (slot < 1 || slot > TOTAL_SLOTS)  return PriceResult::SLOT_INVALID;
    if (pesos < 0 || pesos > MAX_PRICE)  return PriceResult::PRICE_INVALID;

    // A press books productMap[slot].coins at the moment the button is
    // pressed. Changing the price between arming and pressing would charge the
    // customer one figure and record another, so no sale may be in flight.
    if (state.anyArmed()) return PriceResult::SALE_IN_PROGRESS;

    const int previous = productMap[slot].coins;
    if (!set_product_price(slot, pesos)) return PriceResult::PRICE_INVALID;

    // Audit before persistence: if the write fails we still want the attempt
    // on record, and the operator warned rather than left thinking it saved.
    std::ostringstream j;
    j << "{" << q("machine_id") << ":" << q(state.machineId)
      << "," << q("slot")       << ":" << q(std::to_string(slot))
      << "," << q("from")       << ":" << previous
      << "," << q("to")         << ":" << pesos
      << "," << q("date_created") << ":" << q(format_current_time()) << "}";
    appendJsonLine(state.priceLogPath, j.str());

    log_info("pump", "Slot " + std::to_string(slot) + ": PRICE "
             + std::to_string(previous) + " -> " + std::to_string(pesos));

    if (!save_prices_file(state.pricesPath)) {
        log_error("pump", "Price applied but NOT saved -- it will revert on restart");
        return PriceResult::NOT_SAVED;
    }
    return PriceResult::OK;
}

const char *price_result_text(PriceResult r)
{
    switch (r) {
        case PriceResult::OK:               return "ok";
        case PriceResult::SLOT_INVALID:     return "invalid_slot";
        case PriceResult::PRICE_INVALID:    return "invalid_price";
        case PriceResult::SALE_IN_PROGRESS: return "sale_in_progress";
        case PriceResult::NOT_SAVED:        return "not_saved";
    }
    return "unknown";
}

int pump_get_price(int slot)
{
    if (slot < 1 || slot > TOTAL_SLOTS) return 0;
    return productMap[slot].coins;
}

// ---------------------------------------------------------------------------
// Dispense / pause / resume
// ---------------------------------------------------------------------------
const char *dispense_result_text(DispenseResult r)
{
    switch (r) {
        case DispenseResult::OK:             return "ok";
        case DispenseResult::SLOT_INVALID:   return "invalid_slot";
        case DispenseResult::NO_CREDIT:      return "no_credit";
        case DispenseResult::SLOT_EMPTY:     return "empty";
        case DispenseResult::MAX_ACTIVE:     return "max_active";
        case DispenseResult::PRIMING:        return "priming";
        case DispenseResult::MACHINE_PAUSED: return "machine_paused";
        case DispenseResult::SLOT_PAUSED:    return "slot_paused";
        case DispenseResult::COOLDOWN:       return "cooldown";
    }
    return "unknown";
}

const char *pause_result_text(PauseResult r)
{
    switch (r) {
        case PauseResult::OK:             return "ok";
        case PauseResult::SLOT_INVALID:   return "invalid_slot";
        case PauseResult::NOT_POURING:    return "not_pouring";
        case PauseResult::ALREADY_PAUSED: return "already_paused";
    }
    return "unknown";
}

const char *resume_result_text(ResumeResult r)
{
    switch (r) {
        case ResumeResult::OK:           return "ok";
        case ResumeResult::SLOT_INVALID: return "invalid_slot";
        case ResumeResult::NOT_PAUSED:   return "not_paused";
    }
    return "unknown";
}

int clamp_pause_max(const std::string &raw)
{
    int v;
    try { v = std::stoi(raw); }
    catch (...) {
        log_error("pump", "PAUSE_MAX_S is not a number - using 120");
        return 120;
    }
    if (v < 15)  { log_error("pump", "PAUSE_MAX_S below 15 - using 15");   return 15;  }
    if (v > 600) { log_error("pump", "PAUSE_MAX_S above 600 - using 600"); return 600; }
    return v;
}

// A pour is in flight exactly when presses have been consumed but not yet
// closed out. armedUnitsReserved is incremented only by an accepted trigger
// and zeroed by every close path (clean finish, dry tank, jam refund), so it
// already tracks this and needs no extra flag kept in sync.
//
// isPumping must NOT be used for this: it means "the relay is energised", and
// a pause switches the relay off while the pour is very much still open. The
// two coincided only because nothing ever paused.
static bool pourIsOpen(const PumpState &pump)
{
    return pump.armedUnitsReserved > 0;
}

DispenseResult pump_dispense(AppState &state, int slot)
{
    if (slot < 1 || slot > TOTAL_SLOTS) return DispenseResult::SLOT_INVALID;

    // Refused rather than treated as a resume. A client that has lost track of
    // the slot would otherwise restart a pour under a customer who is not
    // holding their bottle under the nozzle.
    if (pumps[slot].isPaused) return DispenseResult::SLOT_PAUSED;

    return executeDispenseTrigger(state, slot);
}

PauseResult pump_pause(AppState &state, int slot)
{
    if (slot < 1 || slot > TOTAL_SLOTS) return PauseResult::SLOT_INVALID;

    PumpState &pump = pumps[slot];
    if (pump.isPaused)      return PauseResult::ALREADY_PAUSED;
    // A prime is a fixed staff burst, not a customer's pour, and it consumes
    // no credit -- so there is nothing here to hold.
    if (!pourIsOpen(pump))  return PauseResult::NOT_POURING;

    auto now = std::chrono::steady_clock::now();

    // Store what is left of both deadlines. The pour timer is the obvious one;
    // postPressDeadline is the jam-refund timer and is wall-clock too, so
    // leaving it running would refund the press mid-pause and hand the
    // customer the product already poured for free.
    pump.remainingTimeWhenPaused = std::max(0LL,
        (long long)std::chrono::duration_cast<std::chrono::milliseconds>(
            pump.timer - now).count());
    pump.postPressRemainingWhenPaused = std::max(0LL,
        (long long)std::chrono::duration_cast<std::chrono::milliseconds>(
            pump.postPressDeadline - now).count());

    pump.isPaused      = true;
    pump.pauseStartedAt = now;
    digitalWrite(pin_pump[slot], PUMP_TRIGGER_LOW);

    log_info("pump", "Slot " + std::to_string(slot) + ": PAUSED  remaining_ms="
              + std::to_string(pump.remainingTimeWhenPaused));
    return PauseResult::OK;
}

ResumeResult pump_resume(AppState &state, int slot)
{
    (void)state;
    if (slot < 1 || slot > TOTAL_SLOTS) return ResumeResult::SLOT_INVALID;

    PumpState &pump = pumps[slot];
    if (!pump.isPaused) return ResumeResult::NOT_PAUSED;

    auto now = std::chrono::steady_clock::now();
    pump.pausedTotalMs += std::chrono::duration_cast<std::chrono::milliseconds>(
        now - pump.pauseStartedAt).count();

    // The freeze in pump_loop has been holding both deadlines at
    // now + remainder every tick, so simply clearing the flag continues the
    // pour with exactly the measure that was paid for still to run.
    pump.isPaused = false;

    log_info("pump", "Slot " + std::to_string(slot) + ": RESUMED  remaining_ms="
              + std::to_string(pump.remainingTimeWhenPaused)
              + "  paused_total_ms=" + std::to_string(pump.pausedTotalMs));
    return ResumeResult::OK;
}

PrimeResult pump_start_prime(AppState &state, int slot)
{
    if (slot < 1 || slot > TOTAL_SLOTS) return PrimeResult::SLOT_INVALID;
    if (state.paused)                   return PrimeResult::MACHINE_PAUSED;

    // Keep the empty-tank guard. Priming a genuinely dry tank runs the pump
    // against air, which is the thing that damages it. The real case is a
    // freshly refilled gallon, where the sensor already reads full.
    if (state.slotEmpty[slot]) return PrimeResult::SLOT_EMPTY;

    // Only a dispense actually in flight blocks a prime. Armed credits used to
    // block it too, which got the real case exactly backwards: a gallon runs
    // out mid-sale, staff replace it, and the hose now has air in it -- while
    // the waiting customer still holds credits on that very slot. Refusing
    // there meant their next press dispensed air and charged them for it,
    // which is the thing this feature exists to prevent.
    //
    // Safe now because executeDispenseTrigger denies a press while priming, so
    // the two can no longer overlap.
    if (state.slotBusy[slot]) return PrimeResult::SLOT_BUSY;

    auto now = std::chrono::steady_clock::now();
    int activePumps = 0;
    for (int i = 1; i <= TOTAL_SLOTS; i++)
        if (pumps[i].timer > now) activePumps++;
    if (activePumps >= 2) return PrimeResult::TOO_MANY_ACTIVE;

    PumpState &pump = pumps[slot];
    pump.isPriming = true;
    pump.amount    = 0;
    pump.timer     = now + std::chrono::milliseconds((int)(g_prime_seconds * 1000));

    // slotBusy keeps a sale from being armed into the middle of the burst.
    // handlePump clears it when the burst ends or aborts.
    state.slotBusy[slot] = true;
    g_last_pump_start    = now;

    appendPrimeLog(state, slot, g_prime_seconds);
    log_info("pump", "Slot " + std::to_string(slot) + ": PRIME START  run_ms="
             + std::to_string((int)(g_prime_seconds * 1000)));
    return PrimeResult::STARTED;
}

void pump_shutdown() {
    if (g_state_ptr) {
        std::string stateFile = g_state_ptr->transactionDir + "/state.dat";
        std::remove(stateFile.c_str());
    }
    for (int i = 1; i <= TOTAL_SLOTS; i++) {
        digitalWrite(pin_pump[i], PUMP_TRIGGER_LOW);
        digitalWrite(pin_led[i], LOW);
    }
}
