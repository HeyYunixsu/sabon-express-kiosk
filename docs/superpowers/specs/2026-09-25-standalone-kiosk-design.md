# Standalone Kiosk — Design

**Date:** 2026-09-25
**Scope:** a new product: a self-service Sabon Express kiosk with no cashier,
reusing this repo's controller, uploaders and config.

## Goal

A customer walks up to the machine, picks products on a touchscreen, pays by
scanning a QR with whatever e-wallet or bank app they already have, or by
handing cash to a staff member, and dispenses into their own bottle. No cashier
tablet, no cashier driving the sale.

## Decisions

| Question | Decision |
|---|---|
| Payment | **QR Ph** — one QR any wallet or bank app can scan — **and** cash |
| Cash handling | Staff take the money, confirm on the kiosk with a personal PIN |
| Overpayment | None possible — exact amount only, no change, no top-up |
| QR confirmation | Backend creates the payment, kiosk polls it (fast-food kiosk pattern) |
| Product selection | Touchscreen on the machine. No physical buttons |
| Dispensing | Modal with the chosen product, **Dispense Now**, tap to pause/resume |
| Staff tools | Hidden PIN menu on the kiosk itself |
| Repo | New repo, core copied from this one |

## Architecture

The controller already owns the machine and listens on TCP 8080. The cashier
dashboard is only one client of it. The kiosk is a different client, speaking
the same protocol.

```
touchscreen (Chromium kiosk)
   └─ kiosk server (Node, localhost)  ──TCP 8080──▶  controller (C++)  ──▶ pumps, sensors
        └─ backend API (payments, sales upload)
```

Five PM2 processes run on a machine today. Four are unchanged:

| Process | Kiosk | Reason |
|---|---|---|
| `01_Dispenser_Controller` | **Keep**, + 3 commands | Pumps, calibration, credits, sales records |
| `02_Water_Sensors` | **Keep as-is** | Tank empty detection |
| `03_Transaction_Uploader` | **Keep as-is** | Sales upload; the six JSON keys never change |
| `04_Status_Uploader` | **Keep as-is** | Machine health |
| `05_Cashier_Dashboard` | **Replace** → `05_Kiosk_Server` | The only cashier-shaped piece |

## Reuse map

**Copy unchanged:** `controller/` (plus the new commands below), `uploaders/`,
`CONFIG/config.env` + `prices.conf` formats, `install_dependencies.sh`,
`setup_and_run.sh` (process 05 renamed), `kiosk_exit_tool/`, the v2 design
tokens and components (colour tokens, the big confirm dialog, Settings panels,
price editor, prime list, today's sales, air clears, waiting credits).

**Do not copy:** `cashier_dashboard/public/index.html` and `js/app.js` (the dead
v1 dashboard, ~1,600 lines, reachable only at `/v1`), the cart-and-Unlock sale
flow, the staff identity header, `drive-download-*`, `Sabon UI resources/`,
`sabon-express-ui-v2-handoff.md`, `main_exe.log`, `docs/archive/`.

**New:** customer screens, payment step, staff PIN menu, sale session state
machine, attract screen.

## Customer flow

```
ATTRACT ──tap──▶ PICK ──▶ PAY ──paid──▶ UNLOCKED ──▶ POURING ──▶ THANK YOU ──▶ ATTRACT
                            │                            ▲   │
                            └── cash: staff PIN ──────────┘   └── pause/resume
```

1. **Attract.** Products and prices, "Tap to start". Shows a "n presses
   waiting — tap to continue" chip when the machine still owes someone.
2. **Pick.** The existing product cards with + / −, a running total. Offline or
   empty tanks are shown exactly as the dashboard shows them today.
3. **Pay.** Two buttons: *Pay with QR* and *Pay cash to staff*. The QR screen
   names the apps it works with — GCash, Maya, ShopeePay, and bank apps — so
   nobody walks away thinking the machine only takes one wallet.
4. **Unlocked.** A modal per product: product card, **Nozzle n**, a progress
   bar, **Dispense Now**, then tap to pause and tap to resume. The pour stops
   itself at the paid amount. When a product is finished the modal moves to the
   next one.
5. **Thank you**, then back to attract after 10 s.

## Payment rules

- **One reference per sale**, valid `PAYMENT_REF_TTL_S` (default 180 s).
- **The kiosk never decides a payment succeeded.** It polls the backend every
  2 s until the backend reports `paid`.
- **Late payments are honoured.** After a reference expires the kiosk keeps
  polling it for `PAYMENT_WATCH_AFTER_TTL_S` (default 120 s), including on the
  attract screen, and on `paid` it arms and shows "Payment received".
- **A reference can only arm once.** The kiosk records armed references, so a
  repeated `paid` reply cannot grant a second set of presses.
- **Exact amount only.** The QR is created for the cart total; the cash screen
  shows the same figure. Nothing is owed and nothing is returned.
- **No internet: cash only.** The QR button is disabled with a reason. Cash
  and dispensing work fully offline; sales queue and upload later.
- **Provider-agnostic.** The kiosk renders whatever QR payload the backend
  returns and asks that same backend whether it is paid. Changing gateway, or
  adding another wallet, is a backend change and needs no machine visit.
- **Fees are the backend's problem.** The kiosk asks for the cart total and
  treats anything the provider deducts as the merchant's business, so the rule
  "exact payment" holds at the machine.

### Backend contract (work for the API team)

```
POST  {API_BASE_URL}{PAYMENT_CREATE_PATH}
      {machine_id, vendor_id, amount, reference}
   →  {reference, qr_payload, expires_at}          qr_image_url also accepted

GET   {API_BASE_URL}{PAYMENT_STATUS_PATH}/{reference}
   →  {reference, status: pending|paid|expired|failed, amount, paid_at}
```

`qr_payload` is the QR Ph (EMVCo) string, and the kiosk draws it into a QR code
on screen with a small bundled encoder. Drawing it locally means the code
appears instantly and does not depend on an image host; a `qr_image_url` is
accepted as a fallback for a gateway that returns only an image.

The provider's webhook goes to the backend. The Pi holds no payment keys and
needs no inbound connection, and it never learns which wallet was used.

## Controller changes (the only C++ work)

`ARM` already grants presses. With no physical button, three commands are
added, each acknowledged the way `PRIME_ACK` already is:

```
DISPENSE,<slot>   consume one armed unit and start the pour
                  → DISPENSE_ACK,<slot>,<ok|no_credit|busy|empty|offline>
PAUSE,<slot>      stop the pump, keep the pour open
                  → PAUSE_ACK,<slot>,<ok|not_pouring>
RESUME,<slot>     continue the same pour
                  → RESUME_ACK,<slot>,<ok|not_paused>
```

`PumpState` already carries `isPaused`, and the pump loop already switches the
pump off while it is set (`pump_control.cpp:236`). Two gaps to close:

- Nothing sets `isPaused` — the commands above do.
- The countdown is measured against the clock, so a paused pour burns its
  remaining seconds. `remainingTimeWhenPaused` exists and is unused; pause
  stores the remainder there and resume restarts the timer from it.
- `PAUSE_MAX_S` (default 120 s): a pour left paused past this is ended, the
  poured amount is recorded, and the rest stays as credit, so one customer
  cannot hold a nozzle open forever.

Physical button handling stays in the code, unused when no buttons are wired,
so one firmware serves both products.

## Staff tools

- **Entry:** a 3-second press on the logo, then a PIN pad. Closes itself after
  60 s idle.
- **Contents:** prices, priming, today's sales, air clears, waiting credits,
  machine info (machine ID, controller state, IP). These are the existing
  panels, moved across.
- **PINs identify a person.** `config.env` holds `STAFFn_NAME` and
  `STAFFn_PIN_SHA256` (n = 1..6), so the SD card does not carry the PINs. Five
  wrong attempts lock the pad for 60 s, and that is logged.
- **Cash accountability.** Every confirmed payment appends to
  `logs/payments.jsonl`:

```json
{"reference":"K7F3-2026092512","method":"cash","amount":15,
 "staff":"Ana","date_created":"2026-09-25 14:03:11"}
```

  `method` is `cash` or `qr`; a QR row has no `staff`. This is a separate
  local log: the records that upload to the API keep their six fields exactly.

## New config keys

```
STAFF1_NAME, STAFF1_PIN_SHA256 … STAFF6_*
PAYMENT_ONLINE_ENABLED     = 1
PAYMENT_CREATE_PATH        = /api/v1/machine/payment
PAYMENT_STATUS_PATH        = /api/v1/machine/payment
PAYMENT_REF_TTL_S          = 180
PAYMENT_WATCH_AFTER_TTL_S  = 120
KIOSK_IDLE_S               = 60
PAUSE_MAX_S                = 120
```

## Documentation deliverable

Separate from the kiosk build and done first, because the new repo copies from
it:

- **`CLAUDE.md` at this repo's root** — architecture in a page, where each
  thing lives, build/test/deploy, and the rules that cannot be guessed from the
  code: the six sales fields, `config.env` being per-machine and untracked,
  buttons wired to ground needing pull-ups, the damaged pins on the current Pi,
  the PM2 process names, and the liveness rules (silence means offline;
  `connected` is not "machine alive").
- **`docs/SYSTEM_REFERENCE.md` rewritten** — it currently documents the v1
  dashboard being dropped, and numbers two sections 11 and two 12. The rewrite
  covers the v2 dashboard, the tour, air clears, offline detection, and the
  full controller protocol.
- **In the new repo:** the same two files, plus this reuse map, so nobody
  re-adds the cashier by accident.

## Testing

- **Controller (C++, existing suite):** a pour cannot start without armed
  credit; a pause freezes the remaining amount instead of burning it; a resume
  finishes exactly the measure that was paid for; a pause past `PAUSE_MAX_S`
  records what was poured and keeps the rest as credit.
- **Kiosk server (Node `assert`, stub backend):** a reference expires; a late
  payment still arms; the same reference cannot arm twice; a wrong PIN never
  arms; the payment path is skipped entirely when offline.
- **Screens (headless Chrome over the DevTools protocol):** sampled once a
  second against a stub server, the way the dashboard's liveness work was
  checked. Attract → pick → pay → dispense, plus the offline variant.
- **Hardware:** dry runs with cups per nozzle, tank-empty behaviour, and a
  pulled network cable.

## Build order

Each piece is its own spec → plan → implementation cycle.

0. **Documentation** (this repo): `CLAUDE.md` + `SYSTEM_REFERENCE.md`.
1. **Controller commands**: `DISPENSE`, `PAUSE`, `RESUME` + tests.
2. **Kiosk server and customer flow, cash only** — a working kiosk.
3. **Staff PIN menu** — the panels moved across.
4. **QR payment** — last; it waits on the backend team.
5. **Install runbook** for a new kiosk Pi.

## Open questions

- **Touchscreen not chosen.** Size and orientation change every screen layout.
  Decide before piece 2.
- **Backend payment endpoints do not exist yet.** Piece 4 is blocked until they
  do; pieces 0-3 are not.
- **Hygiene.** Wet hands on a touchscreen all day; the enclosure needs a
  wipeable screen and a bottle shelf under the nozzles.

## Out of scope

- Coin or bill acceptors, and any form of change-giving.
- Printed receipts.
- Loyalty, accounts, or prepaid codes.
- Remote kiosk management beyond the status upload that already exists.
