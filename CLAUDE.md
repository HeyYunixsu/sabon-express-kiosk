# Sabon Express Kiosk

A self-service version of the Sabon Express soap dispenser. The customer does
everything on a touchscreen on the machine: pick products, pay by QR or hand
cash to a staff member, then dispense into their own bottle. There is no
cashier and no cashier tablet.

This repo was started from the cashier product's machine core. What was taken,
what was left and why is in `docs/REUSE_MAP.md`. The design, and the build
order below, is `docs/superpowers/specs/2026-09-25-standalone-kiosk-design.md`.

**The goal is a working kiosk a customer can use**, on a 15.6" touchscreen in
portrait, **1080×1920**. Design every screen for that size.

## Status

| Piece | What | State |
|---|---|---|
| 1 | Controller `DISPENSE`, `PAUSE`, `RESUME` | **Done**, tested |
| 2 | Kiosk server and customer screens, cash only | **Done**, tested end to end against the real controller; not yet on a Pi |
| 3 | Staff PIN menu | Next |
| 4 | QR payment | Blocked: backend payment endpoints do not exist yet |
| 5 | Install runbook for a kiosk Pi | Last |

Each piece gets its own spec, plan and implementation.

## Commands

```bash
# Controller: build and test (on the Pi)
cd controller && make && make test
```

On Windows, `mingw32-make test` builds but the test binary dies with
`0xC0000139`: another `libstdc++` on the PATH wins. Put the compiler's own
`bin` first:

```bash
PATH="<winlibs>/mingw64/bin:$PATH" ./tests/test_runner.exe
```

```bash
# Kiosk server: tests (Node built-in runner, no dependencies)
cd kiosk_server && npm test

# Staff PIN hash for config.env
node kiosk_server/tools/hash_pin.js 4821

# On a Pi: what is running, and the live logs
sudo pm2 list
sudo pm2 logs 01_Dispenser_Controller
sudo pm2 logs 05_Kiosk_Server
```

### Trying the whole kiosk on a PC

The controller builds against mock GPIO, so the real controller, the kiosk
server and the screens all run on Windows:

1. `CONFIG/config.env` from the sample, plus a `STAFF1_NAME` and
   `STAFF1_PIN_HASH`.
2. `cd controller && mingw32-make`, then run `main.exe` (compiler `bin` first
   on the PATH, as above).
3. `cd kiosk_server && node server.js`.
4. Open `http://localhost:3000/`. The page scales its 1080×1920 stage to fit
   any window, so a tall browser window shows it as the kiosk will.

Sales land in `transaction/` (nothing uploads them unless the uploaders run)
and cash payments in `logs/payments.jsonl`.

## Architecture

```
touchscreen (Chromium, kiosk mode, same Pi)
   └─ kiosk server (Node, localhost:KIOSK_PORT)  ──TCP 127.0.0.1:8080──▶  controller (C++)  ──▶ pumps
        └─ backend API: QR payments                 uploaders ◀── sale files ──┘
                                                        └──▶ backend API: sales, machine health
```

The controller owns the machine and takes commands over TCP. It does not care
who is connected, so the kiosk replaces the cashier dashboard without touching
how the pumps work.

PM2 runs five processes, registered by `setup_and_run.sh`:

| Process | What it is | Source |
|---|---|---|
| `01_Dispenser_Controller` | Pumps, sensors, credits, sale records | `controller/` |
| `02_Water_Sensors` | Tank empty detection | `uploaders/water_level_monitoring.py` |
| `03_Transaction_Uploader` | Sales to the API, with a local queue | `uploaders/transaction_uploader.py` |
| `04_Status_Uploader` | Machine health to the API | `uploaders/status_uploader.py` |
| `05_Kiosk_Server` | Customer screens, cash confirmation, pour control | `kiosk_server/` |

The touchscreen itself is Chromium in kiosk mode, started at desktop login by
`~/.config/autostart/sabon-kiosk.desktop` (installed by `setup_and_run.sh`),
which runs `kiosk_server/launch_browser.sh`.

Ports: controller **8080** (`SOCKET_PORT`), kiosk server **3000**
(`KIOSK_PORT`), both in `CONFIG/config.env`.

## Where things live

| Path | What |
|---|---|
| `controller/src/pump_control.cpp` | Main loop: pours, pause/resume, credits, sale records |
| `controller/src/socket_server.cpp` | TCP protocol and STATUS broadcast |
| `controller/src/hardware_config.cpp` | Pin numbers, calibration, prices |
| `uploaders/` | The three Python services |
| `kiosk_server/server.js` | HTTP routes, state stream, cash sale rules |
| `kiosk_server/lib/controller.js` | TCP client, STATUS parsing, offline rule, `dispensePaid` |
| `kiosk_server/lib/staff.js` | Staff PIN hashing, checking, lockout |
| `kiosk_server/public/` | The screens: `index.html`, `css/kiosk.css`, `js/kiosk.js` |
| `CONFIG/config.env.sample` | Every setting. `CONFIG/README.md` explains each |
| `docs/INSTALLATION.md`, `docs/QUICK_INSTALL.md` | Pi setup. Copied from the cashier product, adapted in piece 5 |
| `kiosk_exit_tool/` | Keyboard shortcut to escape the locked-down browser |

## Controller protocol

Commands, one line each over TCP 8080:
`ARM,<slot>,<qty>`, `ARM_BATCH,<slot>:<qty>,…`, `CANCEL`, `CANCEL_ALL`,
`CANCEL_QUEUE`, `DISPENSE,<slot>`, `PAUSE,<slot>`, `RESUME,<slot>`,
`PRIME,<slot>`, `SETPRICE,<slot>,<pesos>`, `GETPRICES`, `STATUS`, `WTRLVL`.

Replies:

- `STATUS` about twice a second: 34 comma-separated fields for six slots
  (armed, remaining, water, busy, queued, then paused, phase, bundle-complete).
- `DISPENSE_ACK,<slot>,<result>`: `ok`, `no_credit`, `empty`, `max_active`,
  `priming`, `machine_paused`, `slot_paused`, `cooldown`, `invalid_slot`.
- `PAUSE_ACK,<slot>,<result>`: `ok`, `not_pouring`, `already_paused`, `invalid_slot`.
- `RESUME_ACK,<slot>,<result>`: `ok`, `not_paused`, `invalid_slot`.
- `PRICES,…`, `PRIME_ACK`, `PRICE_ACK`.

There is no `offline` result: a controller that is down sends nothing. The
kiosk server must treat **six seconds without a `STATUS` line** as offline,
not a closed or open socket.

## Rules that cannot be guessed from the code

1. **The six sales fields never change.** A sale file holds exactly
   `machine_id`, `vendor_id`, `voucher_id`, `amount`, `slot`, `date_created`
   (`controller/src/transaction.cpp`). The cloud API matches on them.
2. **`CONFIG/config.env` is per-machine and untracked.** It holds the machine
   and vendor IDs. Never commit it or paste its values into a doc or commit
   message. `CONFIG/config.env.sample` is the tracked template.
3. **The kiosk never decides that a payment succeeded.** It asks the backend,
   which is the only side the payment provider talks to. The Pi holds no
   payment keys.
4. **Exact payment only.** No change, no top-up, no balance held for the
   customer.
5. **One sale record per press.** Five presses write five files.
6. **A pause freezes the pour; it does not refund it.** A pour paused longer
   than `PAUSE_MAX_S` in total is ended, charged in full for the presses
   already started, and logged to `INTERRUPTED_LOG` as `pause_timeout`.
7. **A pour that outlives its tank is charged, not refunded.** The controller
   records it at full price and logs it as `tank_empty` for staff to settle.
8. **Pumps are active-low.** `PUMP_TRIGGER_HIGH = 0`, and
   `/boot/firmware/config.txt` holds them off at boot
   (`gpio=6,12,15,16,17,18=op,dh`), or every pump runs during startup.
9. **The water sensor default is fail-safe.** `WATER_SENSOR_EMPTY_HIGH = 1`.
   If every slot reads backwards, flip it in `config.env`, not in code.
10. **Button code stays.** The kiosk has no buttons, but the controller still
    reads them so one firmware serves both products. The pull-up rules in
    `docs/INSTALLATION.md` still apply if buttons are ever wired.
11. **Do not re-add the cashier.** No staff-driven cart-and-unlock flow, no
    cashier dashboard. Staff touch this machine only to confirm a cash payment
    with their PIN and to open the hidden staff menu.

## How the kiosk decides things

- **The server prices the sale, not the page.** `/api/cash` recomputes the
  total from the controller's prices and refuses (`price_changed`) if it
  differs from what the customer was shown.
- **Nothing is queued while offline.** An ARM or DISPENSE held for a reconnect
  could fire hours later with nobody at the machine, so the server refuses.
- **No new sale while the machine owes presses.** Any armed, busy or queued
  slot refuses `/api/cash` (`machine_busy`), plus a 3-second guard after each
  ARM until STATUS shows it.
- **The dispense screen follows STATUS, not the page.** Paid presses on the
  machine always show the dispense screen, so a reload never hides them.
  There is no "tap to continue" on the attract screen; unused presses expire
  at `ARM_TIMEOUT_SECONDS` into `UNCLAIMED_LOG`.
- **The dispense screen is one card per purchased product**, and each tap on
  a card's Dispense pours **one unit** (one `DISPENSE`, retried through the
  controller's 200 ms start cooldown). The card counts units off ("1 of 2
  dispensed") from STATUS against the order the server remembers, so a reload
  keeps the count. One product pours at a time; the pouring card's button is
  Pause/Resume. Done appears when every unit is poured, and the screen
  finishes by itself 20 s later if nobody taps it.
- **Staff PINs are salted scrypt** (`STAFFn_PIN_HASH`), not the spec's
  `STAFFn_PIN_SHA256`: an unsalted SHA-256 of a short PIN is cracked
  instantly.

## Known traps

- **The cloud API port.** `Connection refused` in `03_Transaction_Uploader`
  means `API_BASE_URL` names a port the backend is not listening on, not a
  code fault.
- **Pins that collide.** Serial (14, 15), SPI (7-11) and audio (18, 19) share
  pins with the slot map and must be disabled in `config.txt`;
  `docs/QUICK_INSTALL.md` has the block.

## Hardware

BTN pins: 14, 24, 25, 10, 13, 23 (slots 1-6).
PUMP pins: 15, 16, 6, 17, 18, 12.
LED pins: 5, 27, 4, 22, 19, 7.
Defaults in `controller/src/hardware_config.cpp`, overridable per machine in
`config.env`.

## The cashier product

`../sabon_express_dispenser-main` is the sibling product this was copied from.
Read it for worked examples: settings panels, the confirm dialog, the status
stream, the audit logs, the v2 design tokens. Do not copy its sale flow.

The two share no code, by choice. A `controller/` or `uploaders/` fix has to
be applied in both; copy the change, not the file, and name the source repo
and commit in the commit message.
