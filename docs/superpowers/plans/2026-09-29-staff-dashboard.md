# Staff Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the `/staff` page as the dashboard in the owner's reference image, with the data it needs.

**Architecture:** Task 1 adds the numbers to the server (`/staff/api/state` fields and `GET /staff/api/orders`), fully specified with code and tests. Task 2 rebuilds `public/staff/` (HTML, CSS, JS) against the reference image; it is a visual task, so the plan gives the exact structure, element ids, data bindings and behaviour to keep rather than every line of markup. Task 3 documents the two new config keys.

**Tech Stack:** Node ≥ 20 standard library only, `node:test`, plain browser JS/CSS, no build step, no external assets.

**Spec:** `docs/superpowers/specs/2026-09-29-staff-dashboard-design.md`
**Reference image:** `C:\Users\Eventbook-4\Downloads\sabon_express_dispenser-main\Sabon UI resources\UI DESIGN LAYOUT\dashboard staff design 2.png`

**Branch:** `piece-5/staff-dashboard` (from `main`).

## Global Constraints

- Every existing behaviour of the staff page stays: PIN sign-in once per shift, the chime for a new order only, Mark as paid / Cancel with the confirm dialog, the `/staff/order/A-n` QR focus note, the Wi-Fi warning, the QR demo strip and QR orders without Mark as paid, and every staff tool (prices, air clear, credits, needs attention, sales, this machine) with its confirm dialogs and refusal messages.
- No server behaviour changes except the added fields and endpoint in Task 1; sign-in, checks, refusals and logs stay as they are.
- Tablet/laptop only: designed for 1180 px wide and up (the reference is ~1500 px); below that the page scrolls sideways (`min-width: 1180px` on the app shell).
- The kiosk's black and blue: the existing `staff.css` tokens (`--bg #0B0E14`, `--surface #141925`, `--surface-sub #1C2333`, `--ink`, `--ink-2`, `--line`, `--brand #3B6DF0`, `--green`, `--amber`, `--red`), the Helvetica Neue LT webfonts in `/fonts/`. No external fonts, scripts, images or CDNs — the Pi may be offline.
- Pictures only from `/img/` (the Sabon Express logo `/img/sabon-express-logo.png`, products `/img/products/1.webp`–`6.webp`); icons are inline SVG.
- Every string from the server or the logs that goes into `innerHTML` goes through `esc()`.
- Node standard library only. Never commit `CONFIG/config.env`.

---

### Task 1: Server — the dashboard's numbers

**Files:**
- Modify: `kiosk_server/server.js`
- Test: `kiosk_server/tests/staff_dashboard.test.js` (create)

**Interfaces (produces, used by Task 2):**
- `GET /staff/api/state` gains:
  - `kiosk: { name: string, location: string }`
  - `stats: { today: { paid, cancelled, sales, hourly: { paid: number[24], cancelled: number[24], sales: number[24] } }, yesterday: { paid, cancelled, sales } }` — `paid`/`cancelled` count closed orders (cancelled includes expired) by their `closed` time; `sales` sums **cash** payments (`isCash`) by `date_created`.
  - `status: { pumpsReady, pumps, empty: string[] (product names), paused: boolean, cashReady: boolean, uploadQueue: number, lastSynced: string|null }`
  - `waitingCredits: number`
  - `today.orders[]` rows gain `method` (`'cash'` when absent).
- `GET /staff/api/orders` → `{ orders: [row…] }`, closed in the last 7 days (today and the 6 before), newest first, at most 200; each row `{ number, amount, status, reason, by, closed, method }`.

- [ ] **Step 1: Write the failing tests**

Create `kiosk_server/tests/staff_dashboard.test.js`:

```js
'use strict';
// The staff dashboard's numbers: kiosk card, stats, status, 7-day orders.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { stamp } = require('../lib/records');
const { until, stubController, startKiosk } = require('./helpers');

async function kiosk(t, opts) {
  const stub = await stubController();
  const k = await startKiosk(stub, opts);
  t.after(() => { k.close(); stub.close(); });
  const r = await k.post('/staff/api/login', { pin: '4821' });
  const headers = { cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
  return { stub, k, headers };
}
function writeRows(k, rel, rows) {
  const f = path.join(k.dir, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}
const day = (offset = 0) => stamp(new Date(Date.now() - offset * 86400000)).slice(0, 10);
const state = async (k, headers) => (await k.get('/staff/api/state', headers)).body;

test('kiosk card: name defaults to Kiosk <letter>, location empty', async (t) => {
  const { k, headers } = await kiosk(t);
  assert.deepStrictEqual((await state(k, headers)).kiosk, { name: 'Kiosk A', location: '' });
});

test('kiosk card: KIOSK_NAME and KIOSK_LOCATION from config', async (t) => {
  const { k, headers } = await kiosk(t, { config: ['KIOSK_NAME = Front Kiosk', 'KIOSK_LOCATION = Main Building · Floor 1'] });
  assert.deepStrictEqual((await state(k, headers)).kiosk, { name: 'Front Kiosk', location: 'Main Building · Floor 1' });
});

test('stats: today against yesterday, today by hour, cash only in sales', async (t) => {
  const { k, headers } = await kiosk(t);
  const ord = (d, time, status) => ({ reference: `${d.replace(/-/g, '')}-A-1`, amount: 10, status, closed: `${d} ${time}` });
  writeRows(k, 'logs/orders.jsonl', [
    ord(day(1), '15:00:00', 'paid'),
    ord(day(0), '09:15:00', 'paid'),
    ord(day(0), '10:20:00', 'paid'),
    ord(day(0), '10:40:00', 'cancelled'),
    ord(day(0), '11:05:00', 'expired'),
  ]);
  writeRows(k, 'logs/payments.jsonl', [
    { method: 'cash', amount: 10, date_created: `${day(0)} 09:15:00` },
    { method: 'cash', amount: 5, date_created: `${day(0)} 10:20:00` },
    { method: 'qr_demo', amount: 20, date_created: `${day(0)} 10:30:00` },
    { amount: 7, date_created: `${day(1)} 15:00:00` },
  ]);
  const { stats } = await state(k, headers);
  assert.deepStrictEqual([stats.today.paid, stats.today.cancelled, stats.today.sales], [2, 2, 15]);
  assert.deepStrictEqual(stats.yesterday, { paid: 1, cancelled: 0, sales: 7 });
  assert.strictEqual(stats.today.hourly.paid.length, 24);
  assert.deepStrictEqual([stats.today.hourly.paid[9], stats.today.hourly.paid[10], stats.today.hourly.cancelled[10], stats.today.hourly.cancelled[11]], [1, 1, 1, 1]);
  assert.deepStrictEqual([stats.today.hourly.sales[9], stats.today.hourly.sales[10]], [10, 5]);
});

test('status: pumps, empty tanks, upload queue, last synced sale', async (t) => {
  const { stub, k, headers } = await kiosk(t);
  stub.empty[2] = 1;
  await until(() => k.ctrl.status.slots[2].empty);
  fs.mkdirSync(path.join(k.dir, 'transaction'), { recursive: true });
  for (const n of ['1_transaction_1_0.json', '2_transaction_1_1.json', 'state.dat']) {
    fs.writeFileSync(path.join(k.dir, 'transaction', n), '{}');
  }
  writeRows(k, `logs/sales/sales-${day(0).slice(0, 7)}.jsonl`, [
    { slot: '1', amount: 5, date_created: `${day(0)} 08:00:00` },
    { slot: '1', amount: 5, date_created: `${day(0)} 08:30:00` },
  ]);
  const { status } = await state(k, headers);
  assert.deepStrictEqual(status, {
    pumpsReady: 5, pumps: 6, empty: ['Product 3'], paused: false, cashReady: true,
    uploadQueue: 2, lastSynced: `${day(0)} 08:30:00`,
  });
});

test('waiting credits count and today rows carry the method', async (t) => {
  const { k, headers } = await kiosk(t);
  writeRows(k, 'logs/unclaimed_credits.jsonl', [
    { slot: '3', qty: 2, amount: 20, reason: 'timeout', date_created: `${day(0)} 09:00:00` },
  ]);
  writeRows(k, 'logs/orders.jsonl', [
    { reference: `${day(0).replace(/-/g, '')}-A-1`, amount: 10, status: 'paid', by: 'Ana', closed: `${day(0)} 09:00:00` },
    { reference: `${day(0).replace(/-/g, '')}-A-2`, amount: 10, status: 'paid', by: 'QR demo', method: 'qr', closed: `${day(0)} 09:05:00` },
  ]);
  const s = await state(k, headers);
  assert.strictEqual(s.waitingCredits, 1);
  assert.deepStrictEqual(s.today.orders.map((o) => [o.number, o.method]), [['A-2', 'qr'], ['A-1', 'cash']]);
});

test('GET /staff/api/orders: last 7 days, newest first, signed in only', async (t) => {
  const { k, headers } = await kiosk(t);
  const ord = (offset, n) => ({ reference: `${day(offset).replace(/-/g, '')}-A-${n}`, amount: 5, status: 'paid', by: 'Ana', closed: `${day(offset)} 12:00:00` });
  writeRows(k, 'logs/orders.jsonl', [ord(8, 1), ord(6, 2), ord(1, 3), ord(0, 4)]);
  assert.strictEqual((await k.get('/staff/api/orders')).code, 401);
  const r = await k.get('/staff/api/orders', headers);
  assert.strictEqual(r.code, 200);
  assert.deepStrictEqual(r.body.orders.map((o) => [o.number, o.closed.slice(0, 10)]), [['A-4', day(0)], ['A-3', day(1)], ['A-2', day(6)]]);
  assert.strictEqual(r.body.orders[0].method, 'cash');
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `cd kiosk_server && node --test tests/staff_dashboard.test.js`
Expected: FAIL (`kiosk`, `stats`, `status`, `waitingCredits` undefined; `/staff/api/orders` 404).

- [ ] **Step 3: Constants and config**

In `server.js`, after `const CREDIT_DAYS = 7;` add:

```js
const ORDER_DAYS = 7;      // how far back the dashboard's order list looks
```

After the `KIOSK_LETTER` block (after `const letter = letterValid ? letterRaw : 'A';` and its warning `if`), add:

```js
  // The staff dashboard's kiosk card.
  const kioskName = (config.KIOSK_NAME || '').trim() || `Kiosk ${letter}`;
  const kioskLocation = (config.KIOSK_LOCATION || '').trim();
```

- [ ] **Step 4: Order rows, stats, status**

Replace `todaySummary()` (from `function todaySummary() {` to its closing `}`) with:

```js
  // One closed order as the staff page lists it.
  const orderRow = (o) => ({
    number: String(o.reference).split('-').slice(1).join('-'),
    amount: Number(o.amount) || 0, status: o.status, reason: o.reason, by: o.by, closed: o.closed,
    method: o.method || 'cash',
  });

  function todaySummary() {
    const pays = readJsonl(paymentsLog).filter(onToday('date_created')).filter(isCash);
    return {
      paid: pays.length,
      total: pays.reduce((a, p) => a + (Number(p.amount) || 0), 0),
      orders: readJsonl(ordersLog).filter(onToday('closed')).slice(-20).reverse().map(orderRow),
    };
  }

  const dayOf = (offset) => stamp(new Date(Date.now() - offset * 86400000)).slice(0, 10);
  const hourOf = (d) => Number(String(d).slice(11, 13)) || 0;

  // The dashboard's cards: a day's closed orders and cash, and that day by
  // the hour for the sparklines. Cancelled counts expired too -- both are
  // orders that did not become a sale.
  function dayStats(d) {
    const hourly = { paid: Array(24).fill(0), cancelled: Array(24).fill(0), sales: Array(24).fill(0) };
    let paid = 0;
    let cancelled = 0;
    let sales = 0;
    for (const o of readJsonl(ordersLog)) {
      if (!String(o.closed || '').startsWith(d)) continue;
      if (o.status === 'paid') { paid++; hourly.paid[hourOf(o.closed)]++; }
      else { cancelled++; hourly.cancelled[hourOf(o.closed)]++; }
    }
    for (const p of readJsonl(paymentsLog)) {
      if (!String(p.date_created || '').startsWith(d) || !isCash(p)) continue;
      const a = Number(p.amount) || 0;
      sales += a;
      hourly.sales[hourOf(p.date_created)] += a;
    }
    return { paid, cancelled, sales, hourly };
  }

  function dashboardStats() {
    const { hourly: _unused, ...yesterday } = dayStats(dayOf(1));
    return { today: dayStats(dayOf(0)), yesterday };
  }

  // The dashboard's Kiosk Status list. uploadQueue is the sales still waiting
  // in TRANSACTION_DIR for the uploader; lastSynced is the newest sale the
  // cloud has confirmed this month (the uploader's archive).
  function kioskStatus() {
    const slots = ctrl.status ? ctrl.status.slots : [];
    let uploadQueue = 0;
    try { uploadQueue = fs.readdirSync(logs.transactions).filter((n) => n.endsWith('.json')).length; } catch (_) { /* none yet */ }
    const archive = readJsonl(path.join(logs.salesArchive, `sales-${dayOf(0).slice(0, 7)}.jsonl`));
    return {
      pumpsReady: slots.filter((s) => !s.empty).length,
      pumps: SLOTS,
      empty: slots.filter((s) => s.empty).map((s) => products[s.slot - 1].name),
      paused: !!(ctrl.status && ctrl.status.paused),
      cashReady: staff.length > 0,
      uploadQueue,
      lastSynced: archive.length ? archive[archive.length - 1].date_created || null : null,
    };
  }
```

In `staffState()` add, after `qrDemo,`:

```js
      kiosk: { name: kioskName, location: kioskLocation },
      stats: dashboardStats(),
      status: kioskStatus(),
      waitingCredits: openCredits(readJsonl(logs.unclaimed), readJsonl(staffLog), creditSince()).length,
```

`creditSince` is defined after `staffState()`, as a `const` arrow; it is only called when `staffState()` runs (per request), long after module setup, so the order is fine.

- [ ] **Step 5: The orders endpoint**

In `staffRoutes`, after the `/staff/api/tools` route add:

```js
      if (req.method === 'GET' && url === '/staff/api/orders') {
        const since = dayOf(ORDER_DAYS - 1);
        const rows = readJsonl(ordersLog).filter((o) => String(o.closed || '') >= since);
        return json(res, 200, { orders: rows.slice(-200).reverse().map(orderRow) });
      }
```

- [ ] **Step 6: Run the tests to see them pass**

Run: `cd kiosk_server && node --test tests/staff_dashboard.test.js` → 6 PASS.
Run: `cd kiosk_server && npm test` → every test passes (98 existing + 6).

- [ ] **Step 7: Commit**

```bash
git add kiosk_server/server.js kiosk_server/tests/staff_dashboard.test.js
git commit -m "feat(staff): dashboard numbers — kiosk card, stats, status, 7-day orders"
```

---

### Task 2: The dashboard page

**Files:**
- Rewrite: `kiosk_server/public/staff/index.html`, `kiosk_server/public/staff/staff.css`, `kiosk_server/public/staff/staff.js`

**Interfaces:**
- Consumes: `GET /staff/api/me`, `POST /staff/api/login|logout`, `GET /staff/api/state` (1 s poll; Task 1 fields plus `online, machine, pending, today{paid,total,orders}, qrDemo`), `GET /staff/api/order?number=`, `POST /staff/api/orders/paid|cancel`, `GET /staff/api/tools` (3 s poll while a tools section is open), `POST /staff/api/price|prime|credits/give-back|credits/write-off`, `GET /staff/api/orders`.

This task is visual. **Open the reference image first and match it**: proportions, card shapes (rounded ~20px, 1px line borders, subtle blue glow on the active nav item and the hero), icon circles on the stat cards and status rows, the badge pills in the table, the two-column Overview (main column ~70%, right column ~30%). Start from the current three files (read them fully): all of the behaviour and every helper in `staff.js` must survive — move and restyle, do not drop.

- [ ] **Step 1: Structure (`index.html`)**

Two top-level states: the sign-in screen (`#v-login`, centred card with PIN dots and keypad — keep `#l-dots`, `#l-msg`, `#l-keypad [data-k]`, `#l-go`) and the app shell (`#app`, hidden until signed in):

```
#app  (grid: sidebar 240px | main)
├─ aside.d-side
│   ├─ brand: <img src="/img/sabon-express-logo.png"> + "Staff Dashboard" + small "Sabon Express"
│   ├─ nav#s-nav  buttons [data-view="overview|transactions|health|inventory|settings"] with inline SVG icons;
│   │             labels: Overview, Transactions, Kiosk Health, Inventory, Settings; .on on the current one
│   └─ .d-sys#s-sys  "System Online|Offline" dot + date · time (updated every second)
└─ main.d-main
    ├─ header.d-top
    │   ├─ .d-kiosk: small product/kiosk icon, #k-name, chip #s-state (Online / Dispensing / Offline, dot colour),
    │   │            #k-loc (pin icon + location; hidden if empty)
    │   └─ right: #s-me "Staff: <name>", #s-out "Sign out"
    ├─ #s-demo  amber strip "QR DEMO ON — QR payments are pretend, no real money" (hidden unless state.qrDemo)
    ├─ section#v-overview
    │   ├─ .d-grid (main | right)
    │   │   main:
    │   │    ├─ #w-card  (hero) — two modes:
    │   │    │    idle:    #h-kicker "TODAY'S PERFORMANCE", #h-title, #h-text, #h-updated "Last updated: …",
    │   │    │             .h-art (the six product webps overlapping, right side, soft blue glow)
    │   │    │    waiting: #w-title ("Waiting for payment" | "Waiting for QR payment (demo)"), #w-num "Order A-27",
    │   │    │             #w-items (rows: photo, name, × qty, line price), #w-total, #w-timer "2:41 left to pay"
    │   │    │             (+ thin draining bar), #w-paid "Mark as paid · ₱15" (hidden for QR), #w-cancel "Cancel order"
    │   │    │    keep #w-body (waiting content wrapper), #w-empty (idle content wrapper), #w-msg (message line)
    │   │    ├─ .d-kpis: 4 cards #k-sales, #k-paid, #k-pending, #k-cancel — icon circle (₱ blue, check green,
    │   │    │    clock amber, × red), label, big value, delta line, sparkline <svg> (polyline over 24 hourly points,
    │   │    │    cumulative, area fill with low opacity)
    │   │    └─ .d-card Recent Orders: title with list icon, switch [data-range="today|7d"] (Today / 7 Days),
    │   │         table: Order | Amount | Status | Staff | Time (7 Days adds the date: "Sep 28 · 10:36");
    │   │         keep #t-list as the <tbody> and #t-sum (e.g. "3 paid · ₱35") in the card footer,
    │   │         footer link "View all transactions →" → Transactions
    │   right:
    │    ├─ .d-card Kiosk Status (shield icon): rows #st-conn, #st-pay, #st-pump, #st-water, #st-sync —
    │    │    icon circle, title, sub-line, right: dot + word (green OK / amber / red)
    │    ├─ .d-card Quick Actions (bolt icon): 2×2 tiles → Transactions, Inventory & Prices (→ inventory),
    │    │    Air Clear (→ health, scroll to it), Waiting Credits (→ inventory, scroll to it; badge #q-credits)
    │    └─ .d-banner "Smarter Kiosk. Better Service." — or, when needs-attention entries exist today,
    │         "N pours need attention today" linking to Kiosk Health
    ├─ section#v-transactions: Today's sales card (#x-sales-sum, #x-sales, #x-cash) and the full order
    │     table (same component as Recent Orders, own switch, up to 200 rows)
    ├─ section#v-health: Kiosk Status list (same rows, larger), Needs attention (#x-attention), Air clear (#x-prime-sec, #x-primes)
    ├─ section#v-inventory: Stock per tank (6 product cards: photo, name, "Has stock"/"Empty" badge),
    │     Prices (#x-prices rows, #x-price-log), Waiting credits (#x-credit-sum, #x-credits)
    └─ section#v-settings: This machine (#x-machine)
#x-busy (amber note) shown at the top of Health and Inventory when a tool is refused for now
#dlg, #dlg-title, #dlg-text, #dlg-no, #dlg-yes — the one confirm dialog (centred, blurred backdrop)
#x-msg — the toast
```

- [ ] **Step 2: Behaviour (`staff.js`)**

- Keep from the current file, unchanged in meaning: `api()`, `esc()`, `peso()`, `chime()`, the sign-in keypad and lockout messages, `poll()` (1 s, 401 → sign-in screen, network → Wi-Fi warning in `#w-msg`), `lookup()`/`focusNote` for `/staff/order/A-n`, `ask()` dialog, `PAID_MSG`, the Mark as paid and Cancel handlers, `loadTools()` / `renderTools()` / `put()` / `toast()` / `TOOL_MSG` / `BUSY_MSG` and every tools click handler (prices with dirty-edit protection, air clear with the cup confirm, give back / write off).
- Sections: `showView(name)` hides all `#v-*` sections but one, sets `.on` in `#s-nav`; remembers the section in `sessionStorage` (wrapped in try/catch). Tools polling runs while `transactions`, `health`, `inventory` or `settings` is open (those use `/staff/api/tools`); stop it on `overview`. Overview needs only `/staff/api/state`.
- Hero: `pending` present → waiting mode (chime when a new number appears, as now); else idle mode with title from state: offline → "Kiosk is Offline" (red accent, text "The kiosk is not answering. Check that it is switched on."), any `status.empty` → "A tank is empty" (amber, text "<names> — refill, then run an air clear."), `machine === 'dispensing'` → "Dispensing…" (text "A customer is pouring."), else "Kiosk is Running Smoothly" (text "All systems are normal. Ready for orders."). `#h-updated` = time of the last good poll.
- Stat cards from `stats`: values `peso(today.sales)`, `today.paid`, `pending ? 1 : 0`, `today.cancelled`; delta vs yesterday as `↑ 60% vs. yesterday` / `↓ …` / `— same as yesterday` / `new today` when yesterday is 0 and today > 0; Total Sales sub-line "N orders"; Pending sub-line "No pending" or "Order A-27". Sparklines: cumulative sums of the 24 hourly values up to the current hour, drawn as SVG polyline + area.
- Recent Orders: Today → `state.today.orders` (latest 5 on Overview, all on Transactions); 7 Days → `GET /staff/api/orders` (fetched when switched to, and every 10 s while shown). Status badge: Paid (green), Cancelled (red, reason in the title attribute), Expired (grey). Staff column: `by`, or `customer` for a customer cancel, `QR demo` for method qr. Left edge colour bar per status as in the reference.
- Kiosk Status rows from `online`, `status`, `qrDemo`: Device Connection (Online/Offline); Payment ("Cash ready" + ", QR demo on" / "No staff PINs set up" red); Pump Status ("n/6 pumps ready", "Paused" amber when `status.paused`); Water Level ("Normal level" / "Empty: <names>" red); Last Sync ("All sales uploaded" green when `uploadQueue` 0, else "<n> sales waiting to upload" amber; sub-line "Last confirmed <HH:MM>" from `lastSynced`, or "None this month").
- `#q-credits` badge = `waitingCredits` (hidden at 0).
- Sidebar `#s-sys`: "System Online" green / "System Offline" red from `online`; date and clock every second.
- The page title stays `Sabon Express · Staff`.

- [ ] **Step 3: Styles (`staff.css`)**

Keep the tokens and fonts at the top of the current file; replace the rest. App shell `min-width: 1180px`. Match the reference: dark navy gradient background with a faint blue glow top-right, cards `--surface` with `--line` border, radius 20px, 24px gaps; active nav item filled `--brand` gradient with glow; stat-card icon circles 52px; table rows 56px with 3px left status bar; badges as pills with a leading icon; hero 220px tall min, gradient from `--surface` to a deep blue, product art on the right. Tap targets ≥ 44px. The confirm dialog and toast keep working (dialog centred over a blurred backdrop).

- [ ] **Step 4: Check**

Run: `cd kiosk_server && node --check public/staff/staff.js && npm test` → no syntax error, all pass. Then load `/staff` at 1440×900 against a running server (see the coordinator's live check) and compare with the reference image; fix anything that does not match before committing.

- [ ] **Step 5: Commit**

```bash
git add kiosk_server/public/staff
git commit -m "feat(staff): dashboard layout — sidebar, hero, stat cards, orders, kiosk status"
```

---

### Task 3: Documentation

**Files:** `CONFIG/config.env.sample`, `CONFIG/README.md`, `CLAUDE.md`

- [ ] **Step 1: `CONFIG/config.env.sample`** — after the `KIOSK_LETTER = A` line add:

```
# Shown on the staff dashboard's kiosk card. Optional.
#KIOSK_NAME     = Kiosk A
#KIOSK_LOCATION = Main Building · Floor 1
```

- [ ] **Step 2: `CONFIG/README.md`** — in the Kiosk server table, after the `KIOSK_LETTER` row add:

```
| `KIOSK_NAME` | `Kiosk <KIOSK_LETTER>` | Name on the staff dashboard's kiosk card |
| `KIOSK_LOCATION` | empty | Where the kiosk stands, shown under its name on the staff dashboard |
```

- [ ] **Step 3: `CLAUDE.md`** — in "Where things live", change the `kiosk_server/public/staff/` row's description to `The staff dashboard (tablet/laptop): Overview, Transactions, Kiosk Health, Inventory, Settings`.

- [ ] **Step 4: Commit**

```bash
git add CONFIG/config.env.sample CONFIG/README.md CLAUDE.md
git commit -m "docs: staff dashboard config keys"
```
