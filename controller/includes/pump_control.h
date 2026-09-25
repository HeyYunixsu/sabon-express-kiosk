#ifndef PUMP_CONTROL_H
#define PUMP_CONTROL_H

#include "app_state.h"
#include <vector>

// Parses ARM_TIMEOUT_SECONDS and clamps it to 30..1800. Returns 300 for
// anything unparseable. Exposed so the clamp can be tested without a
// config.env on disk.
int clamp_arm_timeout(const std::string &raw);

// Resolves a configured log/data path against `base` unless it is already
// absolute. setup_and_run.sh runs the controller with cwd = <repo>/controller,
// so a relative value stored verbatim resolves (via ordinary file I/O) against
// that directory -- while the dashboard resolves the very same config key
// against the repo root with path.resolve(__dirname, '..', value). With an
// absolute path, or the key left unset, both agree; with a relative path they
// silently diverge: the controller writes happily, the dashboard's
// fs.existsSync() on its own resolved path comes back false, and a panel like
// Needs Attention stays empty forever with no error anywhere. An empty
// `value` (key not configured) is returned unchanged so callers can still
// fall back to their own default. Exposed for testing without a config.env.
std::string resolve_config_path(const std::string &base, const std::string &value);

// Initialise GPIO, ISRs, load config.env into state, create transaction dir.
void pump_setup(AppState &state);

// One iteration of the pump state machine — call every loop tick.
void pump_loop(AppState &state);

// Turn all pumps OFF (call before exit).
void pump_shutdown();

// ---------------------------------------------------------------------------
// Prime / purge
//
// Replacing an empty gallon lets air into the hose, so the next customer press
// dispenses air and still charges them. Priming runs one pump for a short
// fixed burst to push that air through.
//
// A prime moves product and records NO sale, which is exactly what a
// dishonest cashier would want, so every prime is appended to a non-revenue
// log instead of vanishing. See docs/superpowers/plans/ Task 6.
// ---------------------------------------------------------------------------
enum class PrimeResult {
    STARTED,
    SLOT_INVALID,
    SLOT_BUSY,        // armed, mid-dispense, or has queued credits
    SLOT_EMPTY,
    MACHINE_PAUSED,
    TOO_MANY_ACTIVE   // two pumps already running — same rail limit as dispensing
};

// Start a prime burst on `slot`. Never writes a transaction.
PrimeResult pump_start_prime(AppState &state, int slot);

// Short machine-readable token for a result, for logs and the PRIME_ACK line.
const char *prime_result_text(PrimeResult r);

// Burst length in seconds, as configured by PRIME_SECONDS.
double pump_prime_seconds();

// ---------------------------------------------------------------------------
// Prices
//
// Set per client from the dashboard rather than compiled in. A change alters
// what every future sale is worth, so each one is written to an append-only
// audit log and persisted immediately.
// ---------------------------------------------------------------------------
enum class PriceResult {
    OK,
    SLOT_INVALID,
    PRICE_INVALID,
    SALE_IN_PROGRESS,   // credits are armed; the price a customer paid is owed
    NOT_SAVED           // applied in memory but the file write failed
};

PriceResult pump_set_price(AppState &state, int slot, int pesos);
const char *price_result_text(PriceResult r);
int pump_get_price(int slot);

// Records credits that were paid for but never dispensed. reason is "timeout"
// or "cancelled". Called from the socket server as well as the pump loop.
void pump_record_unclaimed(AppState &state, int slot, int qty, const std::string &reason);

// Slots whose button is NOT resting HIGH -- i.e. reading as pressed with
// nobody touching it. Empty means all six are healthy.
//
// One read catches every way the button wiring goes wrong except one: a
// missing `gpio=N=ip,pu` in config.txt, a peripheral holding the pin (GPIO14
// is UART TXD, GPIO10 is SPI0 MOSI), a switch shorted across same-side
// tactile legs, or a genuinely held button. The exception is a button wired
// to 3V3 instead of GND: the pull-up holds that pin HIGH at rest and the
// press drives it HIGH too, so it looks perfect here and simply never fires.
// `tools/test_buttons` is what catches that one, by watching for the press.
//
// Call after pump_setup() has set the pin modes.
std::vector<int> pump_stuck_buttons();

// Return every pump to its power-on state. pump_setup() calls this; tests call
// it to get a clean slate, because pump state lives in module statics that
// would otherwise leak between cases.
void pump_reset_state();

#endif // PUMP_CONTROL_H
