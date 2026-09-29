# Counter Cash and the Staff Tablet — Design

**Date:** 2026-09-28
**Status:** Approved by the owner, section by section. Replaces build piece 3
(the hidden staff menu on the kiosk) of `2026-09-25-standalone-kiosk-design.md`.

## Problem

Cash today means a staff member walks to the kiosk and types their PIN on its
screen for every sale. With a line, staff spend the day walking back and forth.
Staff tools (prices, air clears, sales) also need someone at the machine, or a
developer visit.

## Setting

Staff stand at a counter in the same shop, with a phone or tablet on the shop
Wi-Fi. Everything here runs on the kiosk Pi and the shop LAN: no internet, no
backend. Remote access from an office is out of scope (it needs the backend,
like QR payment).

## Build stages

1. **Counter cash** — order screen on the kiosk, staff sign-in, waiting order,
   mark paid, cancel, today's list, kiosk PIN fallback.
2. **Staff tools** — prices, air clears, today's sales, waiting credits,
   needs attention, this machine.

Each stage is planned, built and tested on its own. Stage 2 depends on stage
1's sign-in and page shell.

---

## 1. Kiosk flow

Shop → **Unlock** → "How would you like to pay?" → **Cash** creates a waiting
order on the server and shows **"Pay at the counter"**:

- **The order itself is the big thing:** product photo, name and quantity per
  line, line prices, and the total.
- A **QR code** and, small beside it, the **order number** (`A-27`).
- "Go to the counter and pay exactly ₱15. Staff will unlock the machine for
  you. Or show them a photo of this code."
- **"Waiting for payment · 2:41 left"** with a draining bar.
- **Cancel order**, and a small **"Staff at the machine? PIN"** link.

Behaviour:

- **Paid on the tablet** → the kiosk goes to *Your purchased items* by itself.
- **3 minutes** pass unpaid (`ORDER_PAY_TIMEOUT_S`, default 180) → "Order A-27
  has expired. Nothing was charged." for 5 s, then the start screen.
- **Cancel order** → confirm, then the start screen.
- **Staff at the machine? PIN** → today's PIN pad, confirming *this* order
  through the same checks as the tablet (section 3).
- Nothing is unlocked and no sale is recorded before the order is paid.

**Without the tablet** (`STAFF_TABLET` unset or `0`): Cash goes straight to
today's staff PIN pad on the kiosk. No order screen, no QR.

**The QR** encodes `http://<kiosk-lan-ip>:<KIOSK_PORT>/staff/order/<number>`.
The server finds its own LAN IPv4 address (`os.networkInterfaces()`, first
non-internal); the page draws the code with a small vendored encoder in
`kiosk_server/public/js/` (no npm install, no image service).

**Order number:** `<letter>-<n>`. The letter is `KIOSK_LETTER` (default `A`),
so two kiosks in one shop are told apart; `n` counts orders from 1 each day.
It is small on screen because one kiosk only ever has one waiting order: staff
match the customer by products and total. The number is there to tell apart
two identical orders, for the records, and as the QR's target.

## 2. Staff tablet page

Address `http://<kiosk-ip>:<KIOSK_PORT>/staff`, saved once as a home-screen
icon. `setup_and_run.sh` prints it at the end.

**Sign in once per shift** with a personal staff PIN (`STAFFn_NAME` /
`STAFFn_PIN_HASH`, the existing keys). The PIN alone identifies the person.
Signed in for 12 hours or until **Sign out**; the header always says who.
Five wrong PINs lock the tablet's pad for 60 s. A server restart signs
everyone out.

**Main view:**

- Kiosk state: Ready / Dispensing / Offline.
- **Waiting for payment:** product photos, names, quantities, line prices,
  total, order number, countdown.
- **Mark as paid · ₱15** → "Did you receive ₱15 cash?" **[Yes, received]**
  **[Back]** → "A-27 paid. The kiosk is unlocked."
- **Cancel order** (any signed-in staff) → the kiosk returns to the start.
- New orders appear live, with a short chime.
- **No order waiting:** says so, with the kiosk state.
- **Today:** "14 paid · ₱230" and the recent orders with their outcome.

**Scanning the QR** opens `/staff/order/A-27` in the tablet's browser: the
order if signed in, sign-in first if not. An order no longer waiting shows
what happened ("Expired — do not take payment", "Paid by Ana at 2:14 PM").

The page uses the kiosk's black-and-blue style and works on phones and tablets.

## 3. Server rules

**Lifecycle:** `waiting → paid | expired | cancelled`, with a reason
(`customer`, `staff:<name>`, `out_of_stock`, `price_changed`).

- One waiting order per kiosk. A new order is refused while one waits, while
  any slot is armed, busy or queued, or within the post-ARM guard.
- Items and amount are frozen at creation, priced from the controller (never
  from the page), exactly as `/api/order` does today.
- Expiry is decided at the moment of the request: at or after 180 s, mark paid
  is refused.
- Waiting orders live in memory only. After a server restart they are gone;
  nothing was charged, the kiosk shows the start screen, the tablet says the
  order no longer exists.

**Mark as paid** — checks in this order, stopping at the first failure:

1. The order is `waiting` and not expired → else refused, with its outcome.
2. The controller is online → else **refused, order keeps waiting**: "Machine
   not ready — don't take the cash yet".
3. Every item's slot still has stock → else **cancelled** `out_of_stock`.
4. The controller's prices still equal the frozen prices → else **cancelled**
   `price_changed`.
5. `ARM_BATCH` is sent. If it cannot be sent, refused, order keeps waiting.
   Then the payment is logged, the order becomes `paid`, the kiosk streams
   to dispensing.

The kiosk PIN fallback runs the same five steps.

**Security:**

- `STAFF_TABLET = 1` in `config.env` opens the server on the LAN
  (`0.0.0.0`). Without it the server binds `127.0.0.1` as today, and the
  staff page is unreachable.
- From any address other than the Pi itself, only `/staff*` answers, plus
  `/img/*` and `/fonts/*` (the staff page's pictures and fonts — static
  files, no actions). The kiosk page, its stream, and every customer action
  (`/api/order*`, `/api/dispense`, `/api/pause`, `/api/resume`) return 403.
  Local means the socket's remote address is `127.0.0.1`, `::1` or
  `::ffff:127.0.0.1`.
- Staff sessions: 32 random bytes in a cookie, `HttpOnly; SameSite=Strict`,
  12-hour expiry, held in server memory. Every staff action needs a valid
  session; actions are POSTs with a JSON body.
- Accepted risk: plain HTTP on the LAN, so the PIN crosses the shop Wi-Fi
  unencrypted. The install guide tells shops to put customers on a separate
  guest network.

## 4. Staff tools (stage 2)

| Tool | Behaviour |
|---|---|
| **Prices** | Edit six prices, save with `SETPRICE`. Refused while an order waits or presses are owed (the controller already refuses while armed). History from `PRICE_LOG`; the staff name goes to `staff_events.jsonl`. |
| **Air clears** | Per nozzle: "Put a cup under nozzle 3. Run it for 3 seconds?" → `PRIME,<slot>`; `PRIME_ACK` reported. Refused while an order waits or presses are owed. Today's count per nozzle from `PRIME_LOG`. |
| **Today's sales** | Per product and total, from the sales archive plus what is still queued in `transaction/`; cash taken per staff member from `payments.jsonl`; today's orders from `orders.jsonl`. |
| **Waiting credits** | Entries in `UNCLAIMED_LOG` not yet settled. **Give back** re-arms them (`ARM,<slot>,<qty>`, refused while an order waits or presses are owed), so the kiosk shows the dispense screen for that customer. **Write off** closes the entry. Both logged with the staff name. |
| **Needs attention** | Today's `INTERRUPTED_LOG` entries (`tank_empty`, `pause_timeout`), for staff to settle with the customer. |
| **This machine** | Machine ID, controller online/offline, the tablet address, stock per tank. |

Left out on purpose: theme switch, fullscreen, the first-run tutorial.

## 5. Records

All under `logs/`. The six sales fields sent to the cloud do not change.

| File | One line per | Fields |
|---|---|---|
| `payments.jsonl` (exists) | cash payment | `reference` (`20260928-A-27`), `method` `cash`, `amount`, `items` (`1:2,3:1`), `staff`, `via` (`tablet` / `kiosk_pin`), `date_created` |
| `orders.jsonl` (new) | order, when it closes | `reference`, `items`, `amount`, `status` (`paid` / `expired` / `cancelled`), `reason`, `by`, `created`, `closed` |
| `staff_events.jsonl` (new; replaces `pin_lockouts.jsonl`) | staff action | `event` (`sign_in`, `sign_out`, `pin_locked`, `price_change`, `prime`, `credit_give_back`, `credit_write_off`), `staff`, details, `date_created` |

Dates are `YYYY-MM-DD HH:MM:SS`, local time, as everywhere else.

## 6. New config keys

```
STAFF_TABLET          = 1      # open /staff on the shop Wi-Fi
ORDER_PAY_TIMEOUT_S   = 180
KIOSK_LETTER          = A
```

## 7. Testing

- **Server (Node test runner, stub controller):** order creation rules and
  frozen prices; one waiting order; expiry exactly at 180 s with an injected
  clock; mark paid arms once and logs the staff name; refused after expiry;
  refused while offline with the order still waiting; cancelled on empty tank
  and on a price change; cancel by customer and by staff; sessions required
  and expiring; lockout; a non-local address gets 403 from every customer
  route.
- **Stage 2:** prices and air clears refused while an order waits; air clear
  needs its confirm; give back arms exactly the unclaimed presses.
- **End to end (headless Chrome, real controller on mock GPIO):** kiosk and
  staff page side by side — order on the kiosk, mark paid on the tablet, the
  kiosk dispenses; plus an expiry, a tablet cancel, and the kiosk PIN
  fallback.
- **On a Pi:** a phone on the shop Wi-Fi scans the QR, signs in, marks paid.

## Approaches weighed

- **A. Staff page on the kiosk over the shop Wi-Fi** — chosen: works today,
  offline, no backend.
- **B. Through the cloud backend** — confirm from anywhere, but waits on the
  backend team and stops cash when the internet drops. Revisit with QR
  payment.
- **C. PIN at the kiosk plus an order number** — does not remove the walk.
- Also considered, not in this design: prepaid codes sold at the counter,
  a coin/bill acceptor (for unattended sites), QR Ph (build piece 4).
