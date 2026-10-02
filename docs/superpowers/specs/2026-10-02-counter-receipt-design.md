# Counter Cash: a Receipt, and Accepting in One Hold

**Date:** 2026-10-02 · **Status:** design approved by the owner (mockups chosen:
thermal receipt; pop-up on the tablet; hold to accept).

## Why

One kiosk has one cashier tablet, and only one order can wait at a time, so
the cashier never needs to scan anything — yet the kiosk shows a QR on "Pay at
the counter", which reads as "scan me", and accepting takes Mark as paid then
Yes. The owner wants the cashier to just accept the cash, and the checkout to
look like a receipt so a printed one can follow later.

## What changes

### Kiosk — "Pay at the counter" (cash orders, `STAFF_TABLET = 1`)

- No QR. Left: the lead "Pay exactly ₱X to the cashier. The machine unlocks
  by itself once they accept it.", a large **Order A-12**, and the countdown
  (unchanged). Right: a **thermal receipt**.
- The receipt: SABON EXPRESS · `<kiosk name>` · Self-service refill; ORDER
  number; the order's date and time (12-hour); each product `name xQTY` and
  its line total at the order's frozen prices; TOTAL; Payment CASH; "Pay at the
  counter"; "Thank you!". Off-white paper, monospace, dashed rules, torn bottom
  edge. Long names wrap; prices never wrap.
- QR demo orders keep their QR (the customer's phone pays). The "Staff at the
  machine? Enter PIN" fallback stays. `STAFF_TABLET = 0` is unchanged.

### One receipt for both screens

`kiosk_server/public/staff/receipt.js` (`window.Receipt.html(order,
kioskName)`) and `receipt.css`, loaded by the kiosk page and the staff page,
so the two always match. Size is set by `font-size` on `.rcpt` (everything in
`em`). `/api/state` gains `kioskName` so the kiosk can print it.

A printer is later and separate: it would print this same data and layout.

### Tablet — the cash-order pop-up

- When a cash order starts waiting and someone is signed in, a pop-up covers
  every section: the receipt, the amount, time left with its bar, a green
  **"Hold · Cash received ₱X"** button, and **Cancel order**. Chime as today;
  the separate "New order" notification is dropped for cash orders (kept for
  QR orders, which get no pop-up).
- **Hold to accept:** the button fills over 1 s while held (pointer, or Space
  / Enter); letting go early empties it and does nothing; a plain click does
  nothing. When full, the order is marked paid exactly as today
  (`/staff/api/orders/paid`, logged with the staff name) — no extra dialog.
- The pop-up closes by itself when the order is paid, cancelled or expired.
  Cancel still asks first (the confirm dialog sits above the pop-up; the
  notifications too).
- The Overview hero's Mark as paid becomes the same hold button (id `w-paid`
  kept). The scanned-order link `/staff/order/A-12` keeps working.

## Testing

`npm test` (a receipt test runs `receipt.js` in a VM; `/api/state` carries
`kioskName`); browser checks: a short hold does nothing, a full hold pays;
the pop-up appears from any section and closes on paid/cancel; a QR order
shows no pop-up; the kiosk shows the receipt for cash and the QR for QR;
layout audit (plain and with an order waiting) and screenshots at 1440 / 1180
and the kiosk at 1920×1080.
