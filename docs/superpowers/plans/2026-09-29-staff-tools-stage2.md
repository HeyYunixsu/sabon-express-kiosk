# Staff Tools (Counter Cash Stage 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give signed-in staff six tools on the `/staff` tablet page — prices, air clears, today's sales, waiting credits, needs attention, this machine — so nobody has to walk to the kiosk or call a developer.

**Architecture:** The kiosk server (`kiosk_server/server.js`) gains one read endpoint (`GET /staff/api/tools`) and four actions (`price`, `prime`, `credits/give-back`, `credits/write-off`), all behind stage 1's staff session. The records the tools show are files the controller and uploader already write; a new `lib/logs.js` reads them, cached until the file changes. The staff page gets a Counter / Tools tab bar.

**Tech Stack:** Node ≥ 20 standard library only (the Pi runs Node 20), `node:test`, plain browser JS/CSS, no build step.

**Spec:** `docs/superpowers/specs/2026-09-28-counter-cash-design.md` section 4 (and sections 5, 7).

**Branch:** `piece-3/staff-tools`, created from `piece-2/kiosk-server-cash` (stage 1, not yet merged to `main`).

## Global Constraints

- Node standard library only. No npm dependencies. Must run on Node 20.
- Every `/staff/api/*` tool endpoint requires a signed-in staff session (401 `signed_out` otherwise — already enforced by `staffRoutes`). Every POST requires `Content-Type: application/json` (415 `json_only`).
- **Prices, air clears and give back are refused while an order waits or presses are owed**: `409 {error:'order_waiting'}` when an order is waiting, `409 {error:'machine_busy'}` when any slot is armed, busy or queued or within the 3-second post-ARM guard, `503 {error:'offline'}` when the controller is offline. Write off is never refused for these.
- **Air clear needs its confirm**: the POST body must carry `confirm: true`, else `400 {error:'not_confirmed'}` and no `PRIME` is sent.
- **Give back arms exactly the unclaimed presses**: one `ARM,<slot>,<qty>` with the entry's own slot and qty.
- Staff actions go to `logs/staff_events.jsonl` with the staff name: events `price_change`, `prime`, `credit_give_back`, `credit_write_off`.
- Dates are `YYYY-MM-DD HH:MM:SS`, local time (`stamp()` in `lib/records.js`).
- The six sales fields never change, and nothing is ever written into `TRANSACTION_DIR` (the uploader POSTs every file there as a sale).
- Nothing is queued while the controller is offline.
- The LAN guard (`lib/access.js`) is unchanged: from the shop Wi-Fi only `/staff*`, `/img/*`, `/fonts/*` answer.
- The staff page keeps the kiosk's black-and-blue style and works on phones and tablets; tap targets at least 44px.
- Never commit `CONFIG/config.env`.

### Decisions this plan makes (not spelled out in the spec)

- **Waiting credits** lists `UNCLAIMED_LOG` entries from the **last 7 days** not yet settled. The controller writes no id, so a credit's id is `` `${date_created}|${slot}|${qty}` ``. Settled = a `credit_give_back` or `credit_write_off` event in `staff_events.jsonl` whose `credit` field is that id.
- **Prices** accept whole pesos **1–10000** (the controller's `MAX_PRICE`; 0 is refused on the tablet so a slip cannot make a product free).
- **Price history** shows the last 10 lines of `PRICE_LOG` (`slot`, `from`, `to`, `date_created`).
- **Today's orders** on the Counter tab now come from `orders.jsonl`, so they survive a server restart (stage 1 used memory). Payment and order logs are read through the cached reader, which also fixes stage 1's once-a-second full re-read of `payments.jsonl`.
- A given-back credit shows on the kiosk's dispense screen like a paid order (`dispenseOrder` with the staff name).

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `kiosk_server/lib/logs.js` | Create | Cached JSONL reader, log paths from config, today's sales, open credits |
| `kiosk_server/tests/logs.test.js` | Create | Unit tests for `lib/logs.js` |
| `kiosk_server/lib/controller.js` | Modify `request()` | `SETPRICE` is answered by `PRICE_ACK` |
| `kiosk_server/server.js` | Modify | `/staff/api/tools`, price, prime, give back, write off; `todaySummary` from cached logs |
| `kiosk_server/tests/helpers.js` | Modify stub | Stub answers `SETPRICE` and `PRIME` |
| `kiosk_server/tests/staff_tools.test.js` | Create | Server tests for every tool |
| `kiosk_server/public/staff/index.html` | Modify | Tab bar, Tools view, toast |
| `kiosk_server/public/staff/staff.js` | Modify | Tabs, tools polling, rendering, actions |
| `kiosk_server/public/staff/staff.css` | Modify | Styles for the Tools view |
| `CLAUDE.md`, `CONFIG/README.md`, the spec | Modify | Document stage 2 |

---

### Task 1: Read the machine's records (`lib/logs.js`)

**Files:**
- Create: `kiosk_server/lib/logs.js`
- Test: `kiosk_server/tests/logs.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces (used by Tasks 2–4):
  - `readJsonl(file: string): object[]` — every parseable object line, torn lines skipped, `[]` if missing. Cached until size or mtime changes. **Callers must not mutate the returned array** (use `filter`/`slice` first).
  - `logPaths(config: object, root: string): { prices, primes, unclaimed, interrupted, salesArchive, transactions }` — absolute paths.
  - `salesToday(paths, day: 'YYYY-MM-DD'): { bySlot: { [slot]: { presses, amount } }, presses, amount }`
  - `openCredits(unclaimedRows, staffRows, sinceDay: 'YYYY-MM-DD'): [{ id, slot, qty, amount, reason, date_created }]` newest first.
  - `creditId(row): string`

- [ ] **Step 1: Create the branch**

```bash
git checkout piece-2/kiosk-server-cash
git checkout -b piece-3/staff-tools
```

- [ ] **Step 2: Write the failing tests**

Create `kiosk_server/tests/logs.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readJsonl, logPaths, salesToday, openCredits, creditId } = require('../lib/logs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'logs-'));

test('readJsonl skips torn lines and sees lines appended later', () => {
  const f = path.join(tmp(), 'a.jsonl');
  assert.deepStrictEqual(readJsonl(f), []);
  fs.writeFileSync(f, '{"a":1}\n{"a":\n');
  assert.deepStrictEqual(readJsonl(f), [{ a: 1 }]);
  fs.appendFileSync(f, '\n{"a":2}\n');
  assert.deepStrictEqual(readJsonl(f), [{ a: 1 }, { a: 2 }]);
});

test('logPaths: defaults in the checkout, relative against the repo root, absolute kept', () => {
  const root = path.resolve('/srv/kiosk');
  const abs = path.resolve('/var/log/prices.jsonl');
  const p = logPaths({ PRIME_LOG: 'x/primes.jsonl', PRICE_LOG: abs }, root);
  assert.strictEqual(p.primes, path.join(root, 'x', 'primes.jsonl'));
  assert.strictEqual(p.prices, abs);
  assert.strictEqual(p.unclaimed, path.join(root, 'logs', 'unclaimed_credits.jsonl'));
  assert.strictEqual(p.interrupted, path.join(root, 'logs', 'interrupted_sales.jsonl'));
  assert.strictEqual(p.salesArchive, path.join(root, 'logs', 'sales'));
  assert.strictEqual(p.transactions, path.join(root, 'transaction'));
});

test('salesToday adds the archive and the upload queue, today only', () => {
  const root = tmp();
  const p = logPaths({}, root);
  fs.mkdirSync(p.salesArchive, { recursive: true });
  fs.writeFileSync(path.join(p.salesArchive, 'sales-2026-09.jsonl'), [
    { slot: '1', amount: 5, date_created: '2026-09-29 10:00:00' },
    { slot: '1', amount: 5, date_created: '2026-09-29 10:00:01' },
    { slot: '2', amount: 5, date_created: '2026-09-28 10:00:00' },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n');
  fs.mkdirSync(p.transactions, { recursive: true });
  fs.writeFileSync(path.join(p.transactions, '1_transaction_3_0.json'),
    JSON.stringify({ machine_id: '1', vendor_id: '', voucher_id: '', amount: 10, slot: '3', date_created: '2026-09-29 11:00:00' }));
  fs.writeFileSync(path.join(p.transactions, 'state.dat'), 'binary');
  assert.deepStrictEqual(salesToday(p, '2026-09-29'), {
    bySlot: { 1: { presses: 2, amount: 10 }, 3: { presses: 1, amount: 10 } },
    presses: 3,
    amount: 20,
  });
});

test('openCredits: recent, unsettled, newest first', () => {
  const rows = [
    { slot: '2', qty: 1, amount: 5, reason: 'timeout', date_created: '2026-09-20 09:00:00' },
    { slot: '3', qty: 2, amount: 20, reason: 'timeout', date_created: '2026-09-29 09:00:00' },
    { slot: '5', qty: 1, amount: 8, reason: 'cancelled', date_created: '2026-09-29 10:00:00' },
    { slot: '6', qty: 1, amount: 8, reason: 'timeout', date_created: '2026-09-29 11:00:00' },
  ];
  const staff = [{ event: 'credit_write_off', credit: creditId(rows[3]) }];
  const open = openCredits(rows, staff, '2026-09-23');
  assert.deepStrictEqual(open.map((c) => [c.slot, c.qty, c.amount, c.reason]), [[5, 1, 8, 'cancelled'], [3, 2, 20, 'timeout']]);
  assert.strictEqual(open[1].id, '2026-09-29 09:00:00|3|2');
});
```

- [ ] **Step 3: Run the tests to see them fail**

Run: `cd kiosk_server && node --test tests/logs.test.js`
Expected: FAIL — `Cannot find module '../lib/logs'`.

- [ ] **Step 4: Write `lib/logs.js`**

```js
'use strict';
// Reading the machine's own records for the staff tools. Every file here is
// appended by someone else (the controller, the uploader, this server), so a
// line is never trusted: a torn or foreign line is skipped, not fatal.
//
// The staff page polls, so a read is cached until the file changes (size or
// mtime) -- months of payments are not re-parsed every second.

const fs = require('fs');
const path = require('path');

const cache = new Map();   // file -> { size, mtimeMs, rows }

// Returns the cached array: callers filter or slice, never mutate it.
function readJsonl(file) {
  let st;
  try { st = fs.statSync(file); } catch (_) { cache.delete(file); return []; }
  const c = cache.get(file);
  if (c && c.size === st.size && c.mtimeMs === st.mtimeMs) return c.rows;
  let text = '';
  try { text = fs.readFileSync(file, 'utf-8'); } catch (_) { return []; }
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r && typeof r === 'object') rows.push(r);
    } catch (_) { /* torn line */ }
  }
  cache.set(file, { size: st.size, mtimeMs: st.mtimeMs, rows });
  return rows;
}

const onDay = (day) => (r) => String((r && r.date_created) || '').startsWith(day);

// Where each record lives: the default inside the checkout, or the config.env
// value -- relative ones against the repo root, the rule the controller's
// resolve_config_path() applies, so both sides read the same file.
function logPaths(config, root) {
  const at = (key, ...dflt) => (config[key] ? path.resolve(root, config[key]) : path.join(root, ...dflt));
  return {
    prices: at('PRICE_LOG', 'logs', 'price_changes.jsonl'),
    primes: at('PRIME_LOG', 'logs', 'prime_events.jsonl'),
    unclaimed: at('UNCLAIMED_LOG', 'logs', 'unclaimed_credits.jsonl'),
    interrupted: at('INTERRUPTED_LOG', 'logs', 'interrupted_sales.jsonl'),
    salesArchive: at('SALES_ARCHIVE_DIR', 'logs', 'sales'),
    transactions: at('TRANSACTION_DIR', 'transaction'),
  };
}

// Today's sales per slot: what the cloud has confirmed (the uploader's monthly
// archive) plus what is still waiting to upload (the transaction directory).
// A sale is in one or the other: the uploader archives it, then deletes it.
// ponytail: a sale caught between those two steps counts twice for a moment.
function salesToday(p, day) {
  const rows = readJsonl(path.join(p.salesArchive, `sales-${day.slice(0, 7)}.jsonl`)).filter(onDay(day));
  let names = [];
  try { names = fs.readdirSync(p.transactions).filter((n) => n.endsWith('.json')); } catch (_) { /* none yet */ }
  for (const n of names) {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(p.transactions, n), 'utf-8'));
      if (onDay(day)(r)) rows.push(r);
    } catch (_) { /* being written or uploaded right now */ }
  }
  const bySlot = {};
  let presses = 0;
  let amount = 0;
  for (const r of rows) {
    const slot = Number(r.slot);
    const a = Number(r.amount) || 0;
    const s = bySlot[slot] || (bySlot[slot] = { presses: 0, amount: 0 });
    s.presses++;
    s.amount += a;
    presses++;
    amount += a;
  }
  return { bySlot, presses, amount };
}

// The controller writes no id for a credit; its own time, slot and qty are one.
const creditId = (r) => `${r.date_created}|${r.slot}|${r.qty}`;
const SETTLING = new Set(['credit_give_back', 'credit_write_off']);

// Paid-for presses never poured (UNCLAIMED_LOG), from sinceDay on, that no
// staff member has given back or written off yet. Newest first.
function openCredits(unclaimedRows, staffRows, sinceDay) {
  const settled = new Set(staffRows.filter((e) => SETTLING.has(e.event)).map((e) => e.credit));
  return unclaimedRows
    .filter((r) => String(r.date_created || '') >= sinceDay && !settled.has(creditId(r)))
    .map((r) => ({
      id: creditId(r), slot: Number(r.slot), qty: Number(r.qty),
      amount: Number(r.amount) || 0, reason: r.reason, date_created: r.date_created,
    }))
    .filter((c) => Number.isInteger(c.slot) && c.slot >= 1 && c.slot <= 6 && Number.isInteger(c.qty) && c.qty > 0)
    .reverse();
}

module.exports = { readJsonl, logPaths, salesToday, openCredits, creditId };
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `cd kiosk_server && node --test tests/logs.test.js`
Expected: 4 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add kiosk_server/lib/logs.js kiosk_server/tests/logs.test.js
git commit -m "feat(staff): read the machine's records for the staff tools"
```

---

### Task 2: `GET /staff/api/tools` and Today from the logs

**Files:**
- Modify: `kiosk_server/server.js` (requires at the top; `todaySummary()` at lines 353–368; new functions after `staffState()`; one route in `staffRoutes`)
- Test: `kiosk_server/tests/staff_tools.test.js` (create)

**Interfaces:**
- Consumes: `readJsonl`, `logPaths`, `salesToday`, `openCredits` from Task 1.
- Produces (used by Tasks 3–5):
  - `toolRefusal(): null | [code, { error }]` inside `createKioskServer` — `offline` / `order_waiting` / `machine_busy`.
  - `creditSince(): 'YYYY-MM-DD'` and `const logs = logPaths(config, root)` inside `createKioskServer`.
  - `GET /staff/api/tools` →
    ```
    { products: [{slot,name,img}], prices: {1..6}, priceHistory: [{slot,from,to,date_created}],
      primeSeconds: number, primesToday: {slot: count},
      sales: {bySlot, presses, amount}, cashByStaff: {name: {count, amount}},
      credits: [{id,slot,qty,amount,reason,date_created}],
      attention: [{slot,amount,reason,date_created}],
      machine: {machineId, online, staffBase, stock: [{slot, empty}]},
      busy: null | 'offline' | 'order_waiting' | 'machine_busy' }
    ```
  - `GET /staff/api/state` → `today.orders` now from `orders.jsonl` (same fields as before: `number, amount, status, reason, by, closed`).

- [ ] **Step 1: Write the failing tests**

Create `kiosk_server/tests/staff_tools.test.js`:

```js
'use strict';
// Stage 2: the staff tools on the tablet page.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { stamp } = require('../lib/records');
const { until, stubController, startKiosk, arms, sale } = require('./helpers');

async function kiosk(t, opts) {
  const stub = await stubController();
  const k = await startKiosk(stub, opts);
  t.after(() => { k.close(); stub.close(); });
  const r = await k.post('/staff/api/login', { pin: '4821' });
  const headers = { cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
  return { stub, k, headers };
}

// A record as the controller or the uploader would have written it.
function writeRows(k, rel, rows) {
  const f = path.join(k.dir, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

const sent = (stub, verb) => stub.received.filter((l) => l.startsWith(verb + ','));

test('staff tools need a signed-in staff member', async (t) => {
  const stub = await stubController();
  const k = await startKiosk(stub);
  t.after(() => { k.close(); stub.close(); });
  assert.strictEqual((await k.get('/staff/api/tools')).code, 401);
  for (const p of ['/staff/api/price', '/staff/api/prime', '/staff/api/credits/give-back', '/staff/api/credits/write-off']) {
    assert.strictEqual((await k.post(p, {})).code, 401, p);
  }
});

test("today's sales, cash per staff, needs attention and this machine", async (t) => {
  const { k, headers } = await kiosk(t, { config: ['machineId = 7'] });
  const day = stamp();
  writeRows(k, `logs/sales/sales-${day.slice(0, 7)}.jsonl`, [
    { machine_id: '7', slot: '1', amount: 5, date_created: day },
    { machine_id: '7', slot: '1', amount: 5, date_created: day },
    { machine_id: '7', slot: '3', amount: 10, date_created: '1999-01-01 09:00:00' },
  ]);
  fs.mkdirSync(path.join(k.dir, 'transaction'), { recursive: true });
  fs.writeFileSync(path.join(k.dir, 'transaction', '1_transaction_3_0.json'),
    JSON.stringify({ machine_id: '7', vendor_id: '', voucher_id: '', amount: 10, slot: '3', date_created: day }));
  fs.writeFileSync(path.join(k.dir, 'transaction', 'state.dat'), 'not json');
  writeRows(k, 'logs/interrupted_sales.jsonl', [
    { machine_id: '7', slot: '4', amount: 10, reason: 'tank_empty', date_created: day },
    { machine_id: '7', slot: '4', amount: 10, reason: 'tank_empty', date_created: '1999-01-01 09:00:00' },
  ]);
  writeRows(k, 'logs/prime_events.jsonl', [
    { machine_id: '7', slot: '3', seconds: 3, date_created: day },
    { machine_id: '7', slot: '3', seconds: 3, date_created: day },
    { machine_id: '7', slot: '5', seconds: 3, date_created: '1999-01-01 09:00:00' },
  ]);
  writeRows(k, 'logs/price_changes.jsonl', [
    { machine_id: '7', slot: '2', from: 5, to: 6, date_created: day },
  ]);
  const { body } = await k.post('/api/order', sale);
  await k.post('/staff/api/orders/paid', { number: body.order.number }, headers);

  const s = (await k.get('/staff/api/tools', headers)).body;
  assert.deepStrictEqual(s.sales, { bySlot: { 1: { presses: 2, amount: 10 }, 3: { presses: 1, amount: 10 } }, presses: 3, amount: 20 });
  assert.deepStrictEqual(s.cashByStaff, { Ana: { count: 1, amount: 20 } });
  assert.deepStrictEqual(s.attention.map((a) => [a.slot, a.reason]), [[4, 'tank_empty']]);
  assert.deepStrictEqual(s.primesToday, { 3: 2 });
  assert.strictEqual(s.primeSeconds, 3);
  assert.deepStrictEqual(s.priceHistory.map((h) => [h.slot, h.from, h.to]), [[2, 5, 6]]);
  assert.strictEqual(s.products.length, 6);
  assert.strictEqual(s.prices[1], 5);
  assert.strictEqual(s.machine.machineId, '7');
  assert.strictEqual(s.machine.online, true);
  assert.strictEqual(s.machine.stock.length, 6);
  assert.strictEqual(s.busy, 'machine_busy');   // just armed: the post-ARM guard
});

test('the Today list comes from orders.jsonl, so a restart keeps it', async (t) => {
  const { k, headers } = await kiosk(t);
  const day = stamp();
  writeRows(k, 'logs/orders.jsonl', [
    { reference: '19990101-A-3', items: '1:1', amount: 5, status: 'paid', by: 'Ben', created: '1999-01-01 09:00:00', closed: '1999-01-01 09:01:00' },
    { reference: `${day.slice(0, 10).replace(/-/g, '')}-A-4`, items: '1:1', amount: 5, status: 'paid', by: 'Ben', created: day, closed: day },
  ]);
  const s = (await k.get('/staff/api/state', headers)).body;
  assert.deepStrictEqual(s.today.orders.map((o) => [o.number, o.by, o.status]), [['A-4', 'Ben', 'paid']]);
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `cd kiosk_server && node --test tests/staff_tools.test.js`
Expected: the first test PASSES (401 already happens for any `/staff/api/*` path); the other two FAIL (`/staff/api/tools` answers 404; the Today list does not include `A-4`).

- [ ] **Step 3: Add the requires and constants**

In `kiosk_server/server.js`, after the line `const { isLocal, lanAllowed, lanAddress } = require('./lib/access');` add:

```js
const { readJsonl, logPaths, salesToday, openCredits } = require('./lib/logs');
```

After `const MAX_QTY = 20;` add:

```js
const MAX_PRICE = 10000;   // the controller's own limit, controller/includes/hardware_config.h
const CREDIT_DAYS = 7;     // how far back Waiting credits looks
```

Inside `createKioskServer`, after the line `const staffLog = path.join(logsDir, 'staff_events.jsonl');` add:

```js
  const logs = logPaths(config, root);
  // What the controller runs a prime for, clamped as the controller clamps it.
  const primeSeconds = Math.min(15, Math.max(0.5, parseFloat(config.PRIME_SECONDS) || 3));
```

- [ ] **Step 4: Replace `todaySummary()`**

Replace the whole `todaySummary()` function (the comment line `// Today's cash, from the payments log so it survives a restart.` through its closing `}`) with:

```js
  const today = () => stamp().slice(0, 10);
  const onToday = (field) => (r) => String(r[field] || '').startsWith(today());

  // Today's cash and orders, from the logs so they survive a restart.
  function todaySummary() {
    const pays = readJsonl(paymentsLog).filter(onToday('date_created'));
    return {
      paid: pays.length,
      total: pays.reduce((a, p) => a + (p.amount || 0), 0),
      orders: readJsonl(ordersLog).filter(onToday('closed')).slice(-20).reverse().map((o) => ({
        number: String(o.reference).split('-').slice(1).join('-'),
        amount: o.amount, status: o.status, reason: o.reason, by: o.by, closed: o.closed,
      })),
    };
  }
```

- [ ] **Step 5: Add `toolRefusal()`, `creditSince()` and `staffTools()`**

Directly after the `staffState()` function, add:

```js
  // Price changes, air clears and give-backs wait for a free machine: no
  // order waiting (its prices are frozen and it may be paid any second), no
  // presses owed, no ARM on its way.
  function toolRefusal() {
    if (!ctrl.online) return [503, { error: 'offline' }];
    if (orders.current()) return [409, { error: 'order_waiting' }];
    if (Date.now() < armingUntil || machineInUse()) return [409, { error: 'machine_busy' }];
    return null;
  }

  const creditSince = () => stamp(new Date(Date.now() - (CREDIT_DAYS - 1) * 86400000)).slice(0, 10);

  function staffTools() {
    const primesToday = {};
    for (const r of readJsonl(logs.primes).filter(onToday('date_created'))) {
      primesToday[Number(r.slot)] = (primesToday[Number(r.slot)] || 0) + 1;
    }
    const cashByStaff = {};
    for (const p of readJsonl(paymentsLog).filter(onToday('date_created'))) {
      const c = cashByStaff[p.staff] || (cashByStaff[p.staff] = { count: 0, amount: 0 });
      c.count++;
      c.amount += p.amount || 0;
    }
    const refused = toolRefusal();
    return {
      products: products.map(({ slot, name, img }) => ({ slot, name, img })),
      prices: ctrl.prices,
      priceHistory: readJsonl(logs.prices).slice(-10).reverse().map((r) => ({
        slot: Number(r.slot), from: r.from, to: r.to, date_created: r.date_created,
      })),
      primeSeconds,
      primesToday,
      sales: salesToday(logs, today()),
      cashByStaff,
      credits: openCredits(readJsonl(logs.unclaimed), readJsonl(staffLog), creditSince()),
      attention: readJsonl(logs.interrupted).filter(onToday('date_created')).reverse().map((r) => ({
        slot: Number(r.slot), amount: r.amount, reason: r.reason, date_created: r.date_created,
      })),
      machine: {
        machineId: config.machineId || '',
        online: ctrl.online,
        staffBase: staffBase(),
        stock: ctrl.status ? ctrl.status.slots.map((s) => ({ slot: s.slot, empty: s.empty })) : [],
      },
      busy: refused ? refused[1].error : null,
    };
  }
```

- [ ] **Step 6: Add the route**

In `staffRoutes`, after the line `if (req.method === 'GET' && url === '/staff/api/state') return json(res, 200, staffState());` add:

```js
      if (req.method === 'GET' && url === '/staff/api/tools') return json(res, 200, staffTools());
```

- [ ] **Step 7: Run the whole suite**

Run: `cd kiosk_server && npm test`
Expected: every test PASSES (the 61 from stage 1, the 4 from Task 1, the 3 new ones).

- [ ] **Step 8: Commit**

```bash
git add kiosk_server/server.js kiosk_server/tests/staff_tools.test.js
git commit -m "feat(staff): tools read endpoint; Today reads the logs, cached"
```

---

### Task 3: Prices and air clears

**Files:**
- Modify: `kiosk_server/lib/controller.js` (`request()`, lines 127–142)
- Modify: `kiosk_server/tests/helpers.js` (the stub's `data` handler, lines 44–50)
- Modify: `kiosk_server/server.js` (two handlers after `staffTools()`, two routes)
- Test: `kiosk_server/tests/staff_tools.test.js` (append)

**Interfaces:**
- Consumes: `toolRefusal()`, `staffEvent()`, `validSlot()`, `isJson()`, `readBody()`, `json()`, `MAX_PRICE`, `primeSeconds` (Task 2 / stage 1).
- Produces:
  - `POST /staff/api/price {slot, price}` → `200 {result:'ok'|'not_saved'}`, `400 {error:'bad_price'}`, the `toolRefusal` codes, `409 {result:<controller refusal>}`, `503 {result:'offline'|'timeout'}`.
  - `POST /staff/api/prime {slot, confirm:true}` → `200 {result:'started'}`, `400 {error:'bad_slot'|'not_confirmed'}`, the `toolRefusal` codes, `409 {result:<controller refusal>}`, `503 {result:'offline'|'timeout'}`.
  - Test stub: `stub.priceReply` (default `'ok'`), `stub.primeReply` (default `'started'`).

- [ ] **Step 1: Teach the stub `SETPRICE` and `PRIME`**

In `kiosk_server/tests/helpers.js`, inside the `for (const l of lines)` loop, after the `PAUSE` line add:

```js
        if (verb === 'SETPRICE') {
          const r = stub.priceReply || 'ok';
          if (r === 'ok') {
            const p = stub.prices.split(',');
            p[Number(slot) - 1] = l.split(',')[2];
            stub.prices = p.join(',');
          }
          s.write(`PRICE_ACK,${slot},${r}\n`);
        }
        if (verb === 'PRIME') s.write(`PRIME_ACK,${slot},${stub.primeReply || 'started'}\n`);
```

- [ ] **Step 2: Write the failing tests**

Append to `kiosk_server/tests/staff_tools.test.js`:

```js
test('prices: changed with SETPRICE, logged with the staff name', async (t) => {
  const { stub, k, headers } = await kiosk(t);

  await t.test('a price that is not a whole number of pesos from 1 to 10000 is refused', async () => {
    for (const price of [0, 2.5, '7', 10001]) {
      const r = await k.post('/staff/api/price', { slot: 1, price }, headers);
      assert.deepStrictEqual([r.code, r.body.error], [400, 'bad_price'], String(price));
    }
    assert.deepStrictEqual(sent(stub, 'SETPRICE'), []);
  });

  await t.test('refused while an order waits', async () => {
    const { body } = await k.post('/api/order', sale);
    const r = await k.post('/staff/api/price', { slot: 1, price: 7 }, headers);
    assert.deepStrictEqual([r.code, r.body.error], [409, 'order_waiting']);
    assert.strictEqual((await k.get('/staff/api/tools', headers)).body.busy, 'order_waiting');
    await k.post('/api/order/cancel', { number: body.order.number });
    assert.deepStrictEqual(sent(stub, 'SETPRICE'), []);
  });

  await t.test('refused while presses are owed', async () => {
    stub.armed[0] = 1;
    await until(() => k.ctrl.status.slots[0].armed === 1);
    const r = await k.post('/staff/api/price', { slot: 1, price: 7 }, headers);
    assert.deepStrictEqual([r.code, r.body.error], [409, 'machine_busy']);
    stub.armed[0] = 0;
    await until(() => k.ctrl.status.slots[0].armed === 0);
  });

  await t.test('a free machine takes the new price and the kiosk hears it', async () => {
    const r = await k.post('/staff/api/price', { slot: 1, price: 7 }, headers);
    assert.deepStrictEqual([r.code, r.body.result], [200, 'ok']);
    assert.deepStrictEqual(sent(stub, 'SETPRICE'), ['SETPRICE,1,7']);
    await until(() => k.ctrl.prices[1] === 7);
    const ev = k.rows('staff_events.jsonl').find((e) => e.event === 'price_change');
    assert.deepStrictEqual([ev.staff, ev.slot, ev.from, ev.to, ev.result], ['Ana', 1, 5, 7, 'ok']);
  });

  await t.test('a controller refusal is passed on and not logged as a change', async () => {
    stub.priceReply = 'sale_in_progress';
    const r = await k.post('/staff/api/price', { slot: 2, price: 9 }, headers);
    assert.deepStrictEqual([r.code, r.body.result], [409, 'sale_in_progress']);
    assert.strictEqual(k.rows('staff_events.jsonl').filter((e) => e.event === 'price_change').length, 1);
  });
});

test('air clear: needs its confirm, runs PRIME, logged with the staff name', async (t) => {
  const { stub, k, headers } = await kiosk(t);

  await t.test('without the confirm no pump runs', async () => {
    const r = await k.post('/staff/api/prime', { slot: 3 }, headers);
    assert.deepStrictEqual([r.code, r.body.error], [400, 'not_confirmed']);
    assert.deepStrictEqual(sent(stub, 'PRIME'), []);
  });

  await t.test('refused while an order waits', async () => {
    const { body } = await k.post('/api/order', sale);
    const r = await k.post('/staff/api/prime', { slot: 3, confirm: true }, headers);
    assert.deepStrictEqual([r.code, r.body.error], [409, 'order_waiting']);
    await k.post('/api/order/cancel', { number: body.order.number });
    assert.deepStrictEqual(sent(stub, 'PRIME'), []);
  });

  await t.test('confirmed on a free machine it runs and is logged', async () => {
    const r = await k.post('/staff/api/prime', { slot: 3, confirm: true }, headers);
    assert.deepStrictEqual([r.code, r.body.result], [200, 'started']);
    assert.deepStrictEqual(sent(stub, 'PRIME'), ['PRIME,3']);
    const ev = k.rows('staff_events.jsonl').find((e) => e.event === 'prime');
    assert.deepStrictEqual([ev.staff, ev.slot, ev.result], ['Ana', 3, 'started']);
  });

  await t.test('a controller refusal is passed on', async () => {
    stub.primeReply = 'slot_empty';
    const r = await k.post('/staff/api/prime', { slot: 4, confirm: true }, headers);
    assert.deepStrictEqual([r.code, r.body.result], [409, 'slot_empty']);
  });
});
```

- [ ] **Step 3: Run the tests to see them fail**

Run: `cd kiosk_server && node --test tests/staff_tools.test.js`
Expected: the new price and air-clear tests FAIL (404 from the unknown routes).

- [ ] **Step 4: Match `SETPRICE` to its `PRICE_ACK`**

In `kiosk_server/lib/controller.js`, above `function request(cmd) {` add:

```js
  // The controller answers most VERB with VERB_ACK; SETPRICE is the exception.
  const ACK_VERB = { SETPRICE: 'PRICE' };
```

and in `request()` replace

```js
    const [verb, slotStr] = cmd.split(',');
```

with

```js
    const [cmdVerb, slotStr] = cmd.split(',');
    const verb = ACK_VERB[cmdVerb] || cmdVerb;
```

- [ ] **Step 5: Add the two handlers**

In `kiosk_server/server.js`, directly after `staffTools()`, add:

```js
  // A controller reply as an HTTP code: accepted, not reachable, or refused.
  const ackCode = (result, accepted) =>
    accepted.includes(result) ? 200 : result === 'offline' || result === 'timeout' ? 503 : 409;

  async function staffSetPrice(req, res, name) {
    if (!isJson(req)) return json(res, 415, { error: 'json_only' });
    const body = await readBody(req);
    const slot = body && body.slot;
    const price = body && body.price;
    if (!validSlot(slot) || !Number.isInteger(price) || price < 1 || price > MAX_PRICE) {
      return json(res, 400, { error: 'bad_price' });
    }
    const refused = toolRefusal();
    if (refused) return json(res, ...refused);
    const from = ctrl.prices[slot];
    const result = await ctrl.request(`SETPRICE,${slot},${price}`);
    if (result === 'ok' || result === 'not_saved') {
      // The controller does not broadcast a change: ask, so the kiosk's
      // screens and the next order use the new price.
      ctrl.send('GETPRICES');
      staffEvent('price_change', { staff: name, slot, from, to: price, result });
      log(`[kiosk] price slot ${slot} ${from} -> ${price} by ${name} (${result})`);
    }
    json(res, ackCode(result, ['ok', 'not_saved']), { result });
  }

  async function staffPrime(req, res, name) {
    if (!isJson(req)) return json(res, 415, { error: 'json_only' });
    const body = await readBody(req);
    const slot = body && body.slot;
    if (!validSlot(slot)) return json(res, 400, { error: 'bad_slot' });
    // The page first asks "Put a cup under nozzle N"; a POST without that
    // answer does not run a pump.
    if (body.confirm !== true) return json(res, 400, { error: 'not_confirmed' });
    const refused = toolRefusal();
    if (refused) return json(res, ...refused);
    const result = await ctrl.request(`PRIME,${slot}`);
    staffEvent('prime', { staff: name, slot, result });
    log(`[kiosk] prime slot ${slot} by ${name}: ${result}`);
    json(res, ackCode(result, ['started']), { result });
  }
```

- [ ] **Step 6: Add the routes**

In `staffRoutes`, after the `/staff/api/tools` route add:

```js
      if (req.method === 'POST' && url === '/staff/api/price') return staffSetPrice(req, res, name);
      if (req.method === 'POST' && url === '/staff/api/prime') return staffPrime(req, res, name);
```

- [ ] **Step 7: Run the whole suite**

Run: `cd kiosk_server && npm test`
Expected: every test PASSES.

- [ ] **Step 8: Commit**

```bash
git add kiosk_server/lib/controller.js kiosk_server/server.js kiosk_server/tests/helpers.js kiosk_server/tests/staff_tools.test.js
git commit -m "feat(staff): change prices and clear air from the tablet"
```

---

### Task 4: Waiting credits — give back and write off

**Files:**
- Modify: `kiosk_server/server.js` (one handler after `staffPrime()`, two routes)
- Test: `kiosk_server/tests/staff_tools.test.js` (append)

**Interfaces:**
- Consumes: `openCredits`, `readJsonl` (Task 1); `toolRefusal()`, `creditSince()`, `logs` (Task 2); stage 1's `armingUntil`, `dispenseOrder`, `push()`, `staffEvent()`.
- Produces:
  - `POST /staff/api/credits/give-back {id}` → `200 {ok:true}`, `409 {error:'not_open'}`, the `toolRefusal` codes, `503 {error:'offline'}`.
  - `POST /staff/api/credits/write-off {id}` → `200 {ok:true}`, `409 {error:'not_open'}`.
  - Staff events `credit_give_back` / `credit_write_off` with fields `staff, credit, slot, qty, amount`.

- [ ] **Step 1: Write the failing test**

Append to `kiosk_server/tests/staff_tools.test.js`:

```js
test('waiting credits: give back re-arms exactly the unclaimed presses, write off closes', async (t) => {
  const { stub, k, headers } = await kiosk(t);
  const now = stamp();
  const old = stamp(new Date(Date.now() - 10 * 86400000));
  writeRows(k, 'logs/unclaimed_credits.jsonl', [
    { machine_id: '1', slot: '2', qty: 1, amount: 5, reason: 'timeout', date_created: old },
    { machine_id: '1', slot: '3', qty: 2, amount: 20, reason: 'timeout', date_created: now },
    { machine_id: '1', slot: '5', qty: 1, amount: 8, reason: 'cancelled', date_created: now },
  ]);
  const list = async () => (await k.get('/staff/api/tools', headers)).body.credits;
  const open = await list();

  await t.test('the last seven days, newest first', () => {
    assert.deepStrictEqual(open.map((c) => [c.slot, c.qty, c.amount]), [[5, 1, 8], [3, 2, 20]]);
  });

  await t.test('give back is refused while an order waits', async () => {
    const { body } = await k.post('/api/order', sale);
    const r = await k.post('/staff/api/credits/give-back', { id: open[1].id }, headers);
    assert.deepStrictEqual([r.code, r.body.error], [409, 'order_waiting']);
    await k.post('/api/order/cancel', { number: body.order.number });
    assert.deepStrictEqual(arms(stub), []);
  });

  await t.test('give back arms exactly the unclaimed presses and shows them on the kiosk', async () => {
    const r = await k.post('/staff/api/credits/give-back', { id: open[1].id }, headers);
    assert.strictEqual(r.code, 200);
    await until(() => arms(stub).length === 1);
    assert.deepStrictEqual(arms(stub), ['ARM,3,2']);
    const st = await k.get('/api/state');
    assert.deepStrictEqual(st.body.order.items, [{ slot: 3, qty: 2 }]);
    const ev = k.rows('staff_events.jsonl').find((e) => e.event === 'credit_give_back');
    assert.deepStrictEqual([ev.staff, ev.credit, ev.slot, ev.qty, ev.amount], ['Ana', open[1].id, 3, 2, 20]);
  });

  await t.test('a settled credit cannot be given back twice', async () => {
    const r = await k.post('/staff/api/credits/give-back', { id: open[1].id }, headers);
    assert.deepStrictEqual([r.code, r.body.error], [409, 'not_open']);
    assert.strictEqual(arms(stub).length, 1);
  });

  await t.test('write off closes the entry without arming', async () => {
    const r = await k.post('/staff/api/credits/write-off', { id: open[0].id }, headers);
    assert.strictEqual(r.code, 200);
    assert.strictEqual(arms(stub).length, 1);
    assert.deepStrictEqual(await list(), []);
    const ev = k.rows('staff_events.jsonl').find((e) => e.event === 'credit_write_off');
    assert.deepStrictEqual([ev.staff, ev.slot, ev.qty, ev.amount], ['Ana', 5, 1, 8]);
  });
});
```

- [ ] **Step 2: Run the test to see it fail**

Run: `cd kiosk_server && node --test tests/staff_tools.test.js`
Expected: the credits test FAILS at "give back is refused while an order waits" (404, not 409).

- [ ] **Step 3: Add the handler**

In `kiosk_server/server.js`, directly after `staffPrime()`, add:

```js
  // Paid presses that were never poured. Give back re-arms exactly those
  // presses, so the kiosk opens the dispense screen for the customer; write
  // off closes the entry. Either way it is settled once, under a name.
  async function staffCredit(req, res, name, action) {
    if (!isJson(req)) return json(res, 415, { error: 'json_only' });
    const body = await readBody(req);
    const id = body && body.id;
    const c = openCredits(readJsonl(logs.unclaimed), readJsonl(staffLog), creditSince()).find((x) => x.id === id);
    if (!c) return json(res, 409, { error: 'not_open' });
    const fields = { staff: name, credit: c.id, slot: c.slot, qty: c.qty, amount: c.amount };
    if (action === 'write_off') {
      staffEvent('credit_write_off', fields);
      log(`[kiosk] credit ${c.id} written off by ${name}`);
      return json(res, 200, { ok: true });
    }
    const refused = toolRefusal();
    if (refused) return json(res, ...refused);
    if (!ctrl.send(`ARM,${c.slot},${c.qty}`)) return json(res, 503, { error: 'offline' });
    armingUntil = Date.now() + 3000;
    dispenseOrder = { reference: `credit ${c.id}`, staff: name, items: [{ slot: c.slot, qty: c.qty }] };
    staffEvent('credit_give_back', fields);
    log(`[kiosk] credit ${c.id} given back by ${name}: ARM,${c.slot},${c.qty}`);
    push();
    json(res, 200, { ok: true });
  }
```

- [ ] **Step 4: Add the routes**

In `staffRoutes`, after the `/staff/api/prime` route add:

```js
      if (req.method === 'POST' && url === '/staff/api/credits/give-back') return staffCredit(req, res, name, 'give_back');
      if (req.method === 'POST' && url === '/staff/api/credits/write-off') return staffCredit(req, res, name, 'write_off');
```

- [ ] **Step 5: Run the whole suite**

Run: `cd kiosk_server && npm test`
Expected: every test PASSES.

- [ ] **Step 6: Commit**

```bash
git add kiosk_server/server.js kiosk_server/tests/staff_tools.test.js
git commit -m "feat(staff): give back or write off waiting credits"
```

---

### Task 5: The Tools tab on the staff page

**Files:**
- Modify: `kiosk_server/public/staff/index.html`
- Modify: `kiosk_server/public/staff/staff.js`
- Modify: `kiosk_server/public/staff/staff.css`

**Interfaces:**
- Consumes: `GET /staff/api/tools`, `POST /staff/api/price`, `/staff/api/prime`, `/staff/api/credits/give-back`, `/staff/api/credits/write-off` (Tasks 2–4); stage 1's `api()`, `ask()`, `esc()`, `peso()`, `$()`.
- Produces: nothing other tasks use.

- [ ] **Step 1: Add the tab bar, the Tools view and the toast to `index.html`**

Directly after `<main>` add:

```html
    <nav class="s-tabs" id="s-tabs" hidden>
      <button type="button" data-tab="counter" class="on">Counter</button>
      <button type="button" data-tab="tools">Tools</button>
    </nav>
```

Directly after the closing `</section>` of `v-main` (before `</main>`) add:

```html
    <!-- Tools: prices, air clear, credits, attention, sales, this machine -->
    <section id="v-tools" hidden>
      <p class="s-note" id="x-busy" hidden></p>

      <div class="s-card">
        <div class="s-card-head"><h2>Prices</h2><span class="s-sum">per press</span></div>
        <ul class="s-rows" id="x-prices"></ul>
        <ul class="s-list s-hist" id="x-price-log"></ul>
      </div>

      <div class="s-card">
        <div class="s-card-head"><h2>Air clear</h2><span class="s-sum" id="x-prime-sec"></span></div>
        <p class="s-hint">After a gallon change, push the air out of the hose so the next customer is not charged for air.</p>
        <div class="s-grid" id="x-primes"></div>
      </div>

      <div class="s-card">
        <div class="s-card-head"><h2>Waiting credits</h2><span class="s-sum" id="x-credit-sum"></span></div>
        <p class="s-hint">Paid for but never poured, last 7 days.</p>
        <ul class="s-rows" id="x-credits"></ul>
      </div>

      <div class="s-card">
        <div class="s-card-head"><h2>Needs attention</h2></div>
        <p class="s-hint">Pours cut short today. The customer was charged in full — settle it with them.</p>
        <ul class="s-list" id="x-attention"></ul>
      </div>

      <div class="s-card">
        <div class="s-card-head"><h2>Today's sales</h2><span class="s-sum" id="x-sales-sum"></span></div>
        <ul class="s-list" id="x-sales"></ul>
        <ul class="s-list" id="x-cash"></ul>
      </div>

      <div class="s-card">
        <div class="s-card-head"><h2>This machine</h2></div>
        <dl class="s-dl" id="x-machine"></dl>
      </div>
    </section>
```

Directly before `<script src="/staff/staff.js"></script>` add:

```html
  <p class="s-toast" id="x-msg" role="status" hidden></p>
```

- [ ] **Step 2: Add the state and replace `showView` in `staff.js`**

In the state block, after `let audio = null;` add:

```js
  let tab = 'counter';
  let tools = null;
  let toolsTimer = null;
  let toastTimer = null;
  const lastHtml = {};
```

Replace the whole `showView` function with:

```js
  function showView(v) {
    $('v-login').hidden = v !== 'login';
    $('s-tabs').hidden = v !== 'main';
    $('s-me').hidden = v !== 'main';
    $('s-out').hidden = v !== 'main';
    if (v === 'main') showTab(tab);
    else { $('v-main').hidden = true; $('v-tools').hidden = true; }
  }
```

- [ ] **Step 3: Add the Tools code to `staff.js`**

Directly before the `// ---- boot ----` comment add:

```js
  // ---- tools --------------------------------------------------------------------
  const nameOf = (slot) => (tools && tools.products[slot - 1] ? tools.products[slot - 1].name : `Slot ${slot}`);
  const hhmm = (d) => String(d || '').slice(11, 16);
  const when = (d) => String(d || '').slice(5, 16);
  const validPrice = (v) => /^\d+$/.test(String(v)) && Number(v) >= 1 && Number(v) <= 10000;

  const BUSY_MSG = {
    order_waiting: 'An order is waiting for payment. Prices, air clears and give-backs wait until it is paid or cancelled.',
    machine_busy: 'The machine is dispensing. Prices, air clears and give-backs wait until it is free.',
    offline: 'The kiosk is offline. Prices, air clears and give-backs wait until it is back.',
  };
  const TOOL_MSG = {
    ...BUSY_MSG,
    timeout: 'The machine did not answer — try again.',
    sale_in_progress: 'The machine still has presses to pour — try again when it is free.',
    slot_busy: 'That nozzle is running — wait for it to stop.',
    slot_empty: 'That tank reads empty — refill it first.',
    paused: 'The machine is paused.',
    max_active: 'Two pumps are already running — wait a moment.',
    not_open: 'That credit was already settled.',
    bad_price: 'Enter a whole number of pesos.',
    network: 'Cannot reach the kiosk. Check the Wi-Fi.',
  };

  // Set a list's HTML only when it changed: rebuilding buttons every poll
  // swallows a tap that lands mid-rebuild.
  function put(id, html) {
    if (lastHtml[id] === html) return;
    lastHtml[id] = html;
    $(id).innerHTML = html;
  }

  function toast(ok, text) {
    const t = $('x-msg');
    t.className = ok ? 's-toast is-ok' : 's-toast';
    t.textContent = text;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 6000);
  }
  const failed = (r) => TOOL_MSG[r.body.error || r.body.result] || 'That did not work — try again.';

  function showTab(t) {
    tab = t;
    for (const b of document.querySelectorAll('#s-tabs button')) b.classList.toggle('on', b.dataset.tab === t);
    $('v-main').hidden = t !== 'counter';
    $('v-tools').hidden = t !== 'tools';
    clearTimeout(toolsTimer);
    if (t === 'tools') loadTools();
  }
  $('s-tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tab]');
    if (b) showTab(b.dataset.tab);
  });

  // Every 3 s while Tools is open. A 401 is left to the state poll, which
  // signs the page out.
  async function loadTools() {
    clearTimeout(toolsTimer);
    if (tab !== 'tools' || !me) return;
    const r = await api('/staff/api/tools');
    if (r.code === 401) return;
    if (r.code === 200) { tools = r.body; renderTools(); }
    toolsTimer = setTimeout(loadTools, 3000);
  }

  function renderTools() {
    const t = tools;
    const busyMsg = t.busy ? BUSY_MSG[t.busy] || '' : '';
    $('x-busy').hidden = !busyMsg;
    $('x-busy').textContent = busyMsg;

    // Prices: rows built once, so a poll never overwrites what is being typed.
    const list = $('x-prices');
    if (!list.children.length) {
      list.innerHTML = t.products.map((p) => `<li data-slot="${p.slot}">
        <img src="${esc(p.img)}" alt=""><b>${esc(p.name)}</b>
        <label class="s-peso">₱<input type="number" inputmode="numeric" min="1" max="10000" step="1" aria-label="${esc(p.name)} price"></label>
        <button class="s-btn s-primary s-small" type="button" disabled>Save</button>
      </li>`).join('');
    }
    for (const li of list.children) {
      const slot = Number(li.dataset.slot);
      const input = li.querySelector('input');
      const now = t.prices[slot];
      if (document.activeElement !== input && !input.dataset.dirty) input.value = Number.isInteger(now) ? now : '';
      li.querySelector('button').disabled = !!t.busy || !validPrice(input.value) || Number(input.value) === now;
    }
    put('x-price-log', t.priceHistory.map((h) => `<li>
      <span>${esc(nameOf(h.slot))}</span><span>${peso(h.from)} → ${peso(h.to)}</span><span>${esc(when(h.date_created))}</span>
    </li>`).join(''));

    $('x-prime-sec').textContent = `${t.primeSeconds} s each`;
    put('x-primes', t.products.map((p) => `<button class="s-tile" type="button" data-slot="${p.slot}"${t.busy ? ' disabled' : ''}>
      <b>Nozzle ${p.slot}</b><span>${esc(p.name)}</span><small>${t.primesToday[p.slot] || 0} today</small>
    </button>`).join(''));

    $('x-credit-sum').textContent = t.credits.length
      ? `${t.credits.length} · ${peso(t.credits.reduce((a, c) => a + c.amount, 0))}` : '';
    put('x-credits', t.credits.map((c) => `<li data-id="${esc(c.id)}">
      <div><b>${esc(nameOf(c.slot))} × ${c.qty}</b>
        <small>${peso(c.amount)} · ${c.reason === 'cancelled' ? 'cancelled' : 'not collected'} · ${esc(when(c.date_created))}</small></div>
      <div class="s-acts">
        <button class="s-btn s-primary s-small" data-act="give" type="button"${t.busy ? ' disabled' : ''}>Give back</button>
        <button class="s-btn s-ghost s-small" data-act="off" type="button">Write off</button>
      </div>
    </li>`).join('') || '<li class="s-none">No waiting credits.</li>');

    put('x-attention', t.attention.map((a) => `<li>
      <span>${esc(nameOf(a.slot))} · ${peso(a.amount)}</span>
      <span>${a.reason === 'tank_empty' ? 'Tank ran out mid-pour' : a.reason === 'pause_timeout' ? 'Paused too long' : esc(a.reason)} · ${esc(hhmm(a.date_created))}</span>
    </li>`).join('') || '<li class="s-none">Nothing today.</li>');

    const s = t.sales;
    $('x-sales-sum').textContent = `${s.presses} presses · ${peso(s.amount)}`;
    put('x-sales', t.products.filter((p) => s.bySlot[p.slot]).map((p) => `<li>
      <span>${esc(p.name)} · ${s.bySlot[p.slot].presses} presses</span><span>${peso(s.bySlot[p.slot].amount)}</span>
    </li>`).join('') || '<li class="s-none">No sales yet today.</li>');
    put('x-cash', Object.entries(t.cashByStaff).map(([n, c]) => `<li>
      <span>Cash · ${esc(n)} · ${c.count} ${c.count === 1 ? 'order' : 'orders'}</span><span>${peso(c.amount)}</span>
    </li>`).join(''));

    const m = t.machine;
    put('x-machine', `<dt>Machine ID</dt><dd>${esc(m.machineId || '—')}</dd>
      <dt>Controller</dt><dd class="${m.online ? 'ok' : 'bad'}">${m.online ? 'Online' : 'Offline'}</dd>
      <dt>Staff page</dt><dd>${esc(m.staffBase ? `${m.staffBase}/staff` : 'No network address')}</dd>
      ${t.products.map((p) => {
        const st = m.stock.find((x) => x.slot === p.slot);
        return `<dt>${esc(p.name)}</dt><dd class="${!st ? '' : st.empty ? 'bad' : 'ok'}">${!st ? '—' : st.empty ? 'Empty' : 'Has stock'}</dd>`;
      }).join('')}`);
  }

  $('x-prices').addEventListener('input', (e) => {
    if (e.target.tagName !== 'INPUT') return;
    e.target.dataset.dirty = '1';
    renderTools();
  });
  $('x-prices').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || b.disabled) return;
    const li = b.closest('li');
    const slot = Number(li.dataset.slot);
    const input = li.querySelector('input');
    const price = Number(input.value);
    const from = tools.prices[slot];
    ask(`Change ${nameOf(slot)} to ${peso(price)}?`, `It is ${peso(from)} now. New orders use the new price.`, 'Yes, change it', async () => {
      const r = await api('/staff/api/price', { slot, price });
      delete input.dataset.dirty;
      if (r.code !== 200) toast(false, failed(r));
      else if (r.body.result === 'not_saved') toast(false, `${nameOf(slot)} is ${peso(price)} now, but it could not be saved — it goes back after a restart.`);
      else toast(true, `${nameOf(slot)} is now ${peso(price)}.`);
      loadTools();
    });
  });

  $('x-primes').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-slot]');
    if (!b || b.disabled) return;
    const slot = Number(b.dataset.slot);
    ask(`Put a cup under nozzle ${slot}`, `${nameOf(slot)}. Run it for ${tools.primeSeconds} seconds?`, 'Yes, run it', async () => {
      const r = await api('/staff/api/prime', { slot, confirm: true });
      toast(r.code === 200, r.code === 200 ? `Nozzle ${slot} is clearing air for ${tools.primeSeconds} seconds.` : failed(r));
      loadTools();
    });
  });

  $('x-credits').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b || b.disabled) return;
    const c = tools.credits.find((x) => x.id === b.closest('li').dataset.id);
    if (!c) return;
    const what = `${nameOf(c.slot)} × ${c.qty}`;
    if (b.dataset.act === 'give') {
      ask(`Give back ${what}?`, 'The kiosk opens the dispense screen for these presses. The customer pours them there.', 'Yes, give back', async () => {
        const r = await api('/staff/api/credits/give-back', { id: c.id });
        toast(r.code === 200, r.code === 200 ? `${what} is ready on the kiosk.` : failed(r));
        loadTools();
      });
    } else {
      ask(`Write off ${what}?`, `The ${peso(c.amount)} stays paid and the presses are not given. This cannot be undone.`, 'Yes, write off', async () => {
        const r = await api('/staff/api/credits/write-off', { id: c.id });
        toast(r.code === 200, r.code === 200 ? `${what} written off.` : failed(r));
        loadTools();
      });
    }
  });
```

- [ ] **Step 4: Add the styles to `staff.css`**

Append:

```css
/* Counter / Tools */
.s-tabs { display: flex; gap: 8px; margin: 0 0 14px; }
.s-tabs button { flex: 1; min-height: 52px; border-radius: 999px; background: var(--surface); border: 1px solid var(--line); font-size: 17px; font-weight: 700; color: var(--ink-2); }
.s-tabs button.on { background: var(--brand); border-color: var(--brand); color: #fff; }

.s-note { margin: 0 0 14px; padding: 12px 14px; border-radius: 14px; background: var(--surface-sub); border: 1px solid var(--amber); color: var(--amber); font-weight: 700; }
.s-hint { margin: -4px 0 12px; color: var(--ink-2); font-size: 15px; }
.s-small { min-height: 44px; padding: 0 16px; font-size: 15px; }

.s-rows { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.s-rows li { display: flex; align-items: center; gap: 12px; padding: 8px 10px; background: var(--surface-sub); border-radius: 14px; }
.s-rows li > b, .s-rows li > div:first-child { flex: 1; min-width: 0; }
.s-rows img { width: 44px; height: 44px; object-fit: contain; }
.s-rows small { display: block; margin-top: 2px; color: var(--ink-2); font-size: 14px; }
.s-peso { display: inline-flex; align-items: center; gap: 4px; font-size: 18px; color: var(--ink-2); }
.s-peso input { width: 84px; min-height: 44px; padding: 0 10px; border-radius: 12px; border: 1px solid var(--line); background: var(--bg); color: var(--ink); font: inherit; font-size: 18px; font-weight: 700; }
.s-acts { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }

.s-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; }
.s-tile { display: grid; gap: 4px; min-height: 96px; padding: 14px; text-align: left; border-radius: 16px; background: var(--surface-sub); border: 1px solid var(--line); }
.s-tile:disabled { opacity: .45; }
.s-tile:active { background: var(--brand-tint); }
.s-tile b { font-size: 18px; }
.s-tile span { font-size: 15px; }
.s-tile small { color: var(--ink-2); font-size: 14px; }

.s-list { list-style: none; margin: 0; padding: 0; }
.s-list li { display: flex; justify-content: space-between; gap: 10px; padding: 10px 2px; border-top: 1px solid var(--line); font-size: 15px; }
.s-list li:first-child { border-top: 0; }
.s-list li span:last-child { text-align: right; color: var(--ink-2); }
.s-hist { margin-top: 10px; }
.s-none { color: var(--ink-2); }

.s-dl { display: grid; grid-template-columns: auto 1fr; gap: 8px 16px; margin: 0; font-size: 15px; }
.s-dl dt { color: var(--ink-2); }
.s-dl dd { margin: 0; text-align: right; font-weight: 700; word-break: break-all; }
.s-dl .ok { color: var(--green); }
.s-dl .bad { color: var(--red); }

.s-toast { position: fixed; left: 50%; bottom: 16px; transform: translateX(-50%); width: calc(100% - 32px); max-width: 520px; margin: 0; padding: 14px 16px; border-radius: 14px; background: var(--surface); border: 1px solid var(--red); color: var(--red); font-weight: 700; z-index: 5; }
.s-toast.is-ok { border-color: var(--green); color: var(--green); }
```

- [ ] **Step 5: Check the script parses and the suite still passes**

Run: `cd kiosk_server && node --check public/staff/staff.js && npm test`
Expected: no syntax error; every test PASSES (the page is served unchanged by `/staff`).

- [ ] **Step 6: Commit**

```bash
git add kiosk_server/public/staff/index.html kiosk_server/public/staff/staff.js kiosk_server/public/staff/staff.css
git commit -m "feat(staff): Tools tab on the staff page"
```

---

### Task 6: Documentation

**Files:**
- Modify: `CLAUDE.md`
- Modify: `CONFIG/README.md`
- Modify: `docs/superpowers/specs/2026-09-28-counter-cash-design.md`

**Interfaces:** none.

- [ ] **Step 1: `CLAUDE.md`**

1. In the Status table, replace the row for piece 3 with:

```
| 3 | Counter cash + staff tablet: stage 1 (orders, mark paid) and stage 2 (staff tools) | **Done** — `docs/superpowers/specs/2026-09-28-counter-cash-design.md` |
```

2. In "Where things live", after the `kiosk_server/public/staff/` row add:

```
| `kiosk_server/lib/logs.js` | Reads the controller's and uploader's records for the staff tools, cached |
```

3. Replace rule 11 with:

```
11. **Do not re-add the cashier.** No staff-driven cart-and-unlock flow, no
    cashier dashboard. Staff confirm a cash payment with their PIN on the
    kiosk only when `STAFF_TABLET` is off, or as a fallback when it is on;
    everything else — sign-in, mark paid, cancel, today's sales, prices, air
    clears, waiting credits — is on the staff tablet page (`/staff`).
```

4. At the end of "How the kiosk decides things" add:

```
- **Staff tools wait for a free machine.** Prices, air clears and give back
  are refused while an order waits, presses are owed, or an ARM is on its way
  (`toolRefusal()` in `server.js`); write off never is. An air clear needs
  `confirm: true` from the page's "Put a cup under nozzle N" dialog. Every
  action goes to `logs/staff_events.jsonl` with the staff name.
- **Waiting credits have no id from the controller.** `lib/logs.js` uses
  `date_created|slot|qty`; a credit is settled by a `credit_give_back` or
  `credit_write_off` event naming it, and the list looks back 7 days.
```

- [ ] **Step 2: `CONFIG/README.md`**

Replace every mention of the old "staff menu" with the staff tablet page:

- Local sales archive: "the staff menu's today's sales reads it" → "the staff tablet's Today's sales reads it".
- Interrupted sales: "The staff menu shows today's entries" → "The staff tablet's Needs attention shows today's entries".
- Unclaimed credits: after the paragraph add: "The staff tablet's Waiting credits lists the last 7 days of entries not yet settled; **Give back** re-arms the presses on the kiosk, **Write off** closes the entry. Both are logged to `logs/staff_events.jsonl` with the staff name."
- Prices: "Prices saved from the staff menu" → "Prices saved from the staff tablet"; "Prices are editable from the kiosk's staff menu" → "Prices are editable from the staff tablet (Tools)"; add "The tablet also refuses a change while an order waits for payment."
- Prime / purge: "counted back to staff in the staff menu" → "counted back to staff on the staff tablet (Air clear)".

- [ ] **Step 3: The spec**

In `docs/superpowers/specs/2026-09-28-counter-cash-design.md`, at the end of section 4 add:

```
**Built 2026-09-29** (`docs/superpowers/plans/2026-09-29-staff-tools-stage2.md`).
Decided while planning: Waiting credits looks back 7 days and names a credit
`date_created|slot|qty`; prices on the tablet are whole pesos 1–10000; the
price history shows the last 10 changes; the Counter tab's Today list reads
`orders.jsonl`, so it survives a restart.
```

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md CONFIG/README.md docs/superpowers/specs/2026-09-28-counter-cash-design.md
git commit -m "docs: staff tools (counter cash stage 2)"
```

---

## Final verification (controller, after all tasks)

1. `cd kiosk_server && npm test` — everything passes.
2. End to end on this PC: real controller (mock GPIO) + kiosk server with `STAFF_TABLET = 1`, headless Chrome on `/staff` at phone size. Sign in, open Tools:
   - change a price → the kiosk's shop shows the new price;
   - with an order waiting, Save and the air-clear tiles are disabled with the amber note;
   - air clear nozzle 1 → dialog "Put a cup under nozzle 1" → `prime_events.jsonl` gains a line, the tile counts 1 today;
   - write a line into `logs/unclaimed_credits.jsonl`, Give back → the kiosk shows the dispense screen for exactly those presses;
   - screenshots of the Tools tab at phone and tablet widths.
