#ifndef APP_STATE_H
#define APP_STATE_H

#include <string>
#include <queue>
#include "hardware_config.h"

struct PendingArm {
    int productId;
    int qty;
    PendingArm(int id = 0, int q = 0) : productId(id), qty(q) {}
};

// Transaction-level state machine (non-blocking, millis()-driven)
enum class TxnPhase {
    IDLE,        // no transaction active, all LEDs off
    ARMED,       // one or more slots armed, LEDs lit, buttons live
    DISPENSING,  // at least one slot currently pumping
    COMPLETE     // all armed slots finished — bundle complete, trigger 7th indicator
};

struct AppState {
    // Per-slot armed quantity (indices 1..TOTAL_SLOTS)
    volatile int armedQty[TOTAL_SLOTS + 1] = {0};

    // Per-slot busy flag — true while a slot is mid-dispense
    bool slotBusy[TOTAL_SLOTS + 1] = {false};

    // Per-slot pending queue — ARM requests waiting while slot is busy
    std::queue<PendingArm> pendingQueue[TOTAL_SLOTS + 1];

    // Transaction-level phase
    TxnPhase phase = TxnPhase::IDLE;

    // Bundle complete: true when all armed slots reached 0 after a batch ARM
    bool bundleComplete = false;

    std::string machineId = "1";
    std::string vendorId;

    // Configurable at runtime from config.env
    int serverPort = 8080;
    std::string transactionDir = "../transaction";

    // Where prime/purge events are appended. Deliberately NOT inside
    // transactionDir: the uploader treats every file in there as a sale to
    // send to the cloud, and a prime is explicitly not a sale.
    std::string primeLogPath;

    // Saved prices, rewritten whenever someone edits them on the dashboard.
    std::string pricesPath;

    // Dispenses cut short by an empty tank. Charged in full because the
    // customer was, but the pour was partial, so a person has to see it.
    std::string interruptedLogPath;

    // Credits a customer paid for that never became product -- expired or
    // cancelled. Outside transactionDir on purpose: the uploader POSTs every
    // file in there as a sale, which would book these as revenue.
    std::string unclaimedLogPath;

    // Append-only record of every price change. A price edit changes what
    // every future sale is worth, so it must never be silent.
    std::string priceLogPath;

    // How long an armed credit stays live before it is written off. The button
    // is physically live for this whole window, so a generous timeout is free
    // product for whoever walks up to an unattended machine. Five minutes is
    // the owner's call, 2026-09-04: long enough to fill several containers.
    int armTimeoutSeconds = 300;

    long long remainingTime[TOTAL_SLOTS + 1] = {0};  // index 1-6
    // true = that slot's tank is empty, which blocks arming and stops a
    // running pump. Set from WTRLVL; which GPIO level counts as empty is
    // configurable via WATER_SENSOR_EMPTY_HIGH.
    bool slotEmpty[TOTAL_SLOTS + 1] = {false};        // index 1-6
    bool paused = false;

    // Returns true if any slot is armed (armedQty > 0 or busy)
    bool anyArmed() const {
        for (int i = 1; i <= TOTAL_SLOTS; i++)
            if (armedQty[i] > 0 || slotBusy[i]) return true;
        return false;
    }

    // Returns true if any slot is currently pumping
    bool anyDispensing() const {
        for (int i = 1; i <= TOTAL_SLOTS; i++)
            if (slotBusy[i]) return true;
        return false;
    }

    // Returns number of slots with armedQty > 0 (not yet dispensed)
    int armedCount() const {
        int c = 0;
        for (int i = 1; i <= TOTAL_SLOTS; i++)
            if (armedQty[i] > 0) c++;
        return c;
    }
};

#endif // APP_STATE_H
