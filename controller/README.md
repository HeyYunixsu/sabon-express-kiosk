# Dispenser Controller

## Executive Summary

The dispenser controller is a C++17 application that runs on a Raspberry Pi and drives a 6-slot liquid dispensing machine. A cashier arms slots from the [cashier dashboard](../cashier_dashboard/), which connects over TCP; the customer then presses the lit button on an armed slot and that slot's pump runs for a calibrated duration. Completed transactions are written as JSON for upload to the cloud API.

There is no coin acceptor and no voucher system. Both were removed when the cashier model replaced them; the `coin_slot` name survived until the directory was renamed to `controller`.

The codebase was systematically refactored across 11 phases:

| Phase | What Changed |
|-------|-------------|
| 1 | Broke up a 1,629-line monolithic `main.cpp` into modules; added Windows mock layer |
| 2 | Removed dead LCD code, fixed a critical bug where `loop()` was never called |
| 3 | Replaced 7 `extern` globals with a single `AppState` struct passed by reference |
| 4 | Collapsed 4× copy-pasted pump blocks into one `handlePump()` + `PumpState` loop |
| 5 | Moved `Product` config to `hardware_config`, moved transaction saving to `transaction` |
| 6 | Build system polish: Linux EXE name, `.PHONY`, `-Wextra`, `make run` target |
| 7 | Input validation, `remainingTime` clamping, SIGTERM graceful shutdown |
| 8 | Extracted hardcoded config to `config.env`, renamed misleading symbols |
| 9 | Moved `voucherQueue` into `AppState`, removed last debug `cout`, `maxCoinCredit` configurable |
| 10 | Structured logging via `log_info()` / `log_error()` with timestamp and module tag |
| 11 | Slot-empty protection: a pump will not run when its water level sensor reports empty |

---

## Overall Architecture

```
controller/
├── main.cpp                  — Entry point: signal handlers, setup, main loop
├── includes/
│   ├── app_state.h           — AppState struct (single shared state, passed by reference)
│   ├── hardware_config.h     — Pin map, relay polarity, Product struct, productMap
│   ├── pump_control.h        — PumpState struct, pump_setup/loop/shutdown declarations
│   ├── transaction.h         — Transaction struct + writeTransaction() declaration
│   ├── voucher_manager.h     — Voucher queue (enqueue, dequeue, total)
│   ├── socket_server.h       — TCP server setup/loop, socket_count_commas()
│   └── utils.h               — loadEnv(), trim(), format_current_time(), ensureDirectoryExists(), log_info/error()
├── src/
│   ├── hardware_config.cpp   — pin_pump map, productMap (pump timing per 5-coin insert)
│   ├── pump_control.cpp      — PumpState machine, processTimer(), handlePump(), interrupt handlers
│   ├── transaction.cpp       — writeTransactionJson(), writeTransaction()
│   ├── voucher_manager.cpp   — Voucher queue implementation
│   ├── socket_server.cpp     — Non-blocking multi-client TCP server, command parser
│   └── utils.cpp             — env file loader, filesystem helpers, time formatter, structured logger
├── mock/                     — Windows stub layer (replaces wiringPi for dev builds)
│   ├── wiringPi.h / .cpp     — GPIO stubs that print [MOCK] output
│   └── wiringPiI2C.h         — I2C stubs
├── tests/
│   ├── test_framework.h      — Minimal CHECK / CHECK_EQ / RUN_TEST / SUITE macros
│   ├── run_tests.cpp         — Test runner entry point
│   ├── test_utils.cpp        — Utils module tests
│   ├── test_voucher.cpp      — Voucher queue tests
│   ├── test_socket_cmd.cpp   — Socket command parsing tests
│   ├── test_mock.cpp         — Mock layer tests
│   ├── test_hardware.cpp     — Hardware config tests
│   ├── test_transaction_json.cpp       — JSON transaction writing
│   ├── test_app_state.cpp       — AppState defaults and mutation
│   ├── test_product_config.cpp       — productMap values and pump timing
│   ├── test_transaction_write.cpp       — writeTransaction reads from AppState
│   ├── test_module_linkage.cpp       — Build layout and module linkage sentinels
│   ├── test_input_validation.cpp       — Input validation, credit cap, remainingTime clamp
│   ├── test_config_loading.cpp       — Config extraction, ensureDirectoryExists, no debug stdout
│   ├── test_armed_state.cpp       — Per-slot armed state and pending queues
│   ├── test_logging.cpp      — log_info/log_error stream routing, timestamp format
│   └── test_socket_integration.cpp — Full TCP server integration tests (18 cases)
│   fixtures/
│       └── test.env          — Fixture env file for utils tests
├── CONFIG/
│   └── config.env            — Runtime configuration (gitignored; see config.env.sample)
└── Makefile                  — OS-aware build (Windows mock vs Linux wiringPi)
```

### Data flow

```
Cashier arms a slot from the dashboard
    -> ARM / ARM_BATCH over TCP                     [socket_server.cpp]
    -> state.armedQty[slot] += qty, slot LED lit

Customer presses that slot's button
    -> button scan (80ms debounce)                   [pump_control.cpp]
    -> idle pump: held BUTTON_HOLD_MS (100ms) first; running pump: instant
    -> executeDispenseTrigger(slot)
    -> checks: armedQty[slot] > 0 AND !slotEmpty[slot] AND !paused
    -> PumpState.timer set, pump relay driven ON

pump_loop() [every 1 ms from the main loop]
    -> handlePump() for each of the 6 slots         [pump_control.cpp]
    -> drives the relay from the timer, stops early if the slot runs empty
    -> calls writeTransaction() when the pump finishes

server_app_loop() [every 1 ms alongside pump_loop]
    -> parses commands from connected TCP clients:  [socket_server.cpp]
        ARM / ARM_BATCH        - arm one slot or a whole sale
        CANCEL / CANCEL_ALL / CANCEL_QUEUE
        WTRLVL,<v1..v6>        - per-slot water level from the sensor script
        STATUS (or anything unrecognised) - returns current machine state
```

### Socket protocol

| Command | Format | Effect |
|---------|--------|--------|
| Arm one slot | `ARM,<slot>,<qty>` | Adds `qty` units to that slot and lights its LED |
| Arm a sale | `ARM_BATCH,<slot>,<qty>,...` | Arms several slots as one transaction |
| Cancel a slot | `CANCEL,<slot>` | Clears that slot's armed quantity |
| Cancel everything | `CANCEL_ALL` | Clears every slot |
| Cancel queued | `CANCEL_QUEUE,<slot>` | Drops that slot's pending queue only |
| Water level | `WTRLVL,<v1>..<v6>` | Sets the per-slot empty flag. Which level means empty is set by `WATER_SENSOR_EMPTY_HIGH`; a legacy 4-value form is still accepted |
| Status poll | `STATUS` | Returns the 34-field `STATUS,...` line (5 x TOTAL_SLOTS + 4) |
| Start a pour | `DISPENSE,<slot>` | Consumes one armed unit and starts or extends that slot's pour - what one button press does. Answers `DISPENSE_ACK,<slot>,<ok\|no_credit\|empty\|max_active\|priming\|machine_paused\|slot_paused\|cooldown\|invalid_slot>` |
| Hold a pour | `PAUSE,<slot>` | Switches the pump off but keeps the pour open, freezing its countdown. Answers `PAUSE_ACK,<slot>,<ok\|not_pouring\|already_paused\|invalid_slot>` |
| Continue a pour | `RESUME,<slot>` | Continues from exactly the remainder the pour had when it stopped. Answers `RESUME_ACK,<slot>,<ok\|not_paused\|invalid_slot>` |

`DISPENSE`, `PAUSE` and `RESUME` exist for the kiosk, which has no buttons.
Physical button handling is unchanged and still present, so one firmware serves
both products.

Two refusals are easy to confuse and are deliberately separate tokens:
`machine_paused` is the machine-wide `paused` flag that staff control, while
`slot_paused` is that slot's own pour being held by the customer. A `DISPENSE`
on a paused slot is refused rather than treated as a resume - a client that has
lost track of the slot would otherwise restart a pour under someone who is not
holding their bottle under the nozzle.

A pour left paused longer than `PAUSE_MAX_S` (total across every pause, not per
pause) is ended the same way a tank running dry ends one: full price for every
press consumed, a row in `INTERRUPTED_LOG` with `reason: "pause_timeout"`, and
presses never started left as credit.

All commands are validated (comma count checked) before parsing; malformed messages are logged and dropped.

### Slot-empty protection

Before triggering a pump, `processTimer()` checks `state.slotEmpty[pumpIdx]`. If the water level sensor for that slot reports empty (`true`), the pump is not activated even if the slot is armed, and the armed quantity is not consumed. This prevents the machine from dispensing air when a soap container runs out.

The `slotEmpty` flags are set by `water_level_monitoring.py` (in `/uploaders`) via the `WTRLVL` socket command, and reflected back to clients in the `STATUS` response.

---

## Dependencies and Libraries

### Runtime (Raspberry Pi)

| Library | Purpose | Install |
|---------|---------|---------|
| **WiringPi** | GPIO and I2C control | Built from source via `install_dependencies.sh` |
| **C++17 stdlib** | `std::filesystem`, `std::chrono`, `std::thread` | Included with GCC 8+ |
| **POSIX sockets** | TCP server | Included with Linux libc |

### Development (Windows)

| Tool | Purpose | Install |
|------|---------|---------|
| **MSYS2 MinGW64** | GCC toolchain for Windows | https://www.msys2.org — then `pacman -S mingw-w64-x86_64-gcc` |
| **GNU Make** | Build system | `pacman -S make` in MSYS2 |
| **ws2_32** | Windows sockets (Winsock2) | Bundled with MinGW64 |
| **mock/wiringPi** | GPIO stubs for Windows builds | Included in this repo under `mock/` |

---

## Install / Setup

### On Raspberry Pi (production)

Use the top-level install scripts from the repo root:

```bash
chmod +x install_dependencies.sh
./install_dependencies.sh

chmod +x setup_and_run.sh
./setup_and_run.sh 2>&1 | tee setup_run.log
```

`install_dependencies.sh` installs WiringPi, FLTK, Node.js, PM2, and journalctl.
`setup_and_run.sh` builds all C++ projects, sets up Python venvs, and registers all PM2 processes.

To set up manually:

1. **Create the config file**
   ```bash
   mkdir -p CONFIG
   cp ../CONFIG/config.env.sample CONFIG/config.env
   # Edit CONFIG/config.env: set vendorId, machineId, SERVER_PORT, TRANSACTION_DIR
   ```

2. **Build**
   ```bash
   make
   # Produces: main  (no .exe on Linux)
   ```

   `setup_and_run.sh` registers the binary with PM2 as `01_Dispenser_Controller`; there is no
   systemd unit to install.

### On Windows (development)

1. **Install MSYS2** from https://www.msys2.org

2. **Open MinGW64 terminal** and install tools:
   ```bash
   pacman -S mingw-w64-x86_64-gcc make
   ```

3. **Clone the repository** and navigate to `controller/`

4. **Build** (mock layer is used automatically):
   ```bash
   make
   # Produces: main.exe
   ```

---

## How to Run / Activate

### Raspberry Pi — PM2 (via setup_and_run.sh)

The `controller` binary is registered as PM2 process **`01_Dispenser_Controller`**. To manage it:

```bash
sudo pm2 status                   # show all processes
sudo pm2 restart 01_Dispenser_Controller          # restart
sudo pm2 logs 01_Dispenser_Controller             # tail logs
```

### Raspberry Pi — manual run

```bash
cd /home/dgsi/Desktop/dispenser/controller
./main
```

The process reads `CONFIG/config.env` on startup, binds TCP on the configured port (default `8080`), sets up GPIO interrupt handlers for all 6 pumps, then enters the main loop.

### Raspberry Pi — PM2

```bash
sudo pm2 restart 01_Dispenser_Controller          # restart the controller
sudo pm2 logs 01_Dispenser_Controller             # follow logs
sudo pm2 stop 01_Dispenser_Controller             # SIGTERM; all pumps turn OFF before exit
```

### Windows — quick run

```bash
make run
```

GPIO calls are intercepted by the mock layer and print `[MOCK]` output to stdout.

---

## How to Test

Tests run on Windows using the mock WiringPi layer. They do **not** require a Raspberry Pi.

### Run all tests

```bash
# From MinGW64 terminal inside controller/
make test
```

Output format:

```
Coin Slot Unit Tests
====================
[utils] PASS test_trim_basic
...
[phase10 (structured logging)] PASS test_log_info_goes_to_stdout
...
====================
Results: 95 passed, 0 failed
```

A non-zero exit code means at least one test failed.

### Test suites

| Suite | File | What it covers |
|-------|------|---------------|
| `utils` | `test_utils.cpp` | `trim()`, `loadEnv()`, `format_current_time()`, `ensureDirectoryExists()` |
| `voucher` | `test_voucher.cpp` | Voucher queue enqueue/dequeue/total |
| `socket_cmd` | `test_socket_cmd.cpp` | Command parsing, `socket_count_commas()` |
| `mock` | `test_mock.cpp` | Mock wiringPi stubs compile and run without crash |
| `hardware` | `test_hardware.cpp` | `pin_pump` map, relay polarity constants |
| `phase2` | `test_transaction_json.cpp` | JSON transaction file writing |
| `phase3` | `test_app_state.cpp` | `AppState` defaults, field mutation, independence |
| `phase4` | `test_product_config.cpp` | `productMap` values and millisecond timing derived from `durationSeconds` |
| `phase5` | `test_transaction_write.cpp` | `writeTransaction()` reads `machineId`/`vendorId` from `AppState`, not externs |
| `phase6` | `test_module_linkage.cpp` | Build layout: `tests/fixtures` exists, required headers present |
| `phase7` | `test_input_validation.cpp` | Input validation (comma count), credit cap, `remainingTime` clamp math |
| `phase8` | `test_config_loading.cpp` | `durationSeconds` field, `serverPort`/`transactionDir` defaults, no debug stdout |
| `phase9` | `test_armed_state.cpp` | Per-slot armed state, pending queue FIFO order |
| `phase10` | `test_logging.cpp` | `log_info`/`log_error` stream routing, module tag format, timestamp structure |
| `dispense_commands` | `test_dispense_commands.cpp` | `DISPENSE`/`PAUSE`/`RESUME`: the countdown freezing while paused, the pause limit, and a paused pour never being refunded |
| `socket_integration` | `test_socket_integration.cpp` | Full TCP server integration: 18 end-to-end cases, plus the dispense command acks |

### Clean build artifacts

```bash
make clean
```

Removes all `.o` files, compiled headers (`.gch`), and the test runner binary.
