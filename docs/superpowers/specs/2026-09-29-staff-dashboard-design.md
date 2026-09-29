# Staff Dashboard — Design

**Date:** 2026-09-29
**Status:** Approved by the owner.
**Reference:** `../sabon_express_dispenser-main/Sabon UI resources/UI DESIGN LAYOUT/dashboard staff design 2.png`

The `/staff` page becomes a dashboard in the layout of the reference image,
in the kiosk's black and blue. Same features as today (sign-in, mark paid,
cancel, the staff tools), reorganised; a few new numbers.

## Owner decisions

- The waiting order **takes over the hero** banner (with the chime); with no
  order waiting the hero shows the kiosk's state.
- The sidebar sections **map today's tools** (below).
- **Tablet/laptop only**: designed for 1180 px and wider; narrower screens
  scroll sideways.

## Layout

- **Sidebar**: Sabon Express logo + "Staff Dashboard"; Overview,
  Transactions, Kiosk Health, Inventory, Settings; bottom card "System
  Online / Offline" with date and time.
- **Top bar**: kiosk card — name (`KIOSK_NAME`, default `Kiosk <KIOSK_LETTER>`),
  Online/Offline chip, location (`KIOSK_LOCATION`, hidden if unset); right:
  "Staff: <name>" and Sign out. A permanent amber strip when `QR_DEMO` is on.
- **Overview**:
  - Hero. No order: "TODAY'S PERFORMANCE" + "Kiosk is Running Smoothly" /
    "Kiosk is Offline" / "Dispensing…" / "A tank is empty", a line of detail,
    "Last updated", the six product bottles as the picture. Order waiting:
    "ORDER A-27 · WAITING FOR PAYMENT", items, total, countdown, **Mark as
    paid ₱15** and **Cancel**; a QR demo order says "Waiting for QR payment
    (demo)" and has no Mark as paid.
  - Four stat cards with a sparkline of today by hour: Total Sales Today
    (cash), Paid Orders, Pending Orders (0/1), Cancelled (cancelled +
    expired); each against yesterday.
  - Recent Orders table (Order, Amount, Status badge, Staff, Time), Today /
    7 Days switch, "View all transactions →".
  - Kiosk Status: Device Connection, Payment (cash ready; QR demo), Pump
    Status (n/6 ready), Water Level (Normal / which tank is empty), Last Sync
    (sales waiting to upload to the cloud; last sale the cloud confirmed).
  - Quick Actions: Transactions, Inventory & Prices, Air Clear, Waiting
    Credits (count badge).
- **Transactions**: today's sales per product, cash per staff, the order list
  with Today / 7 Days.
- **Kiosk Health**: the status list, Needs attention, Air clear.
- **Inventory**: stock per tank, Prices + history, Waiting credits.
- **Settings**: machine ID, controller, staff page address, QR demo on/off.

## Server additions

`/staff/api/state` adds `kiosk {name, location}`, `stats` (today and
yesterday: paid, cancelled, cash sales; today by hour), `status` (pumps
ready, empty tanks, paused, cash ready, upload queue, last synced sale),
`waitingCredits`; today's order rows gain `method`. New `GET
/staff/api/orders` → the last 7 days of closed orders, newest first. New
optional config keys `KIOSK_NAME`, `KIOSK_LOCATION`. Nothing else changes:
sign-in, checks, refusals and logs stay as they are.

## Testing

Server tests for every new field and the orders endpoint. The page keeps the
element ids the existing browser checks use (`#w-*` waiting order, `#t-*`
today list, `#x-*` tools, `#l-*` sign-in, `#dlg*`); a live run against the
real controller with screenshots compared to the reference.
