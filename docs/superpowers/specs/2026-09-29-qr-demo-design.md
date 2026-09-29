# QR Payment Demo — Design

**Date:** 2026-09-29
**Status:** Approved by the owner. For demos only; the real QR Ph payment
(build piece 4) still waits on the backend's payment endpoints.

## What it is

A pretend QR Ph payment, switched on with `QR_DEMO = 1` in `config.env` (off
by default). The customer taps QR Ph, the kiosk shows a QR, a phone on the
same Wi-Fi scans it and taps **Pay**, and the kiosk unlocks. No money moves.

This breaks rule 3 of `CLAUDE.md` ("the kiosk never decides that a payment
succeeded") on purpose, which is why it only exists behind the switch, says
DEMO on every screen, and the server logs "QR DEMO MODE" at startup.

## Kiosk

- With `QR_DEMO = 1` the **QR Ph** tile on "How would you like to pay?" is
  enabled: "Scan with your phone (demo)". With no Wi-Fi address it stays
  disabled: "Needs Wi-Fi". Without `QR_DEMO` it stays "Coming soon".
- Tapping it creates a normal order marked `method: 'qr'` (same pricing,
  freezing, one-waiting-order, 3-minute expiry, cancel as counter cash).
- The order screen, for a QR order: title "Scan to pay", lead "Scan the code
  with your phone camera and pay exactly ₱15.", the QR encodes
  `http://<pi-lan-ip>:<KIOSK_PORT>/pay/<number>`, a "DEMO — no real money"
  hint, the countdown and Cancel order. No staff PIN link.
- Paid → the dispense screen, as for cash.

## Phone

`/pay/A-27` — a small page styled like an e-wallet: a "DEMO — no real money is
taken" banner, the items, the total and **Pay ₱15**. Tapping it shows
"Payment successful ✓". An order no longer waiting says what happened
(paid, expired, cancelled) and has no Pay button.

## Server

- Orders carry `method` (`cash` default, or `qr`). `/api/order` takes
  `method: 'qr'`, refused `400 qr_off` without `QR_DEMO`, `503 no_network`
  without a Wi-Fi address.
- `GET /pay/api/order?number=` → the order (public fields); `POST
  /pay/api/confirm {number}` → `confirmPaid()` (the same five checks as
  cash), only for the waiting **QR** order. `payments.jsonl` records
  `method: 'qr_demo'`, `staff: 'QR demo'`, `via: 'phone'`. Sales are recorded
  by the controller as usual (owner's choice).
- A QR order cannot be marked paid as cash: the staff tablet's Mark as paid and
  the kiosk PIN refuse it (`409 qr_order`); staff can still cancel it.
- From the shop Wi-Fi, `/pay/*` answers only when `QR_DEMO = 1`. The server
  listens on the Wi-Fi when `STAFF_TABLET` or `QR_DEMO` is on.
- `orders.jsonl` rows gain `method`.

## Staff tablet

A waiting QR order shows as "Waiting for QR payment (demo)" with no Mark as
paid button; Cancel order stays.

## Testing

Server tests: QR order paid via `/pay/api/confirm` arms and logs `qr_demo`;
`/pay` is 404 and `method: 'qr'` refused when `QR_DEMO` is off; a cash order
cannot be paid through `/pay`; a QR order cannot be marked paid by staff or
the kiosk PIN; an expired order cannot be paid; the Wi-Fi reaches `/pay` only
in demo mode. End to end: real controller, kiosk page and a phone page in
headless Chrome — QR Ph, scan URL, Pay, pour.
