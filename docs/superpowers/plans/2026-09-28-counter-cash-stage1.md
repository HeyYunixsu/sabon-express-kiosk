# Counter Cash (Stage 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A customer who pays cash orders at the kiosk, pays at the counter, and a signed-in staff member marks the order paid from a phone or tablet on the shop Wi-Fi; the kiosk then unlocks by itself.

**Architecture:** Two new pure modules hold the rules — `lib/orders.js` (the one waiting order, its number, its 3-minute life) and `lib/sessions.js` (staff sign-in). `server.js` wires them to the controller: kiosk routes (`/api/order*`, answered only from the Pi itself) and staff routes (`/staff*`, reachable from the shop Wi-Fi when `STAFF_TABLET = 1`). Every way of confirming payment goes through one function, `confirmPaid`, which runs the spec's five checks in order. The kiosk page gets a "Pay at the counter" screen with a QR; a new staff page lives in `public/staff/`.

**Tech Stack:** Node ≥ 20 standard library only (`http`, `crypto`, `os`, `fs`), `node:test` + `node:assert`, plain browser JS/CSS, one vendored file (`qrcode-generator`, MIT).

**Spec:** `docs/superpowers/specs/2026-09-28-counter-cash-design.md` (stage 1 only).

## Global Constraints

- Node standard library only in `kiosk_server/`. No npm dependencies; `package.json` keeps no `dependencies`.
- Runs on Node 20 (the Pi) and Node 24 (this PC). No API newer than Node 20.
- Tests: `cd kiosk_server && npm test` (runs `node --test tests/*.test.js`). Files in `tests/` not ending `.test.js` are helpers.
- The six sales fields never change: `machine_id`, `vendor_id`, `voucher_id`, `amount`, `slot`, `date_created`. Nothing here writes to `transaction/`.
- `CONFIG/config.env` is never committed and never quoted in docs or commit messages.
- Dates in every log: `YYYY-MM-DD HH:MM:SS`, local time.
- Order timeout: `ORDER_PAY_TIMEOUT_S`, default **180**, clamped 60–900.
- Order number: `<KIOSK_LETTER>-<n>`, letter default `A`, `n` from 1 each day. Reference: `YYYYMMDD-<letter>-<n>`.
- Staff session: 12 hours, cookie `sabon_staff`, `HttpOnly; SameSite=Strict; Path=/staff`.
- From any address other than `127.0.0.1`, `::1`, `::ffff:127.0.0.1`, only `/staff`, `/staff/…`, `/img/…`, `/fonts/…` answer; everything else is 403. (`/img` and `/fonts` are the staff page's pictures and fonts — static, no actions.)
- `STAFF_TABLET = 1` binds the server to `0.0.0.0`; otherwise `127.0.0.1` as today.
- Look: the kiosk's black-and-blue tokens (`--bg #0B0E14`, `--surface #141925`, `--brand #3B6DF0`).
- Commit messages: imperative subject, a body saying why; no `config.env` values.

## File Map

| File | Responsibility |
|---|---|
| `kiosk_server/lib/records.js` (new) | `stamp`, `dayKey`, `appendJsonl` — shared log helpers |
| `kiosk_server/lib/orders.js` (new) | Order book: create, current, find, paid, cancel, expiry, closed list |
| `kiosk_server/lib/sessions.js` (new) | Staff sessions and the cookie |
| `kiosk_server/lib/access.js` (new) | `isLocal`, `lanAllowed`, `lanAddress` |
| `kiosk_server/server.js` | Wiring: order routes, `confirmPaid`, staff routes, access guard, bind |
| `kiosk_server/tests/helpers.js` (new) | Stub controller + kiosk starter shared by server tests |
| `kiosk_server/tests/orders.test.js` (new) | Order book unit tests |
| `kiosk_server/tests/sessions.test.js` (new) | Sessions + access unit tests |
| `kiosk_server/tests/server.test.js` | Kiosk-side server tests (rewritten for orders) |
| `kiosk_server/tests/staff_server.test.js` (new) | Staff-side server tests |
| `kiosk_server/public/js/qrcode.js` (new, vendored) | QR encoder |
| `kiosk_server/public/index.html`, `css/kiosk.css`, `js/kiosk.js` | Kiosk "Pay at the counter" screen |
| `kiosk_server/public/staff/index.html`, `staff.css`, `staff.js` (new) | Staff tablet page |
| `CONFIG/config.env.sample`, `CONFIG/README.md`, `setup_and_run.sh`, `CLAUDE.md` | Settings and docs |

---

### Task 1: Order book and shared log helpers

**Files:**
- Create: `kiosk_server/lib/records.js`
- Create: `kiosk_server/lib/orders.js`
- Test: `kiosk_server/tests/orders.test.js`

**Interfaces:**
- Produces:
  - `records.stamp(date?: Date) -> 'YYYY-MM-DD HH:MM:SS'`
  - `records.dayKey(date?: Date) -> 'YYYYMMDD'`
  - `records.appendJsonl(file: string, obj: object) -> void` (creates the directory; throws on I/O error)
  - `orders.createOrderBook({ letter='A', timeoutMs=180000, now=Date.now, onClose=(order)=>{} }) -> book`
  - `book.create(items: [{slot, qty, price}]) -> order | null` (null if one is already waiting)
  - `book.current() -> order | null` (expires a due order first)
  - `book.find(number: string) -> order | null` (waiting or closed today)
  - `book.paid(order, by: string)`, `book.cancel(order, reason: string, by?: string)`
  - `book.expireIfDue()`, `book.closed() -> order[]` (newest first, today, max 50)
  - order object: `{ number, reference, items:[{slot,qty,price}], amount, status:'waiting'|'paid'|'expired'|'cancelled', reason, by, createdAt, expiresAt, closedAt }`

- [ ] **Step 1: Write the failing tests**

Create `kiosk_server/tests/orders.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createOrderBook } = require('../lib/orders');
const { stamp, dayKey } = require('../lib/records');

// 2026-09-28 10:00:00 local time
const T0 = new Date(2026, 8, 28, 10, 0, 0).getTime();
const items = [{ slot: 1, qty: 2, price: 5 }, { slot: 3, qty: 1, price: 10 }];

function book(extra = {}) {
  let t = T0;
  const closed = [];
  const b = createOrderBook({ now: () => t, onClose: (o) => closed.push({ ...o }), ...extra });
  return { b, closed, at: (ms) => { t = T0 + ms; } };
}

test('records: stamp and dayKey are local time', () => {
  assert.strictEqual(stamp(new Date(T0)), '2026-09-28 10:00:00');
  assert.strictEqual(dayKey(new Date(T0)), '20260928');
});

test('an order is numbered, priced and frozen', () => {
  const { b } = book();
  const o = b.create(items);
  assert.strictEqual(o.number, 'A-1');
  assert.strictEqual(o.reference, '20260928-A-1');
  assert.strictEqual(o.amount, 20);
  assert.strictEqual(o.status, 'waiting');
  items[0].qty = 99;                       // the caller's array changing later...
  assert.strictEqual(o.items[0].qty, 2);   // ...does not change the order
  items[0].qty = 2;
});

test('only one order waits at a time', () => {
  const { b } = book();
  assert.ok(b.create(items));
  assert.strictEqual(b.create(items), null);
});

test('numbers count up through the day and restart the next day', () => {
  const { b, at } = book({ letter: 'B' });
  b.cancel(b.create(items), 'customer');
  assert.strictEqual(b.create(items).number, 'B-2');
  b.cancel(b.current(), 'customer');
  at(24 * 3600 * 1000);                    // next day
  const o = b.create(items);
  assert.strictEqual(o.number, 'B-1');
  assert.strictEqual(o.reference, '20260929-B-1');
});

test('expiry happens exactly at the timeout, not a millisecond before', () => {
  const { b, closed, at } = book({ timeoutMs: 180000 });
  const o = b.create(items);
  at(179999);
  assert.strictEqual(b.current(), o);
  at(180000);
  assert.strictEqual(b.current(), null);
  assert.strictEqual(closed.length, 1);
  assert.deepStrictEqual([closed[0].status, closed[0].reason], ['expired', 'timeout']);
  assert.strictEqual(b.find('A-1').status, 'expired');
});

test('paid and cancelled close the order once, with who and why', () => {
  const { b, closed } = book();
  const o = b.create(items);
  b.paid(o, 'Ana');
  assert.deepStrictEqual([o.status, o.by, o.reason], ['paid', 'Ana', null]);
  assert.strictEqual(b.current(), null);
  b.cancel(o, 'staff', 'Ben');             // already closed: nothing changes
  assert.strictEqual(o.status, 'paid');
  const o2 = b.create(items);
  b.cancel(o2, 'staff', 'Ben');
  assert.deepStrictEqual([o2.status, o2.reason, o2.by], ['cancelled', 'staff', 'Ben']);
  assert.strictEqual(closed.length, 2);
  assert.deepStrictEqual(b.closed().map((x) => x.number), ['A-2', 'A-1']);
});

test('find returns null for an order it never saw', () => {
  const { b } = book();
  assert.strictEqual(b.find('A-9'), null);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd kiosk_server && node --test tests/orders.test.js`
Expected: FAIL — `Cannot find module '../lib/orders'`.

- [ ] **Step 3: Write `lib/records.js`**

```js
'use strict';
// Local records: one JSON object per line, appended. Shared by the server and
// the order book so every log uses the same date format.

const fs = require('fs');
const path = require('path');

const pad = (n) => String(n).padStart(2, '0');

function stamp(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
       + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// The day part of an order reference, local time: 20260928.
function dayKey(d = new Date()) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

function appendJsonl(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(obj) + '\n', 'utf-8');
}

module.exports = { stamp, dayKey, appendJsonl };
```

- [ ] **Step 4: Write `lib/orders.js`**

```js
'use strict';
// The order book: at most one order waiting for payment at a time.
//
// An order is created when the customer chooses Cash, priced by the caller
// from the controller, and frozen. It then ends exactly once -- paid, expired
// or cancelled -- and onClose is told, so the server can log it and update
// the screens. Nothing here talks to the controller or the disk, so the whole
// lifecycle is tested with a fake clock.

const { dayKey } = require('./records');

function createOrderBook({ letter = 'A', timeoutMs = 180000, now = Date.now, onClose = () => {} } = {}) {
  let day = '';
  let count = 0;
  let waiting = null;
  const closed = [];           // today's closed orders, newest first

  function nextNumber() {
    const d = dayKey(new Date(now()));
    if (d !== day) { day = d; count = 0; closed.length = 0; }
    count++;
    return { number: `${letter}-${count}`, reference: `${d}-${letter}-${count}` };
  }

  function close(o, status, reason, by) {
    o.status = status;
    o.reason = reason;
    o.by = by;
    o.closedAt = now();
    if (waiting === o) waiting = null;
    closed.unshift(o);
    if (closed.length > 50) closed.pop();
    onClose(o);
  }

  // Expiry is decided by the clock at the moment anyone asks, not by a timer
  // firing: at exactly timeoutMs the order is over.
  function expireIfDue() {
    if (waiting && now() >= waiting.expiresAt) close(waiting, 'expired', 'timeout', null);
  }

  return {
    create(items) {
      expireIfDue();
      if (waiting) return null;
      const { number, reference } = nextNumber();
      const frozen = items.map(({ slot, qty, price }) => ({ slot, qty, price }));
      const t = now();
      waiting = {
        number, reference, items: frozen,
        amount: frozen.reduce((a, i) => a + i.price * i.qty, 0),
        status: 'waiting', reason: null, by: null,
        createdAt: t, expiresAt: t + timeoutMs, closedAt: null,
      };
      return waiting;
    },
    current() { expireIfDue(); return waiting; },
    find(number) {
      expireIfDue();
      if (waiting && waiting.number === number) return waiting;
      return closed.find((o) => o.number === number) || null;
    },
    paid(o, by) { if (o.status === 'waiting') close(o, 'paid', null, by); },
    cancel(o, reason, by = null) { if (o.status === 'waiting') close(o, 'cancelled', reason, by); },
    expireIfDue,
    closed() { expireIfDue(); return closed.slice(); },
  };
}

module.exports = { createOrderBook };
```

- [ ] **Step 5: Run the tests**

Run: `cd kiosk_server && node --test tests/orders.test.js`
Expected: PASS, 7 tests.

- [ ] **Step 6: Commit**

```bash
git add kiosk_server/lib/records.js kiosk_server/lib/orders.js kiosk_server/tests/orders.test.js
git commit -m "feat(kiosk): order book for counter cash

One order waits at a time, numbered <letter>-<n> per day, priced and frozen
when created, and closed exactly once: paid, expired at exactly the timeout,
or cancelled with a reason. Pure, so it is tested with a fake clock."
```

---

### Task 2: Staff sessions and the local-address check

**Files:**
- Create: `kiosk_server/lib/sessions.js`
- Create: `kiosk_server/lib/access.js`
- Test: `kiosk_server/tests/sessions.test.js`

**Interfaces:**
- Produces:
  - `sessions.createSessions({ ttlMs=43200000, now=Date.now }) -> { create(name)->token, get(token)->{name,expiresAt}|null, destroy(token) }`
  - `sessions.tokenFrom(req) -> string|null` (reads cookie `sabon_staff`)
  - `sessions.cookieFor(token, ttlMs) -> string`, `sessions.clearCookie() -> string`
  - `sessions.SESSION_MS = 43200000`
  - `access.isLocal(req) -> boolean`
  - `access.lanAllowed(url: string) -> boolean`
  - `access.lanAddress(ifaces?) -> string|null` (first non-internal IPv4)

- [ ] **Step 1: Write the failing tests**

Create `kiosk_server/tests/sessions.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createSessions, tokenFrom, cookieFor, clearCookie, SESSION_MS } = require('../lib/sessions');
const { isLocal, lanAllowed, lanAddress } = require('../lib/access');

test('a session names its staff member until it expires', () => {
  let t = 1000;
  const s = createSessions({ ttlMs: 5000, now: () => t });
  const token = s.create('Ana');
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.strictEqual(s.get(token).name, 'Ana');
  t += 4999;
  assert.ok(s.get(token));
  t += 1;
  assert.strictEqual(s.get(token), null);
});

test('sign out ends a session; unknown tokens are nobody', () => {
  const s = createSessions();
  const token = s.create('Ben');
  s.destroy(token);
  assert.strictEqual(s.get(token), null);
  assert.strictEqual(s.get('nope'), null);
  assert.strictEqual(s.get(null), null);
});

test('two sign-ins get different tokens', () => {
  const s = createSessions();
  assert.notStrictEqual(s.create('Ana'), s.create('Ana'));
});

test('the cookie is read back from a request and is locked down', () => {
  const req = { headers: { cookie: 'x=1; sabon_staff=abc123; y=2' } };
  assert.strictEqual(tokenFrom(req), 'abc123');
  assert.strictEqual(tokenFrom({ headers: {} }), null);
  const c = cookieFor('abc123', SESSION_MS);
  assert.match(c, /^sabon_staff=abc123;/);
  for (const part of ['HttpOnly', 'SameSite=Strict', 'Path=/staff', 'Max-Age=43200']) assert.ok(c.includes(part), part);
  assert.match(clearCookie(), /Max-Age=0/);
});

test('isLocal: only the Pi itself', () => {
  const req = (a) => ({ socket: { remoteAddress: a } });
  for (const a of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) assert.ok(isLocal(req(a)), a);
  for (const a of ['192.168.1.20', '::ffff:192.168.1.20', '10.0.0.5']) assert.ok(!isLocal(req(a)), a);
});

test('lanAllowed: the staff page and its pictures, nothing else', () => {
  for (const u of ['/staff', '/staff/', '/staff/order/A-3', '/staff/api/state', '/staff/staff.js',
                   '/img/products/1.webp', '/fonts/inter-v20-latin-700.woff2']) assert.ok(lanAllowed(u), u);
  for (const u of ['/', '/index.html', '/api/state', '/api/order', '/api/order/pin', '/api/dispense',
                   '/js/kiosk.js', '/staffx', '/staff/../api/order', '/staff/%2e%2e/api/order'])
    assert.ok(!lanAllowed(u), u);
});

test('lanAddress picks the first non-internal IPv4', () => {
  const ifaces = {
    lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
    wlan0: [{ family: 'IPv6', address: 'fe80::1', internal: false },
            { family: 'IPv4', address: '192.168.1.50', internal: false }],
  };
  assert.strictEqual(lanAddress(ifaces), '192.168.1.50');
  assert.strictEqual(lanAddress({ lo: ifaces.lo }), null);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd kiosk_server && node --test tests/sessions.test.js`
Expected: FAIL — `Cannot find module '../lib/sessions'`.

- [ ] **Step 3: Write `lib/sessions.js`**

```js
'use strict';
// Staff sign-in sessions for the tablet page.
//
// Held in memory, so a server restart signs everyone out -- which is the
// intended behaviour, not a limitation. The token is 32 random bytes; the
// cookie cannot be read by scripts or sent by another site.

const crypto = require('crypto');

const COOKIE = 'sabon_staff';
const SESSION_MS = 12 * 3600 * 1000;

function createSessions({ ttlMs = SESSION_MS, now = Date.now } = {}) {
  const byToken = new Map();
  return {
    create(name) {
      const token = crypto.randomBytes(32).toString('hex');
      byToken.set(token, { name, expiresAt: now() + ttlMs });
      return token;
    },
    get(token) {
      if (!token) return null;
      const s = byToken.get(token);
      if (!s) return null;
      if (now() >= s.expiresAt) { byToken.delete(token); return null; }
      return s;
    },
    destroy(token) { byToken.delete(token); },
  };
}

function tokenFrom(req) {
  const header = (req.headers && req.headers.cookie) || '';
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq !== -1 && part.slice(0, eq).trim() === COOKIE) return part.slice(eq + 1).trim();
  }
  return null;
}

const cookieFor = (token, ttlMs) =>
  `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/staff; Max-Age=${Math.floor(ttlMs / 1000)}`;
const clearCookie = () => `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/staff; Max-Age=0`;

module.exports = { createSessions, tokenFrom, cookieFor, clearCookie, SESSION_MS, COOKIE };
```

- [ ] **Step 4: Write `lib/access.js`**

```js
'use strict';
// Who may reach what. The customer screens and every action that orders,
// unlocks or pours answer only the Pi itself; a phone on the shop Wi-Fi may
// reach the staff page and the pictures and fonts it draws with.

const os = require('os');

const LOCAL = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function isLocal(req) {
  return LOCAL.has(req.socket && req.socket.remoteAddress);
}

// Matched on the raw URL, before any decoding: a dot-dot or an escape is
// refused outright rather than trusted to normalise somewhere safe.
function lanAllowed(url) {
  if (url.includes('..') || url.includes('%')) return false;
  return url === '/staff' || url.startsWith('/staff/')
      || url.startsWith('/img/') || url.startsWith('/fonts/');
}

// The address a tablet on the shop Wi-Fi uses to reach this Pi.
function lanAddress(ifaces = os.networkInterfaces()) {
  for (const list of Object.values(ifaces)) {
    for (const a of list || []) {
      if ((a.family === 'IPv4' || a.family === 4) && !a.internal) return a.address;
    }
  }
  return null;
}

module.exports = { isLocal, lanAllowed, lanAddress };
```

- [ ] **Step 5: Run the tests**

Run: `cd kiosk_server && node --test tests/sessions.test.js`
Expected: PASS, 7 tests.

- [ ] **Step 6: Commit**

```bash
git add kiosk_server/lib/sessions.js kiosk_server/lib/access.js kiosk_server/tests/sessions.test.js
git commit -m "feat(kiosk): staff sessions and the local-address check

Sessions are 12-hour, in-memory, 32 random bytes in an HttpOnly,
SameSite=Strict cookie. isLocal and lanAllowed decide what a device on the
shop Wi-Fi may reach: the staff page and its images and fonts, nothing that
orders, unlocks or pours."
```

---

### Task 3: Server — kiosk orders and `confirmPaid`

Replaces `/api/cash` with an order flow. Cash always creates an order; with the tablet off, the kiosk goes straight to the PIN pad, which confirms that order. One function, `confirmPaid`, confirms every payment.

**Files:**
- Modify: `kiosk_server/server.js` (full replacement below)
- Create: `kiosk_server/tests/helpers.js`
- Modify: `kiosk_server/tests/server.test.js` (full replacement below)

**Interfaces:**
- Consumes: Task 1 (`createOrderBook`, `stamp`, `appendJsonl`).
- Produces (HTTP, all local-only):
  - `POST /api/order {items:[{slot,qty}], amount}` → `200 {order}` | `400 bad_items` | `409 machine_busy|order_waiting|empty|price_changed` | `503 offline|no_prices`
  - `POST /api/order/pin {number, pin}` → `200 {ok, order}` | `401 wrong` | `423 locked` | `503 no_staff|offline` | `409 not_waiting|out_of_stock|price_changed|machine_busy`
  - `POST /api/order/cancel {number}` → `200 {ok}` | `409 not_waiting`
  - `GET /api/state` and the stream now carry `pending` (the waiting order or null) and `lastClosed` (the most recent closed order or null), both as `publicOrder`.
  - `publicOrder`: `{ number, reference, amount, status, reason, by, items:[{slot,qty,price,name,img}], remainingMs, totalMs, created, closed }`
  - `createKioskServer({ ..., orderTimeoutMs })` — test override for the timeout.
  - Logs: `payments.jsonl` rows gain `reference` = order reference and `via`; new `orders.jsonl`; new `staff_events.jsonl` (`pin_locked` with `where`). `pin_lockouts.jsonl` is no longer written.

- [ ] **Step 1: Create the shared test helpers**

Create `kiosk_server/tests/helpers.js`:

```js
'use strict';
// Shared by the server tests: a stub controller on a real TCP socket and a
// kiosk server started against it in a temp directory.

const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createKioskServer } = require('../server');
const { hashPin } = require('../lib/staff');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await sleep(20); }
  throw new Error('timed out waiting');
}

// STATUS every 50 ms, PRICES on request, scripted DISPENSE replies.
function stubController() {
  const stub = {
    received: [],
    armed: [0, 0, 0, 0, 0, 0],
    busy: [0, 0, 0, 0, 0, 0],
    empty: [0, 0, 0, 0, 0, 0],
    prices: '5,5,10,10,8,8',
    silent: false,
    dispenseReplies: [],
    sockets: new Set(),
  };
  const line = () => ['STATUS', ...stub.armed, 0, 0, 0, 0, 0, 0, ...stub.empty,
    ...stub.busy, 0, 0, 0, 0, 0, 0, 0, 0, 0].join(',') + '\n';
  stub.server = net.createServer((s) => {
    let buf = '';
    stub.sockets.add(s);
    const timer = setInterval(() => { if (!stub.silent) s.write(line()); }, 50);
    s.on('close', () => { clearInterval(timer); stub.sockets.delete(s); });
    s.on('error', () => {});
    s.on('data', (d) => {
      buf += d;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const l of lines) {
        stub.received.push(l);
        const [verb, slot] = l.split(',');
        if (verb === 'GETPRICES') s.write(`PRICES,${stub.prices}\n`);
        if (verb === 'DISPENSE') s.write(`DISPENSE_ACK,${slot},${stub.dispenseReplies.shift() || 'no_credit'}\n`);
        if (verb === 'PAUSE') s.write(`PAUSE_ACK,${slot},ok\n`);
      }
    });
  });
  // Push a line to the kiosk unasked, as the controller does after SETPRICE.
  stub.sendLine = (l) => { for (const s of stub.sockets) s.write(l + '\n'); };
  stub.close = () => {
    for (const s of stub.sockets) s.destroy();
    stub.server.close();
  };
  return new Promise((r) => stub.server.listen(0, '127.0.0.1', () => {
    stub.port = stub.server.address().port;
    r(stub);
  }));
}

// config: extra config.env lines. host: where the kiosk listens.
async function startKiosk(stub, { config = [], host = '127.0.0.1', orderTimeoutMs } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiosk-'));
  fs.mkdirSync(path.join(dir, 'CONFIG'));
  fs.writeFileSync(path.join(dir, 'CONFIG', 'config.env'), [
    `SOCKET_PORT = ${stub.port}`,
    'PRODUCT1_NAME = Detergent 1',
    'STAFF1_NAME = Ana',
    `STAFF1_PIN_HASH = ${hashPin('4821')}`,
    'STAFF2_NAME = Ben',
    `STAFF2_PIN_HASH = ${hashPin('7777')}`,
    ...config,
  ].join('\n'));
  const k = createKioskServer({
    root: dir,
    controller: { offlineMs: 400, reconnectMs: 100 },
    orderTimeoutMs,
    log: () => {},
  });
  await new Promise((r) => k.server.listen(0, host, r));
  k.port = k.server.address().port;
  k.url = `http://127.0.0.1:${k.port}`;
  k.dir = dir;
  k.post = async (p, body, headers = {}) => {
    const res = await fetch(k.url + p, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    return { code: res.status, body: await res.json().catch(() => ({})), headers: res.headers };
  };
  k.get = async (p, headers = {}) => {
    const res = await fetch(k.url + p, { headers });
    return { code: res.status, body: await res.json().catch(() => ({})) };
  };
  k.rows = (name) => {
    const f = path.join(dir, 'logs', name);
    if (!fs.existsSync(f)) return [];
    return fs.readFileSync(f, 'utf-8').trim().split('\n').filter(Boolean).map(JSON.parse);
  };
  await until(() => k.ctrl.online && Object.keys(k.ctrl.prices).length === 6);
  return k;
}

const arms = (stub) => stub.received.filter((l) => l.startsWith('ARM'));
const sale = { items: [{ slot: 1, qty: 2 }, { slot: 3, qty: 1 }], amount: 20 };

module.exports = { sleep, until, stubController, startKiosk, arms, sale };
```

- [ ] **Step 2: Rewrite `tests/server.test.js` for orders (failing)**

Replace the whole file with:

```js
'use strict';
// The kiosk side of the server, against a stub controller over real TCP.
const test = require('node:test');
const assert = require('node:assert');
const { parseStatus } = require('../lib/controller');
const { sleep, until, stubController, startKiosk, arms, sale } = require('./helpers');

async function kiosk(t, opts) {
  const stub = await stubController();
  const k = await startKiosk(stub, opts);
  t.after(() => { k.close(); stub.close(); });
  return { stub, k };
}

test('parseStatus reads all six slots and rejects a torn line', () => {
  const s = parseStatus('STATUS,2,0,0,0,0,0,1500,0,0,0,0,0,0,0,1,0,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,1,0');
  assert.deepStrictEqual(s.slots[0], { slot: 1, armed: 2, remainingMs: 1500, empty: false, busy: true, queued: 0 });
  assert.strictEqual(s.slots[2].empty, true);
  assert.strictEqual(parseStatus('STATUS,1,2,3'), null);
});

test('creating an order', async (t) => {
  const { stub, k } = await kiosk(t);

  await t.test('a total that is not the controller\'s price is refused', async () => {
    const r = await k.post('/api/order', { ...sale, amount: 15 });
    assert.deepStrictEqual([r.code, r.body.error, r.body.amount], [409, 'price_changed', 20]);
  });

  await t.test('an empty tank cannot be ordered', async () => {
    stub.empty[2] = 1;
    await sleep(150);
    const r = await k.post('/api/order', sale);
    assert.deepStrictEqual([r.code, r.body.error, r.body.slot], [409, 'empty', 3]);
    stub.empty[2] = 0;
    await sleep(150);
  });

  await t.test('a good order is numbered, priced, and arms nothing yet', async () => {
    const r = await k.post('/api/order', sale);
    assert.strictEqual(r.code, 200);
    assert.strictEqual(r.body.order.number, 'A-1');
    assert.match(r.body.order.reference, /^\d{8}-A-1$/);
    assert.strictEqual(r.body.order.amount, 20);
    assert.strictEqual(r.body.order.items[0].name, 'Detergent 1');
    assert.ok(r.body.order.remainingMs > 170000);
    assert.strictEqual(r.body.order.totalMs, 180000);
    assert.deepStrictEqual(arms(stub), []);
    const s = await k.get('/api/state');
    assert.strictEqual(s.body.pending.number, 'A-1');
  });

  await t.test('a second order is refused while one waits', async () => {
    const r = await k.post('/api/order', sale);
    assert.deepStrictEqual([r.code, r.body.error], [409, 'order_waiting']);
  });

  await t.test('the customer can cancel it', async () => {
    const r = await k.post('/api/order/cancel', { number: 'A-1' });
    assert.strictEqual(r.code, 200);
    const s = await k.get('/api/state');
    assert.strictEqual(s.body.pending, null);
    assert.deepStrictEqual([s.body.lastClosed.number, s.body.lastClosed.status, s.body.lastClosed.reason],
      ['A-1', 'cancelled', 'customer']);
    const rows = k.rows('orders.jsonl');
    assert.deepStrictEqual([rows[0].status, rows[0].reason, rows[0].items], ['cancelled', 'customer', '1:2,3:1']);
  });
});

test('the kiosk PIN confirms the waiting order', async (t) => {
  const { stub, k } = await kiosk(t);
  const { body } = await k.post('/api/order', sale);
  const number = body.order.number;

  await t.test('a wrong PIN never arms', async () => {
    const r = await k.post('/api/order/pin', { number, pin: '0000' });
    assert.strictEqual(r.code, 401);
    assert.deepStrictEqual(arms(stub), []);
  });

  await t.test('a PIN for a different order is refused', async () => {
    const r = await k.post('/api/order/pin', { number: 'A-9', pin: '4821' });
    assert.deepStrictEqual([r.code, r.body.error], [409, 'not_waiting']);
  });

  await t.test('the right PIN arms the batch and logs who took the cash', async () => {
    const r = await k.post('/api/order/pin', { number, pin: '4821' });
    assert.strictEqual(r.code, 200);
    await until(() => arms(stub).length === 1);
    assert.deepStrictEqual(arms(stub), ['ARM_BATCH,1:2,3:1']);
    const pay = k.rows('payments.jsonl');
    assert.strictEqual(pay.length, 1);
    assert.deepStrictEqual(
      { reference: pay[0].reference, method: pay[0].method, amount: pay[0].amount, staff: pay[0].staff, via: pay[0].via, items: pay[0].items },
      { reference: body.order.reference, method: 'cash', amount: 20, staff: 'Ana', via: 'kiosk_pin', items: '1:2,3:1' });
    assert.match(pay[0].date_created, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
    const ord = k.rows('orders.jsonl');
    assert.deepStrictEqual([ord[0].status, ord[0].by], ['paid', 'Ana']);
  });

  await t.test('the paid order reaches the page for the dispense cards', async () => {
    const s = await k.get('/api/state');
    assert.deepStrictEqual(s.body.order.items, sale.items);
    assert.strictEqual(s.body.order.staff, 'Ana');
  });

  await t.test('the same order cannot be paid twice', async () => {
    const r = await k.post('/api/order/pin', { number, pin: '4821' });
    assert.deepStrictEqual([r.code, r.body.error], [409, 'not_waiting']);
    assert.strictEqual(arms(stub).length, 1);
  });

  await t.test('no new order while paid presses are still on the machine', async () => {
    stub.armed[0] = 2;
    await sleep(3100);   // past the post-ARM guard, so only STATUS is holding it
    const r = await k.post('/api/order', sale);
    assert.deepStrictEqual([r.code, r.body.error], [409, 'machine_busy']);
    stub.armed[0] = 0;
  });
});

test('an order expires and can no longer be paid', async (t) => {
  const { stub, k } = await kiosk(t, { orderTimeoutMs: 300 });
  const { body } = await k.post('/api/order', sale);
  await sleep(700);    // past the timeout and at least one expiry tick
  const s = await k.get('/api/state');
  assert.strictEqual(s.body.pending, null);
  assert.deepStrictEqual([s.body.lastClosed.status, s.body.lastClosed.reason], ['expired', 'timeout']);
  const r = await k.post('/api/order/pin', { number: body.order.number, pin: '4821' });
  assert.deepStrictEqual([r.code, r.body.error], [409, 'not_waiting']);
  assert.deepStrictEqual(arms(stub), []);
  assert.strictEqual(k.rows('orders.jsonl')[0].status, 'expired');
});

test('confirming checks stock and prices at the moment of payment', async (t) => {
  await t.test('a tank that ran out cancels the order', async (t2) => {
    const { stub, k } = await kiosk(t2);
    const { body } = await k.post('/api/order', sale);
    stub.empty[0] = 1;
    await sleep(150);
    const r = await k.post('/api/order/pin', { number: body.order.number, pin: '4821' });
    assert.deepStrictEqual([r.code, r.body.error], [409, 'out_of_stock']);
    assert.deepStrictEqual(arms(stub), []);
    assert.strictEqual(k.rows('orders.jsonl')[0].reason, 'out_of_stock');
  });

  await t.test('a price change cancels the order', async (t2) => {
    const { stub, k } = await kiosk(t2);
    const { body } = await k.post('/api/order', sale);
    stub.sendLine('PRICES,6,5,10,10,8,8');
    await until(() => k.ctrl.prices[1] === 6);
    const r = await k.post('/api/order/pin', { number: body.order.number, pin: '4821' });
    assert.deepStrictEqual([r.code, r.body.error], [409, 'price_changed']);
    assert.deepStrictEqual(arms(stub), []);
  });

  await t.test('offline refuses but the order keeps waiting', async (t2) => {
    const { stub, k } = await kiosk(t2);
    const { body } = await k.post('/api/order', sale);
    stub.silent = true;
    await until(() => !k.ctrl.online, 2000);
    const r = await k.post('/api/order/pin', { number: body.order.number, pin: '4821' });
    assert.deepStrictEqual([r.code, r.body.error], [503, 'offline']);
    stub.silent = false;
    await until(() => k.ctrl.online, 2000);
    const s = await k.get('/api/state');
    assert.strictEqual(s.body.pending.number, body.order.number);
  });
});

test('five wrong kiosk PINs lock the pad and log it', async (t) => {
  const { stub, k } = await kiosk(t);
  const { body } = await k.post('/api/order', sale);
  const number = body.order.number;
  for (let i = 0; i < 4; i++) assert.strictEqual((await k.post('/api/order/pin', { number, pin: '1111' })).code, 401);
  assert.strictEqual((await k.post('/api/order/pin', { number, pin: '1111' })).code, 423);
  assert.strictEqual((await k.post('/api/order/pin', { number, pin: '4821' })).code, 423);
  assert.deepStrictEqual(arms(stub), []);
  const ev = k.rows('staff_events.jsonl');
  assert.deepStrictEqual([ev[0].event, ev[0].where], ['pin_locked', 'kiosk']);
});

test('one tap dispenses exactly one unit, retrying the cooldown', async (t) => {
  const { stub, k } = await kiosk(t);
  stub.dispenseReplies = ['cooldown', 'ok', 'ok'];
  const r = await k.post('/api/dispense', { slot: 2 });
  assert.deepStrictEqual(r.body, { result: 'ok', poured: 1 });
  assert.strictEqual(stub.received.filter((l) => l === 'DISPENSE,2').length, 2);
});

test('dispense with no credit at all is reported, not called success', async (t) => {
  const { k } = await kiosk(t);
  const r = await k.post('/api/dispense', { slot: 2 });
  assert.deepStrictEqual(r.body, { result: 'no_credit', poured: 0 });
});

test('pause answers with the controller\'s ACK', async (t) => {
  const { k } = await kiosk(t);
  assert.deepStrictEqual((await k.post('/api/pause', { slot: 4 })).body, { result: 'ok' });
  assert.strictEqual((await k.post('/api/pause', { slot: 9 })).code, 400);
});

test('STATUS silence marks the machine offline and stops new orders', async (t) => {
  const { stub, k } = await kiosk(t);
  stub.silent = true;
  await until(() => !k.ctrl.online, 2000);
  const r = await k.post('/api/order', sale);
  assert.deepStrictEqual([r.code, r.body.error], [503, 'offline']);
  stub.silent = false;
  await until(() => k.ctrl.online, 2000);
});

test('static files are served and cannot escape public/', async (t) => {
  const { k } = await kiosk(t);
  const page = await fetch(k.url + '/');
  assert.strictEqual(page.status, 200);
  assert.match(await page.text(), /<html/i);
  const escape = await fetch(k.url + '/%2e%2e/server.js');
  assert.notStrictEqual(escape.status, 200);
});
```

- [ ] **Step 3: Run to see them fail**

Run: `cd kiosk_server && node --test tests/server.test.js`
Expected: FAIL — `/api/order` answers 405 (the route does not exist yet).

- [ ] **Step 4: Replace `kiosk_server/server.js`**

```js
'use strict';
// Sabon Express Kiosk server.
//
// Serves the touchscreen UI and stands between it and the controller. The
// browser never talks to the controller directly: it sees parsed state over
// /api/stream and asks for actions over POST, and this process decides what
// is allowed -- above all, what a cash sale costs and who confirmed it.
//
// Cash is an order: the kiosk creates it, staff confirm it (on the kiosk's
// PIN pad, or from the staff tablet), and confirmPaid() is the one place that
// turns a confirmation into presses on the machine.
//
// Node standard library only, so a Pi needs no npm install for it.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { createController, dispensePaid, SLOTS } = require('./lib/controller');
const { loadStaff, createPinPad } = require('./lib/staff');
const { stamp, appendJsonl } = require('./lib/records');
const { createOrderBook } = require('./lib/orders');

const MAX_QTY = 20;

function loadEnv(file) {
  const vars = {};
  let text = '';
  try { text = fs.readFileSync(file, 'utf-8'); } catch (e) {
    console.error(`[kiosk] could not read ${file}: ${e.message}`);
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (/^(['"]).*\1$/.test(val)) val = val.slice(1, -1);
    if (key) vars[key] = val;
  }
  return vars;
}

function clampInt(v, lo, hi, dflt) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2', '.ico': 'image/x-icon',
};

function createKioskServer({
  root = path.resolve(__dirname, '..'),
  configPath = path.join(root, 'CONFIG', 'config.env'),
  logsDir = path.join(root, 'logs'),
  controller = {},
  orderTimeoutMs,
  log = console.log,
} = {}) {
  const config = loadEnv(configPath);
  const publicDir = path.join(__dirname, 'public');
  const paymentsLog = path.join(logsDir, 'payments.jsonl');
  const ordersLog = path.join(logsDir, 'orders.jsonl');
  const staffLog = path.join(logsDir, 'staff_events.jsonl');

  const products = [];
  for (let i = 1; i <= SLOTS; i++) {
    products.push({
      slot: i,
      name: config[`PRODUCT${i}_NAME`] || `Product ${i}`,
      ml: parseInt(config[`PRODUCT${i}_ML`] || '0', 10) || 0,
      img: `/img/products/${i}.webp`,
    });
  }
  const idleSeconds = parseInt(config.KIOSK_IDLE_S || '60', 10) || 60;
  const staffTablet = config.STAFF_TABLET === '1';
  const letter = /^[A-Z]$/.test(config.KIOSK_LETTER || '') ? config.KIOSK_LETTER : 'A';
  const timeoutMs = orderTimeoutMs || clampInt(config.ORDER_PAY_TIMEOUT_S, 60, 900, 180) * 1000;

  // A record that cannot be written must not break the sale in front of the
  // customer -- but it must be loud.
  function record(file, obj) {
    try { appendJsonl(file, obj); }
    catch (e) { log(`[kiosk] NOT LOGGED to ${path.basename(file)} ${JSON.stringify(obj)}: ${e.message}`); }
  }
  function staffEvent(event, fields = {}) {
    record(staffLog, { event, ...fields, date_created: stamp() });
  }

  const staff = loadStaff(config);
  const kioskPad = createPinPad(staff, {
    onLock: () => {
      log('[kiosk] kiosk PIN pad locked after repeated wrong PINs');
      staffEvent('pin_locked', { where: 'kiosk' });
    },
  });

  const ctrl = createController({
    host: config.SOCKET_IP || '127.0.0.1',
    port: parseInt(config.SOCKET_PORT || '8080', 10),
    log,
    ...controller,
  });

  // ---- orders -------------------------------------------------------------
  const itemsText = (items) => items.map((i) => `${i.slot}:${i.qty}`).join(',');
  const orders = createOrderBook({
    letter,
    timeoutMs,
    onClose: (o) => {
      record(ordersLog, {
        reference: o.reference, items: itemsText(o.items), amount: o.amount,
        status: o.status, reason: o.reason, by: o.by,
        created: stamp(new Date(o.createdAt)), closed: stamp(new Date(o.closedAt)),
      });
      log(`[kiosk] order ${o.number} ${o.status}${o.reason ? ` (${o.reason})` : ''}${o.by ? ` by ${o.by}` : ''}`);
      push();
    },
  });
  // Expiry is decided at request time; this only makes sure the screens hear
  // about it promptly when nobody is asking.
  const expiryTimer = setInterval(() => orders.expireIfDue(), 500);

  function publicOrder(o) {
    if (!o) return null;
    return {
      number: o.number, reference: o.reference, amount: o.amount,
      status: o.status, reason: o.reason, by: o.by,
      items: o.items.map((i) => ({
        slot: i.slot, qty: i.qty, price: i.price,
        name: products[i.slot - 1].name, img: products[i.slot - 1].img,
      })),
      remainingMs: o.status === 'waiting' ? Math.max(0, o.expiresAt - Date.now()) : 0,
      totalMs: o.expiresAt - o.createdAt,
      created: stamp(new Date(o.createdAt)),
      closed: o.closedAt ? stamp(new Date(o.closedAt)) : null,
    };
  }

  // ---- live state to the browser ----------------------------------------
  const streams = new Set();
  // The order being dispensed: what was bought, so the screen can say "1 of
  // 2 dispensed". STATUS only knows what is still owed. Held in memory; after
  // a restart the page rebuilds it from what STATUS still owes.
  let dispenseOrder = null;
  function snapshot() {
    const closed = orders.closed();
    return {
      online: ctrl.online, status: ctrl.status, prices: ctrl.prices,
      order: dispenseOrder,
      pending: publicOrder(orders.current()),
      lastClosed: publicOrder(closed[0] || null),
    };
  }
  function push() {
    const data = `data: ${JSON.stringify(snapshot())}\n\n`;
    for (const res of streams) res.write(data);
  }
  ctrl.on('status', push);
  ctrl.on('online', push);
  ctrl.on('prices', push);

  // ---- helpers ------------------------------------------------------------
  function json(res, code, body) {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  }
  function readBody(req) {
    return new Promise((resolve) => {
      let data = '';
      req.on('data', (c) => {
        data += c;
        if (data.length > 10 * 1024) { data = ''; req.destroy(); }
      });
      req.on('end', () => {
        try { resolve(JSON.parse(data || '{}')); } catch (_) { resolve(null); }
      });
    });
  }
  const validSlot = (s) => Number.isInteger(s) && s >= 1 && s <= SLOTS;
  const machineInUse = () =>
    !ctrl.status || ctrl.status.slots.some((s) => s.armed > 0 || s.busy || s.queued > 0);
  const pinRefusal = (who) => [
    who.reason === 'locked' ? 423 : who.reason === 'no_staff' ? 503 : 401,
    { error: who.reason, retryInMs: who.retryInMs },
  ];

  // Between sending ARM and the STATUS that shows it, the machine still looks
  // free. Without this, a second confirm in that half second arms twice.
  let armingUntil = 0;
  const dispensing = new Set();

  // The price is the controller's, never the page's.
  function priceItems(raw) {
    const items = Array.isArray(raw) ? raw : [];
    if (items.length === 0) return { code: 400, body: { error: 'bad_items' } };
    const seen = new Set();
    for (const it of items) {
      if (!it || !validSlot(it.slot) || seen.has(it.slot)) return { code: 400, body: { error: 'bad_items' } };
      if (!Number.isInteger(it.qty) || it.qty < 1 || it.qty > MAX_QTY) return { code: 400, body: { error: 'bad_items' } };
      seen.add(it.slot);
    }
    const priced = [];
    for (const it of items) {
      if (ctrl.status.slots[it.slot - 1].empty) return { code: 409, body: { error: 'empty', slot: it.slot } };
      const price = ctrl.prices[it.slot];
      if (!Number.isInteger(price)) return { code: 503, body: { error: 'no_prices' } };
      priced.push({ slot: it.slot, qty: it.qty, price });
    }
    return { items: priced, amount: priced.reduce((a, i) => a + i.price * i.qty, 0) };
  }

  // The one way a payment becomes presses. The spec's five checks, in order,
  // stopping at the first failure. Returns [httpCode, body].
  function confirmPaid(o, name, via) {
    orders.expireIfDue();
    if (!o || o.status !== 'waiting') return [409, { error: 'not_waiting', order: publicOrder(o) }];
    if (!ctrl.online) return [503, { error: 'offline' }];
    if (o.items.some((i) => ctrl.status.slots[i.slot - 1].empty)) {
      orders.cancel(o, 'out_of_stock');
      return [409, { error: 'out_of_stock', order: publicOrder(o) }];
    }
    if (o.items.some((i) => ctrl.prices[i.slot] !== i.price)) {
      orders.cancel(o, 'price_changed');
      return [409, { error: 'price_changed', order: publicOrder(o) }];
    }
    if (Date.now() < armingUntil || machineInUse()) return [409, { error: 'machine_busy' }];
    const batch = itemsText(o.items);
    if (!ctrl.send(`ARM_BATCH,${batch}`)) return [503, { error: 'offline' }];
    armingUntil = Date.now() + 3000;
    record(paymentsLog, {
      reference: o.reference, method: 'cash', amount: o.amount, items: batch,
      staff: name, via, date_created: stamp(),
    });
    dispenseOrder = { reference: o.reference, staff: name, items: o.items.map(({ slot, qty }) => ({ slot, qty })) };
    log(`[kiosk] cash ${o.reference} P${o.amount} by ${name} via ${via}: ARM_BATCH,${batch}`);
    orders.paid(o, name);   // onClose pushes the new state to the screens
    return [200, { ok: true, order: publicOrder(o) }];
  }

  // ---- kiosk routes -------------------------------------------------------
  async function createOrder(req, res) {
    const body = await readBody(req);
    if (!body) return json(res, 400, { error: 'bad_request' });
    if (!ctrl.online) return json(res, 503, { error: 'offline' });
    if (Date.now() < armingUntil || machineInUse()) return json(res, 409, { error: 'machine_busy' });
    if (orders.current()) return json(res, 409, { error: 'order_waiting', order: publicOrder(orders.current()) });
    const p = priceItems(body.items);
    if (p.code) return json(res, p.code, p.body);
    if (body.amount !== p.amount) return json(res, 409, { error: 'price_changed', amount: p.amount });
    const o = orders.create(p.items);
    log(`[kiosk] order ${o.number} P${o.amount}: ${itemsText(o.items)}`);
    push();
    json(res, 200, { order: publicOrder(o) });
  }

  async function orderPin(req, res) {
    const body = await readBody(req);
    if (!body) return json(res, 400, { error: 'bad_request' });
    const o = orders.current();
    if (!o || o.number !== body.number) {
      return json(res, 409, { error: 'not_waiting', order: publicOrder(orders.find(body.number)) });
    }
    const who = kioskPad.check(body.pin);
    if (!who.ok) return json(res, ...pinRefusal(who));
    json(res, ...confirmPaid(o, who.name, 'kiosk_pin'));
  }

  async function orderCancel(req, res) {
    const body = await readBody(req);
    const o = orders.current();
    if (!body || !o || o.number !== body.number) return json(res, 409, { error: 'not_waiting' });
    orders.cancel(o, 'customer');
    json(res, 200, { ok: true });
  }

  async function slotCommand(req, res, verb) {
    const body = await readBody(req);
    const slot = body && body.slot;
    if (!validSlot(slot)) return json(res, 400, { error: 'bad_slot' });
    if (!ctrl.online) return json(res, 503, { error: 'offline' });

    if (verb === 'DISPENSE') {
      if (dispensing.has(slot)) return json(res, 409, { error: 'already_dispensing' });
      dispensing.add(slot);
      // One unit per tap, so the customer can count them off and swap
      // bottles between units.
      try {
        return json(res, 200, await dispensePaid(ctrl, slot, { maxPresses: 1 }));
      } finally {
        dispensing.delete(slot);
      }
    }
    json(res, 200, { result: await ctrl.request(`${verb},${slot}`) });
  }

  function stream(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
    streams.add(res);
    // State, not a comment, once a second: the page times out on silence, so
    // a live server must never look silent just because nothing changed.
    const beat = setInterval(() => res.write(`data: ${JSON.stringify(snapshot())}\n\n`), 1000);
    req.on('close', () => { clearInterval(beat); streams.delete(res); });
  }

  function serveStatic(req, res) {
    let rel;
    try { rel = decodeURIComponent(req.url.split('?')[0]); } catch (_) { rel = ''; }
    if (rel === '/') rel = '/index.html';
    const file = path.normalize(path.join(publicDir, rel));
    if (!file.startsWith(publicDir + path.sep)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end('Not found'); }
      const ext = path.extname(file).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        // Revalidate the page itself so a git pull shows on the next load;
        // fonts and images never change under the same name.
        'Cache-Control': /\.(html|css|js)$/.test(ext) ? 'no-cache' : 'max-age=86400',
      });
      res.end(data);
    });
  }

  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (req.method === 'GET' && url === '/api/state') {
      return json(res, 200, { products, idleSeconds, cashReady: staff.length > 0, staffTablet, ...snapshot() });
    }
    if (req.method === 'GET' && url === '/api/stream') return stream(req, res);
    if (req.method === 'POST' && url === '/api/order') return createOrder(req, res);
    if (req.method === 'POST' && url === '/api/order/pin') return orderPin(req, res);
    if (req.method === 'POST' && url === '/api/order/cancel') return orderCancel(req, res);
    if (req.method === 'POST' && url === '/api/dispense') return slotCommand(req, res, 'DISPENSE');
    if (req.method === 'POST' && url === '/api/pause') return slotCommand(req, res, 'PAUSE');
    if (req.method === 'POST' && url === '/api/resume') return slotCommand(req, res, 'RESUME');
    if (req.method === 'GET') return serveStatic(req, res);
    res.writeHead(405); res.end();
  });

  return {
    server,
    ctrl,
    port: parseInt(config.KIOSK_PORT || '3000', 10),
    close() {
      clearInterval(expiryTimer);
      ctrl.close();
      for (const res of streams) res.end();
      server.close();
      server.closeAllConnections();
    },
  };
}

module.exports = { createKioskServer, loadEnv };

if (require.main === module) {
  const k = createKioskServer();
  // Loopback only: the touchscreen is on this Pi, and a server that takes
  // payment confirmations has no business answering the shop LAN.
  k.server.listen(k.port, '127.0.0.1', () =>
    console.log(`[kiosk] listening on http://localhost:${k.port}/`));
}
```

- [ ] **Step 5: Run the whole suite**

Run: `cd kiosk_server && npm test`
Expected: PASS — every test in `orders`, `sessions`, `server` and `staff` (the existing `staff.test.js` is the PIN-hash suite and is unchanged).

- [ ] **Step 6: Commit**

```bash
git add kiosk_server/server.js kiosk_server/tests/helpers.js kiosk_server/tests/server.test.js
git commit -m "feat(kiosk): cash is an order; confirmPaid is the one way to pay

/api/cash is replaced by /api/order, /api/order/pin and /api/order/cancel.
An order is priced from the controller and frozen; confirmPaid runs the
spec's five checks in order -- still waiting, machine online, stock, prices
unchanged, ARM sent -- before anything is armed. Payments gain the order
reference and 'via'; orders.jsonl records every outcome; lockouts move to
staff_events.jsonl."
```

---

### Task 4: Server — the staff tablet routes and the Wi-Fi guard

**Files:**
- Modify: `kiosk_server/server.js`
- Create: `kiosk_server/tests/staff_server.test.js`
- Create: `kiosk_server/public/staff/index.html` (placeholder; Task 6 replaces it)

**Interfaces:**
- Consumes: Task 2 (`createSessions`, `tokenFrom`, `cookieFor`, `clearCookie`, `SESSION_MS`, `isLocal`, `lanAllowed`, `lanAddress`); Task 3 (`confirmPaid`, `orders`, `publicOrder`, `staffEvent`, `json`, `readBody`, `serveStatic`, `machineInUse`, `pinRefusal`).
- Produces (HTTP):
  - `GET /staff`, `/staff/`, `/staff/order/<A-n>` → `public/staff/index.html`
  - `POST /staff/api/login {pin}` → `200 {name}` + `Set-Cookie` | `401|423|503`; `415` if not JSON
  - `POST /staff/api/logout` → `200 {ok}` + cleared cookie
  - `GET /staff/api/me` → `200 {name}` | `401 signed_out`
  - `GET /staff/api/state` → `200 { online, machine:'ready'|'dispensing'|'offline', pending, today:{paid, total, orders:[publicOrder]} }`
  - `GET /staff/api/order?number=A-3` → `200 {order}` | `404`
  - `POST /staff/api/orders/paid {number}` → as `confirmPaid` (via `tablet`) | `409 not_waiting`
  - `POST /staff/api/orders/cancel {number}` → `200 {ok, order}` (reason `staff`, by name) | `409 not_waiting`
  - `GET /api/state` also returns `staffBase` (e.g. `http://192.168.1.50:3000`, or `null` with the tablet off / no LAN).
  - `createKioskServer` return value gains `host` (`'0.0.0.0'` if `STAFF_TABLET = 1`, else `'127.0.0.1'`).
  - Logs: `staff_events.jsonl` gets `sign_in`, `sign_out`, and `pin_locked` with `where: 'tablet'`.

- [ ] **Step 1: Write the failing tests**

Create `kiosk_server/tests/staff_server.test.js`:

```js
'use strict';
// The staff tablet side of the server.
const test = require('node:test');
const assert = require('node:assert');
const { lanAddress } = require('../lib/access');
const { until, stubController, startKiosk, arms, sale } = require('./helpers');

async function kiosk(t, opts) {
  const stub = await stubController();
  const k = await startKiosk(stub, opts);
  t.after(() => { k.close(); stub.close(); });
  return { stub, k };
}

async function signIn(k, pin = '4821') {
  const r = await k.post('/staff/api/login', { pin });
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
  return { r, headers: { cookie } };
}

test('staff sign in once and are named on every action', async (t) => {
  const { stub, k } = await kiosk(t);

  await t.test('without signing in, every staff API says signed_out', async () => {
    assert.strictEqual((await k.get('/staff/api/state')).code, 401);
    assert.strictEqual((await k.post('/staff/api/orders/paid', { number: 'A-1' })).code, 401);
  });

  await t.test('a wrong PIN signs nobody in', async () => {
    const { r } = await signIn(k, '0000');
    assert.strictEqual(r.code, 401);
  });

  await t.test('a login that is not JSON is refused', async () => {
    const res = await fetch(k.url + '/staff/api/login', {
      method: 'POST', body: 'pin=4821',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    assert.strictEqual(res.status, 415);
  });

  const { r, headers } = await signIn(k, '7777');
  await t.test('the right PIN names the person and sets a locked-down cookie', () => {
    assert.deepStrictEqual([r.code, r.body.name], [200, 'Ben']);
    const c = r.headers.get('set-cookie');
    assert.ok(c.includes('HttpOnly') && c.includes('SameSite=Strict') && c.includes('Path=/staff'));
  });

  await t.test('state shows the waiting order', async () => {
    await k.post('/api/order', sale);
    const s = await k.get('/staff/api/state', headers);
    assert.strictEqual(s.code, 200);
    assert.strictEqual(s.body.machine, 'ready');
    assert.strictEqual(s.body.pending.number, 'A-1');
    assert.strictEqual(s.body.pending.items[0].name, 'Detergent 1');
  });

  await t.test('mark paid arms, logs Ben and via tablet', async () => {
    const p = await k.post('/staff/api/orders/paid', { number: 'A-1' }, headers);
    assert.strictEqual(p.code, 200);
    await until(() => arms(stub).length === 1);
    const pay = k.rows('payments.jsonl');
    assert.deepStrictEqual([pay[0].staff, pay[0].via, pay[0].amount], ['Ben', 'tablet', 20]);
    const s = await k.get('/staff/api/state', headers);
    assert.deepStrictEqual([s.body.today.paid, s.body.today.total], [1, 20]);
    assert.deepStrictEqual([s.body.today.orders[0].number, s.body.today.orders[0].by], ['A-1', 'Ben']);
  });

  await t.test('a scanned QR for a closed order shows what happened', async () => {
    const o = await k.get('/staff/api/order?number=A-1', headers);
    assert.deepStrictEqual([o.code, o.body.order.status, o.body.order.by], [200, 'paid', 'Ben']);
    assert.strictEqual((await k.get('/staff/api/order?number=A-99', headers)).code, 404);
  });

  await t.test('sign out ends the session', async () => {
    await k.post('/staff/api/logout', {}, headers);
    assert.strictEqual((await k.get('/staff/api/me', headers)).code, 401);
    const ev = k.rows('staff_events.jsonl').map((e) => [e.event, e.staff]);
    assert.deepStrictEqual(ev, [['sign_in', 'Ben'], ['sign_out', 'Ben']]);
  });
});

test('staff can cancel the waiting order', async (t) => {
  const { stub, k } = await kiosk(t);
  const { headers } = await signIn(k);
  await k.post('/api/order', sale);
  const r = await k.post('/staff/api/orders/cancel', { number: 'A-1' }, headers);
  assert.strictEqual(r.code, 200);
  assert.deepStrictEqual(arms(stub), []);
  const row = k.rows('orders.jsonl')[0];
  assert.deepStrictEqual([row.status, row.reason, row.by], ['cancelled', 'staff', 'Ana']);
  const again = await k.post('/staff/api/orders/paid', { number: 'A-1' }, headers);
  assert.deepStrictEqual([again.code, again.body.error], [409, 'not_waiting']);
});

test('five wrong tablet PINs lock the tablet pad, not the kiosk pad', async (t) => {
  const { k } = await kiosk(t);
  for (let i = 0; i < 4; i++) assert.strictEqual((await signIn(k, '1111')).r.code, 401);
  assert.strictEqual((await signIn(k, '1111')).r.code, 423);
  assert.strictEqual((await signIn(k, '4821')).r.code, 423);
  const { body } = await k.post('/api/order', sale);
  const r = await k.post('/api/order/pin', { number: body.order.number, pin: '4821' });
  assert.strictEqual(r.code, 200);
  const ev = k.rows('staff_events.jsonl').find((e) => e.event === 'pin_locked');
  assert.strictEqual(ev.where, 'tablet');
});

test('the staff page is served for /staff and a scanned order link', async (t) => {
  const { k } = await kiosk(t);
  for (const p of ['/staff', '/staff/order/A-12']) {
    const res = await fetch(k.url + p);
    assert.strictEqual(res.status, 200, p);
    assert.match(await res.text(), /<html/i);
  }
});

test('from the shop Wi-Fi only the staff page answers', async (t) => {
  const ip = lanAddress();
  if (!ip) return t.skip('no LAN address on this machine');
  const { k } = await kiosk(t, { config: ['STAFF_TABLET = 1'], host: '0.0.0.0' });
  const lan = `http://${ip}:${k.port}`;
  const post = (p) => fetch(lan + p, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sale),
  });

  for (const p of ['/', '/index.html', '/api/state', '/api/stream', '/js/kiosk.js']) {
    assert.strictEqual((await fetch(lan + p)).status, 403, p);
  }
  for (const p of ['/api/order', '/api/order/pin', '/api/order/cancel', '/api/dispense', '/api/pause', '/api/resume']) {
    assert.strictEqual((await post(p)).status, 403, p);
  }
  assert.strictEqual((await fetch(lan + '/staff')).status, 200);
  assert.strictEqual((await fetch(lan + '/img/products/1.webp')).status, 200);
  // KIOSK_PORT is unset in tests, so the QR base uses the default 3000.
  const s = await k.get('/api/state');
  assert.strictEqual(s.body.staffBase, `http://${ip}:3000`);
});
```

- [ ] **Step 2: Run to see them fail**

Run: `cd kiosk_server && node --test tests/staff_server.test.js`
Expected: FAIL — `/staff/api/login` answers 405.

- [ ] **Step 3: Add the requires to `server.js`**

After `const { createOrderBook } = require('./lib/orders');` add:

```js
const { createSessions, tokenFrom, cookieFor, clearCookie, SESSION_MS } = require('./lib/sessions');
const { isLocal, lanAllowed, lanAddress } = require('./lib/access');
```

- [ ] **Step 4: Add the tablet pad, sessions and address**

Directly after the `kioskPad` block (the `});` that follows `staffEvent('pin_locked', { where: 'kiosk' });`) add:

```js
  // The tablet has its own pad, so a stranger hammering the tablet cannot
  // lock staff out of the kiosk's PIN fallback, or the other way round.
  const tabletPad = createPinPad(staff, {
    onLock: () => {
      log('[kiosk] tablet PIN pad locked after repeated wrong PINs');
      staffEvent('pin_locked', { where: 'tablet' });
    },
  });
  const sessions = createSessions();
  const port = parseInt(config.KIOSK_PORT || '3000', 10);
  // What the QR on the kiosk points at. Null when the tablet is off or the
  // Pi has no network, and the kiosk then shows no QR.
  const lanIp = staffTablet ? lanAddress() : null;
  const staffBase = lanIp ? `http://${lanIp}:${port}` : null;
```

- [ ] **Step 5: Add the staff handlers**

Directly before `function serveStatic(req, res) {` add:

```js
  // ---- staff tablet ---------------------------------------------------------
  const isJson = (req) => /^application\/json/i.test(req.headers['content-type'] || '');
  const staffName = (req) => { const s = sessions.get(tokenFrom(req)); return s ? s.name : null; };

  // Today's cash, from the payments log so it survives a restart.
  function todaySummary() {
    const day = stamp().slice(0, 10);
    let paid = 0;
    let total = 0;
    let text = '';
    try { text = fs.readFileSync(paymentsLog, 'utf-8'); } catch (_) { /* none yet */ }
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        const p = JSON.parse(line);
        if (String(p.date_created).startsWith(day)) { paid++; total += p.amount || 0; }
      } catch (_) { /* a torn line is skipped, not fatal */ }
    }
    return { paid, total, orders: orders.closed().slice(0, 20).map(publicOrder) };
  }

  function staffState() {
    return {
      online: ctrl.online,
      machine: !ctrl.online ? 'offline' : machineInUse() ? 'dispensing' : 'ready',
      pending: publicOrder(orders.current()),
      today: todaySummary(),
    };
  }

  async function staffLogin(req, res) {
    if (!isJson(req)) return json(res, 415, { error: 'json_only' });
    const body = await readBody(req);
    const who = tabletPad.check(body && body.pin);
    if (!who.ok) return json(res, ...pinRefusal(who));
    const token = sessions.create(who.name);
    staffEvent('sign_in', { staff: who.name });
    res.setHeader('Set-Cookie', cookieFor(token, SESSION_MS));
    json(res, 200, { name: who.name });
  }

  function staffLogout(req, res) {
    const token = tokenFrom(req);
    const s = sessions.get(token);
    if (s) staffEvent('sign_out', { staff: s.name });
    sessions.destroy(token);
    res.setHeader('Set-Cookie', clearCookie());
    json(res, 200, { ok: true });
  }

  async function staffOrderAction(req, res, name, action) {
    if (!isJson(req)) return json(res, 415, { error: 'json_only' });
    const body = await readBody(req);
    const number = body && body.number;
    const o = orders.current();
    if (!o || o.number !== number) {
      return json(res, 409, { error: 'not_waiting', order: publicOrder(orders.find(number)) });
    }
    if (action === 'cancel') {
      orders.cancel(o, 'staff', name);
      return json(res, 200, { ok: true, order: publicOrder(o) });
    }
    json(res, ...confirmPaid(o, name, 'tablet'));
  }

  function servePage(res, file) {
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
      res.end(data);
    });
  }

  function staffRoutes(req, res, url) {
    if (req.method === 'GET' && (url === '/staff' || url === '/staff/' || /^\/staff\/order\/[A-Z]-\d+$/.test(url))) {
      return servePage(res, path.join(publicDir, 'staff', 'index.html'));
    }
    if (req.method === 'POST' && url === '/staff/api/login') return staffLogin(req, res);
    if (req.method === 'POST' && url === '/staff/api/logout') return staffLogout(req, res);
    if (url.startsWith('/staff/api/')) {
      const name = staffName(req);
      if (!name) return json(res, 401, { error: 'signed_out' });
      if (req.method === 'GET' && url === '/staff/api/me') return json(res, 200, { name });
      if (req.method === 'GET' && url === '/staff/api/state') return json(res, 200, staffState());
      if (req.method === 'GET' && url === '/staff/api/order') {
        const number = new URL(req.url, 'http://kiosk').searchParams.get('number');
        const o = orders.find(number);
        return o ? json(res, 200, { order: publicOrder(o) }) : json(res, 404, { error: 'unknown_order' });
      }
      if (req.method === 'POST' && url === '/staff/api/orders/paid') return staffOrderAction(req, res, name, 'paid');
      if (req.method === 'POST' && url === '/staff/api/orders/cancel') return staffOrderAction(req, res, name, 'cancel');
      return json(res, 404, { error: 'unknown' });
    }
    if (req.method === 'GET') return serveStatic(req, res);   // /staff/staff.css, /staff/staff.js
    res.writeHead(405); res.end();
  }

```

- [ ] **Step 6: Guard the router and route `/staff`**

In `http.createServer((req, res) => {`, replace:

```js
    const url = req.url.split('?')[0];
    if (req.method === 'GET' && url === '/api/state') {
      return json(res, 200, { products, idleSeconds, cashReady: staff.length > 0, staffTablet, ...snapshot() });
    }
```

with:

```js
    const url = req.url.split('?')[0];
    // From the shop Wi-Fi, the staff page and its pictures only. Everything
    // that orders, unlocks or pours answers the Pi itself and nobody else.
    if (!isLocal(req) && !lanAllowed(url)) { res.writeHead(403); return res.end('Forbidden'); }
    if (url === '/staff' || url.startsWith('/staff/')) return staffRoutes(req, res, url);
    if (req.method === 'GET' && url === '/api/state') {
      return json(res, 200, {
        products, idleSeconds, cashReady: staff.length > 0, staffTablet, staffBase, ...snapshot(),
      });
    }
```

- [ ] **Step 7: Return the bind host and use it**

In the returned object replace `port: parseInt(config.KIOSK_PORT || '3000', 10),` with:

```js
    port,
    // The shop Wi-Fi only when the tablet is switched on.
    host: staffTablet ? '0.0.0.0' : '127.0.0.1',
```

and replace the `require.main` block at the bottom of the file with:

```js
if (require.main === module) {
  const k = createKioskServer();
  k.server.listen(k.port, k.host, () =>
    console.log(`[kiosk] listening on http://localhost:${k.port}/`
      + (k.host === '0.0.0.0' ? '  (staff tablet: /staff on the shop Wi-Fi)' : '')));
}
```

- [ ] **Step 8: Create a placeholder staff page**

Create `kiosk_server/public/staff/index.html` with exactly:

```html
<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Sabon Express · Staff</title></head>
<body><p>Staff page — built in Task 6.</p></body></html>
```

- [ ] **Step 9: Run the whole suite**

Run: `cd kiosk_server && npm test`
Expected: PASS. On a machine without a LAN address the Wi-Fi test is reported as skipped, not failed.

- [ ] **Step 10: Commit**

```bash
git add kiosk_server/server.js kiosk_server/tests/staff_server.test.js kiosk_server/public/staff/index.html
git commit -m "feat(kiosk): staff tablet routes behind sign-in, and the Wi-Fi guard

/staff/api/* signs staff in once per shift (own PIN pad and lockout),
shows the waiting order and today's cash, and marks paid or cancels
through confirmPaid. With STAFF_TABLET=1 the server binds the shop Wi-Fi,
where only /staff, /img and /fonts answer; every customer route is 403
from anything but the Pi itself."
```

---

### Task 5: Kiosk — the "Pay at the counter" screen

**Files:**
- Create: `kiosk_server/public/js/qrcode.js` (vendored)
- Modify: `kiosk_server/public/index.html` (full replacement below)
- Modify: `kiosk_server/public/css/kiosk.css` (append block below)
- Modify: `kiosk_server/public/js/kiosk.js` (full replacement below)

**Interfaces:**
- Consumes: Task 3/4 HTTP (`/api/order`, `/api/order/pin`, `/api/order/cancel`; `/api/state` fields `staffTablet`, `staffBase`, `pending`, `lastClosed`; `publicOrder.totalMs`, `publicOrder.remainingMs`).
- Consumes: global `qrcode(typeNumber, errorCorrection)` from `qrcode-generator` → `.addData(s)`, `.make()`, `.createSvgTag({ cellSize, margin, scalable })`.

- [ ] **Step 1: Vendor the QR encoder**

```bash
curl -fsSL -o kiosk_server/public/js/qrcode.js https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js
head -12 kiosk_server/public/js/qrcode.js
node -e "const q=require('./kiosk_server/public/js/qrcode.js'); const c=q(0,'M'); c.addData('http://192.168.1.50:3000/staff/order/A-27'); c.make(); console.log(c.createSvgTag({cellSize:4,margin:0,scalable:true}).slice(0,60))"
```

Expected: the header names Kazuhiko Arase and the MIT licence; the last command prints the start of an `<svg` tag. Keep the file unmodified.

- [ ] **Step 2: Replace `kiosk_server/public/index.html`**

Identical to the current file except: the pay view gets a message line and its Cash description changes, the PIN view's Back button gets `id="pin-back"` instead of `data-go`, a new `v-order` view is added before `v-pin`, and `qrcode.js` is loaded. Full file:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
  <title>Sabon Express</title>
  <link rel="stylesheet" href="css/kiosk.css">
</head>
<body>
<!-- One 1920x1080 landscape stage, scaled to fit the window. On the kiosk's
     screen the scale is exactly 1; on a laptop it shrinks, so the same page can
     be tested anywhere. The look is the cashier's V2 dashboard -- header card,
     product tiles, cart panel, Unlock -- sized for a customer's finger. -->
<div id="stage">

  <!-- ================== HEADER (every screen but attract) ================== -->
  <header id="v2-header">
    <div class="v2-card" id="v2-stats">
      <span class="v2-chip" id="chip-state">
        <span class="v2-dot"></span>
        <span class="v2-chip-v" id="kpi-state">Ready</span>
      </span>
      <span class="v2-chip">
        <span class="v2-chip-k">In stock</span>
        <span class="v2-chip-sep"></span>
        <span class="v2-chip-v" id="kpi-stock">6/6</span>
      </span>
      <span class="v2-chip">
        <span class="v2-chip-k">Pay with</span>
        <span class="v2-chip-sep"></span>
        <span class="v2-chip-v">Cash</span>
      </span>
      <span class="v2-chip v2-chip-brand">
        <span class="v2-chip-k">Bring your own bottle</span>
      </span>
    </div>
    <div class="v2-card" id="v2-identity">
      <img class="v2-logo" src="img/sabon-express-logo.png" alt="Sabon Express">
      <span class="v2-vsep"></span>
      <span class="v2-clock" id="v2-clock">--:--</span>
    </div>
  </header>

  <main id="v2-main">

    <!-- ================== SHOP: products + cart ================== -->
    <section class="view" id="v-shop">
      <div class="v2-card" id="v2-products">
        <div class="v2-panel-head">
          <h1 class="v2-panel-title">Choose your products</h1>
          <span class="v2-panel-hint">Tap a product or <b>+</b> to add. One press = one measure.</span>
        </div>
        <div id="v2-grid" class="v2-grid"></div>
      </div>

      <aside class="v2-card" id="v2-cart">
        <div class="v2-cart-head">
          <span class="v2-cart-title">
            <svg class="v2-cart-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="20" r="1.6"/><circle cx="18" cy="20" r="1.6"/><path d="M2 3h2.2l2.4 12.1a1.6 1.6 0 0 0 1.6 1.3h8.9a1.6 1.6 0 0 0 1.6-1.3L21 7H5.2"/></svg>
            Your Cart
          </span>
          <button id="btn-clear" class="v2-btn v2-btn-danger-ghost v2-btn-icon-sm" type="button" aria-label="Clear the cart" hidden>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/><path d="M10 11v6M14 11v6"/></svg>
          </button>
        </div>
        <div id="v2-cart-body">
          <ul id="v2-cart-list" class="v2-cart-list"></ul>
          <div id="v2-cart-empty" class="v2-cart-empty">
            <svg class="v2-empty-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="20" r="1.6"/><circle cx="18" cy="20" r="1.6"/><path d="M2 3h2.2l2.4 12.1a1.6 1.6 0 0 0 1.6 1.3h8.9a1.6 1.6 0 0 0 1.6-1.3L21 7H5.2"/></svg>
            <p class="v2-empty-title">Your cart is empty</p>
            <p class="v2-empty-sub">Tap a product to add it</p>
          </div>
        </div>
        <div class="v2-totals">
          <div class="v2-total-row"><span>Quantity</span><span class="v2-total-v" id="total-items">0</span></div>
          <div class="v2-total-rule"></div>
          <div class="v2-total-row"><span>Total Amount</span><span class="v2-total-v v2-total-money" id="total-amount">₱0</span></div>
        </div>
        <button id="btn-unlock" class="v2-btn v2-btn-primary v2-btn-xl" type="button" disabled>
          <svg class="v2-btn-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="10.5" width="16" height="10" rx="2.2"/><path d="M8 10.5V7.6a4 4 0 0 1 8 0v2.9"/></svg>
          Unlock
        </button>
      </aside>
    </section>

    <!-- ================== PAY: choose how ================== -->
    <section class="view v2-card kiosk-panel" id="v-pay" hidden>
      <div class="k-head">
        <button class="v2-btn v2-btn-ghost k-back" data-go="shop" type="button">‹ Back</button>
        <div class="k-title">
          <h1>How would you like to pay?</h1>
          <p>Amount to pay: <b class="k-amount" id="pay-amount">₱0</b> · exact amount only, no change</p>
        </div>
      </div>
      <div class="pay-options">
        <button class="pay-tile" id="pay-cash" type="button">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.6"/><path d="M6 9.5v5M18 9.5v5"/></svg>
          <span class="pay-name">Cash</span>
          <span class="pay-desc" id="pay-cash-desc">Pay at the counter</span>
        </button>
        <button class="pay-tile" id="pay-qr" type="button" disabled>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM20 14v.01M14 20h.01M17 20h4v-3"/></svg>
          <span class="pay-name">QR Ph</span>
          <span class="pay-desc">GCash, Maya, ShopeePay and bank apps</span>
          <span class="pay-soon">Coming soon</span>
        </button>
      </div>
      <p class="pay-msg" id="pay-msg" role="alert"></p>
    </section>

    <!-- ================== ORDER: pay at the counter ================== -->
    <section class="view v2-card kiosk-panel" id="v-order" hidden>
      <div class="k-head">
        <div class="k-title">
          <h1 id="o-title">Pay at the counter</h1>
          <p id="o-lead">Go to the counter and pay exactly <b class="k-amount" id="o-amount">₱0</b>. Staff will unlock the machine for you.</p>
        </div>
      </div>
      <div class="o-layout" id="o-live">
        <div class="o-order">
          <ul class="v2-cart-list o-items" id="o-items"></ul>
          <div class="v2-totals">
            <div class="v2-total-row"><span>Total to pay</span><span class="v2-total-v v2-total-money" id="o-total">₱0</span></div>
          </div>
        </div>
        <div class="o-side">
          <div class="o-qr" id="o-qr"></div>
          <p class="o-hint" id="o-hint">Or show staff a photo of this code.</p>
          <div class="o-number">Order <b id="o-number">—</b></div>
        </div>
      </div>
      <div class="o-wait" id="o-wait">
        <div class="o-wait-text" id="o-wait-text">Waiting for payment</div>
        <div class="o-bar"><i id="o-bar"></i></div>
      </div>
      <div class="o-ended" id="o-ended" hidden>
        <h2 id="o-ended-title"></h2>
        <p id="o-ended-text"></p>
      </div>
      <div class="o-foot" id="o-foot">
        <button class="v2-btn v2-btn-ghost o-cancel" id="o-cancel" type="button">Cancel order</button>
        <button class="o-staff" id="o-staff" type="button">Staff at the machine? Enter PIN ›</button>
      </div>
    </section>

    <!-- ================== PIN: staff confirms the cash ================== -->
    <section class="view v2-card kiosk-panel" id="v-pin" hidden>
      <div class="k-head">
        <button class="v2-btn v2-btn-ghost k-back" id="pin-back" type="button">‹ Back</button>
        <div class="k-title">
          <h1>Pay with cash</h1>
          <p>Hand exactly <b class="k-amount" id="pin-amount">₱0</b> to a staff member · no change is given</p>
        </div>
      </div>
      <div class="pin-layout">
        <div class="pin-order">
          <ul class="v2-cart-list" id="pin-summary"></ul>
          <div class="v2-totals">
            <div class="v2-total-row"><span>Quantity</span><span class="v2-total-v" id="pin-items">0</span></div>
            <div class="v2-total-rule"></div>
            <div class="v2-total-row"><span>Total Amount</span><span class="v2-total-v v2-total-money" id="pin-total">₱0</span></div>
          </div>
        </div>
        <div class="pin-pad">
          <div class="pin-head"><span class="pin-badge">Staff only</span> Enter your PIN to confirm the cash was received</div>
          <div class="pin-dots" id="pin-dots"></div>
          <div class="pin-msg" id="pin-msg" role="alert"></div>
          <div class="keypad" id="keypad">
            <button data-k="1">1</button><button data-k="2">2</button><button data-k="3">3</button>
            <button data-k="4">4</button><button data-k="5">5</button><button data-k="6">6</button>
            <button data-k="7">7</button><button data-k="8">8</button><button data-k="9">9</button>
            <button data-k="clear" class="k-alt">Clear</button><button data-k="0">0</button><button data-k="back" class="k-alt">⌫</button>
          </div>
          <button class="v2-btn v2-btn-primary v2-btn-xl" id="confirm-cash" type="button" disabled>
            <svg class="v2-btn-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="10.5" width="16" height="10" rx="2.2"/><path d="M8 10.5V7.6a4 4 0 0 1 8 0v2.9"/></svg>
            <span id="confirm-label">Confirm &amp; Unlock</span>
          </button>
        </div>
      </div>
    </section>

    <!-- ================== DISPENSE: the purchased items ================== -->
    <!-- A major kiosk screen, not a pop-up: one card per purchased product,
         side by side. Each tap on a card's button pours ONE unit. -->
    <section class="view v2-card kiosk-panel" id="v-dispense" hidden>
      <div class="k-head k-head-center">
        <div class="k-title">
          <h1>Your purchased items</h1>
          <p id="d-sub">Place your bottle under the nozzle shown, then tap Dispense.</p>
        </div>
      </div>
      <div class="d-row" id="d-row"></div>
      <p class="d-msg" id="d-msg" role="alert"></p>
      <div class="d-foot">
        <span class="d-left" id="d-left"></span>
        <button class="v2-btn v2-btn-primary d-done" id="d-done" type="button" hidden>Done / Finish</button>
      </div>
    </section>

    <!-- ================== THANK YOU ================== -->
    <section class="view v2-card kiosk-panel" id="v-thanks" data-go="attract" hidden>
      <div class="thanks">
        <div class="thanks-mark">✓</div>
        <h1>Thank you!</h1>
        <p>Please take your bottle. See you again soon.</p>
      </div>
    </section>
  </main>

  <!-- ================== ATTRACT (full screen) ================== -->
  <section id="attract" data-go="shop">
    <div class="a-hero">
      <h1>Fill your own bottle</h1>
      <p>Detergent, fabric conditioner and bleach — pay only for what you pour.</p>
      <div class="a-cta">Tap anywhere to start</div>
    </div>
    <div class="v2-card a-shelf" id="a-shelf"></div>
  </section>

  <!-- ================== OFFLINE (over everything) ================== -->
  <div class="offline" id="offline" hidden>
    <div class="v2-card offline-card">
      <div class="offline-dot"></div>
      <h2>Machine not ready</h2>
      <p id="offline-text">Please wait a moment. If this stays, call a staff member.</p>
    </div>
  </div>

</div>
<script src="js/qrcode.js"></script>
<script src="js/kiosk.js"></script>
</body>
</html>
```

- [ ] **Step 3: Append the order-screen styles to `kiosk_server/public/css/kiosk.css`**

Add at the end of the file:

```css
/* ---- pay message ---------------------------------------------------------- */
.pay-msg { min-height: 34px; margin: 18px 0 0; text-align: center; font-size: 24px; font-weight: 700; color: var(--red); }

/* ---- order: pay at the counter --------------------------------------------- */
.o-layout { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr) 420px; gap: 40px; }
.o-order { display: flex; flex-direction: column; justify-content: space-between; gap: 20px; min-height: 0; }
.o-items { overflow-y: auto; }
.o-items .v2-cart-row { padding: 16px 20px; }
.o-items .v2-cart-row img { width: 72px; height: 72px; }
.o-items .v2-cart-name b { font-size: 28px; }
.o-items .v2-cart-qty { font-size: 28px; color: var(--ink); font-weight: 700; }
.o-items .v2-cart-price { font-size: 26px; }
.o-side {
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px;
  padding: 24px; border-radius: var(--r-card); background: var(--surface-sub); border: 1px solid var(--line);
}
/* The QR sits on white: phone cameras read dark-on-light far more reliably. */
.o-qr { width: 300px; height: 300px; padding: 16px; background: #fff; border-radius: 16px; }
.o-qr svg { width: 100%; height: 100%; display: block; }
.o-hint { margin: 0; font-size: 20px; color: var(--ink-2); text-align: center; }
.o-number { font-size: 22px; color: var(--ink-2); }
.o-number b { color: var(--ink); font-size: 26px; font-variant-numeric: tabular-nums; }
.o-wait { margin-top: 22px; }
.o-wait-text { font-size: 26px; font-weight: 700; margin-bottom: 10px; font-variant-numeric: tabular-nums; }
.o-bar { height: 14px; border-radius: var(--r-pill); background: var(--surface-sub); overflow: hidden; }
.o-bar i { display: block; height: 100%; width: 100%; background: var(--brand); transition: width 1s linear; }
.o-bar.is-low i { background: var(--amber); }
.o-ended { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; }
.o-ended h2 { margin: 0; font-size: 56px; }
.o-ended p { margin: 16px 0 0; font-size: 28px; color: var(--ink-2); }
.o-foot { display: flex; justify-content: space-between; align-items: center; margin-top: 20px; }
.o-cancel { min-width: 260px; }
.o-cancel.is-confirm { border-color: var(--red); color: var(--red); }
.o-staff { min-height: 72px; padding: 0 12px; font-size: 22px; color: var(--ink-2); }
```

- [ ] **Step 4: Replace `kiosk_server/public/js/kiosk.js`**

```js
'use strict';
// Sabon Express kiosk: attract -> shop -> pay -> order/pin -> dispense -> thanks.
// Landscape 1920x1080, in the cashier V2 dashboard's visual language.
//
// Cash is an order. With the staff tablet on, the customer sees "Pay at the
// counter" with a QR, pays at the counter, and staff mark it paid from their
// tablet; with it off, the kiosk goes straight to the staff PIN pad. Either
// way the server decides, and the kiosk follows its stream.
//
// The dispense screen is driven by the controller, not by this page. Whenever
// STATUS shows paid presses on the machine, this page shows them -- so a
// reload, a crash or a second tab can never hide credit a customer paid for,
// and there is no "tap to continue" for a stranger on the attract screen.

(() => {
  const W = 1920;
  const H = 1080;
  const OFFLINE_MS = 6000;        // silence that means the machine is gone
  const THANKS_MS = 10000;
  const ENDED_MS = 5000;          // "Order expired" / "cancelled" stays this long
  const PAUSED_AFTER_MS = 900;    // remaining time frozen this long = paused
  const DONE_AUTO_MS = 20000;     // all dispensed, Done not tapped: finish anyway
  const MAX_QTY = 20;

  const $ = (id) => document.getElementById(id);
  const peso = (n) => '₱' + n;
  const MINUS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M5 12h14"/></svg>';
  const PLUS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>';

  let products = [];
  let prices = {};
  let status = null;
  let online = false;
  let cashReady = false;
  let staffTablet = false;
  let staffBase = null;
  let idleSeconds = 60;
  let lastMsgAt = 0;
  let streamOpenedAt = 0;
  let es = null;

  let screen = '';
  let cart = {};                  // slot -> qty
  let cartKey = '';
  let pin = '';
  let lastTouch = Date.now();
  let thanksAt = 0;
  let order = null;               // the paid order being dispensed, from the server

  let pending = null;             // the order waiting for payment, from the server
  let pendingSeenAt = 0;
  let lastClosed = null;
  let myOrder = null;             // number of the order this screen is showing
  let endedAt = 0;                // when "expired"/"cancelled" went up
  let qrFor = '';
  let cancelArmedUntil = 0;

  let sending = false;            // one request at a time from this page
  let sendingSlot = 0;
  let dispenseEnteredAt = 0;
  let sawCredit = false;
  let doneSince = 0;
  let cardsKey = '';
  let pourMsg = '';
  const pour = {};                // slot -> { max, last, changedAt, pausedLocal }

  // ---- stage scaling ---------------------------------------------------------
  const stage = $('stage');
  function fit() {
    const s = Math.min(innerWidth / W, innerHeight / H);
    stage.style.left = `${(innerWidth - W * s) / 2}px`;
    stage.style.top = `${(innerHeight - H * s) / 2}px`;
    stage.style.transform = `scale(${s})`;
  }
  addEventListener('resize', fit);
  fit();

  // ---- helpers ---------------------------------------------------------------
  async function post(url, body) {
    try {
      const res = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { code: res.status, body: await res.json() };
    } catch (_) {
      return { code: 0, body: { error: 'offline', result: 'offline' } };
    }
  }
  const slotState = (slot) => (status ? status.slots[slot - 1] : null);
  const isOut = (slot) => { const s = slotState(slot); return !!(s && s.empty); };
  const hasCredit = (s) => s.armed > 0 || s.busy || s.queued > 0;
  const creditOnMachine = () => !!status && status.slots.some(hasCredit);
  const cartItems = () => Object.entries(cart).map(([slot, qty]) => ({ slot: +slot, qty }));
  const cartCount = () => cartItems().reduce((a, it) => a + it.qty, 0);
  const cartTotal = () => cartItems().reduce((a, it) => a + (prices[it.slot] || 0) * it.qty, 0);
  const pricesKnown = () => cartItems().every((it) => Number.isInteger(prices[it.slot]));
  const machineReady = () => online && Date.now() - lastMsgAt < OFFLINE_MS;
  const myPending = () => (pending && pending.number === myOrder ? pending : null);

  // Items from the cart carry no price (the page's prices are used); items
  // from an order carry the price frozen when it was made.
  function cartRows(items) {
    return items.map((it) => {
      const p = products[it.slot - 1];
      const price = it.price !== undefined ? it.price : (prices[it.slot] || 0);
      return `<li class="v2-cart-row">
        <img src="${p.img}" alt="">
        <span class="v2-cart-name"><b>${p.name}</b><span>${p.ml ? `${p.ml} ml per press · ` : ''}${peso(price)} each</span></span>
        <span class="v2-cart-qty">× ${it.qty}</span>
        <span class="v2-cart-price">${peso(price * it.qty)}</span>
      </li>`;
    }).join('');
  }

  // ---- screens -----------------------------------------------------------------
  const VIEWS = ['shop', 'pay', 'order', 'pin', 'dispense', 'thanks'];
  function show(name) {
    if (name === screen) return;
    screen = name;
    $('attract').hidden = name !== 'attract';
    for (const v of VIEWS) $(`v-${v}`).hidden = v !== name;
    if (name === 'attract') { cart = {}; pin = ''; myOrder = null; endedAt = 0; }
    if (name === 'pay') $('pay-msg').textContent = '';
    if (name === 'pin') { pin = ''; setPinMsg(''); }
    if (name === 'dispense') {
      dispenseEnteredAt = Date.now(); sawCredit = false; doneSince = 0; pourMsg = ''; cardsKey = '';
      myOrder = null;
    }
    if (name === 'thanks') thanksAt = Date.now();
    lastTouch = Date.now();
    render();
  }

  function route() {
    const now = Date.now();
    if (creditOnMachine()) {
      if (screen !== 'dispense') show('dispense');
      sawCredit = true;
      doneSince = 0;
      return;
    }
    // A waiting order the page does not know about (a reload, a crash):
    // put it back on screen rather than strand it.
    if (pending && !myOrder && ['attract', 'shop', 'pay'].includes(screen)) {
      myOrder = pending.number;
      show(staffTablet ? 'order' : 'pin');
      return;
    }
    // Our order stopped waiting. Paid shows up as credit (above); anything
    // else gets a short explanation, then the start screen.
    if (myOrder && !endedAt && !myPending() && (screen === 'order' || screen === 'pin')) {
      const closed = lastClosed && lastClosed.number === myOrder ? lastClosed : null;
      if (!closed || closed.status !== 'paid') { endedAt = now; show('order'); render(); }
    }
    if (endedAt && now - endedAt > ENDED_MS) { endedAt = 0; show('attract'); return; }
    if (screen !== 'dispense') return;
    if (sawCredit) {
      // Everything poured: Done / Finish is live. If nobody taps it, finish
      // anyway so the next customer is not left looking at this order.
      doneSince = doneSince || now;
      if (now - doneSince > DONE_AUTO_MS) show('thanks');
    } else if (now - dispenseEnteredAt > 8000) {
      pourMsg = 'Your products could not be unlocked. Please call a staff member.';
    }
  }

  function render() {
    $('offline').hidden = machineReady() || (!lastMsgAt && Date.now() - streamOpenedAt < 2000);
    $('offline-text').textContent = screen === 'dispense'
      ? 'Your paid items are safe. Please wait — dispensing continues when the machine is back.'
      : 'Please wait a moment. If this stays, call a staff member.';
    renderHeader();
    if (screen === 'attract') renderShelf();
    if (screen === 'shop') renderShop();
    if (screen === 'pay') renderPay();
    if (screen === 'order') renderOrder();
    if (screen === 'pin') renderPin();
    if (screen === 'dispense') renderDispense();
  }

  // ---- header (V2 stats + identity) ------------------------------------------
  function renderHeader() {
    const chip = $('chip-state');
    const ready = machineReady();
    const busy = ready && creditOnMachine();
    chip.classList.toggle('is-offline', !ready);
    chip.classList.toggle('is-busy', busy);
    $('kpi-state').textContent = !ready ? 'Offline' : busy ? 'Dispensing' : 'Ready';
    const inStock = products.filter((p) => !isOut(p.slot)).length;
    const k = $('kpi-stock');
    k.textContent = `${inStock}/${products.length}`;
    k.className = 'v2-chip-v ' + (inStock === products.length ? 'is-full' : inStock >= 3 ? 'is-low' : 'is-critical');
    const d = new Date();
    $('v2-clock').textContent = `${d.getHours() % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')} ${d.getHours() < 12 ? 'AM' : 'PM'}`;
  }

  // ---- attract -------------------------------------------------------------------
  function renderShelf() {
    // Every product lit, stock or not: this screen sells the range. Stock is
    // shown on the shop screen, where it decides what can be bought.
    $('a-shelf').innerHTML = products.map((p) => `
      <div class="a-item">
        <div class="a-img"><img src="${p.img}" alt=""></div>
        <div class="n">${p.name}</div>
        <div class="p">${Number.isInteger(prices[p.slot]) ? `${peso(prices[p.slot])} per press` : '&nbsp;'}</div>
      </div>`).join('');
  }

  // ---- shop: V2 product tiles + cart --------------------------------------------
  // Built once and updated in place: STATUS arrives twice a second, and
  // rebuilding the buttons under a finger swallows the tap.
  function buildGrid() {
    $('v2-grid').innerHTML = products.map((p) => `
      <div class="v2-prod" id="card-${p.slot}" data-slot="${p.slot}">
        <div class="v2-prod-img"><img src="${p.img}" alt=""></div>
        <span class="v2-badge"><span class="v2-dot"></span><span class="b-txt">Ready</span></span>
        <div class="v2-prod-text">
          <div class="v2-prod-name">${p.name}</div>
          <div class="v2-prod-ml">${p.ml ? `${p.ml} ml per press` : '&nbsp;'}</div>
          <div class="v2-prod-price"></div>
        </div>
        <div class="v2-step-row">
          <button class="v2-step v2-step-minus" data-slot="${p.slot}" data-d="-1" aria-label="Less">${MINUS}</button>
          <span class="v2-step-qty">0</span>
          <button class="v2-step v2-step-plus" data-slot="${p.slot}" data-d="1" aria-label="More">${PLUS}</button>
        </div>
      </div>`).join('');
  }

  function renderShop() {
    for (const p of products) {
      const card = $(`card-${p.slot}`);
      const out = isOut(p.slot);
      const price = prices[p.slot];
      if (out) delete cart[p.slot];
      const qty = cart[p.slot] || 0;
      card.classList.toggle('is-empty', out);
      card.classList.toggle('in-cart', qty > 0);
      const badge = card.querySelector('.v2-badge');
      badge.className = 'v2-badge' + (out ? ' is-empty' : qty ? ' is-armed' : '');
      badge.querySelector('.b-txt').textContent = out ? 'Out of stock' : qty ? 'In cart' : 'Ready';
      card.querySelector('.v2-prod-price').innerHTML =
        Number.isInteger(price) ? `${peso(price)} <small>per press</small>` : '&nbsp;';
      card.querySelector('.v2-step-qty').textContent = qty;
      card.querySelector('.v2-step-minus').disabled = qty === 0;
      card.querySelector('.v2-step-plus').disabled = out || !Number.isInteger(price) || qty >= MAX_QTY;
    }
    const items = cartItems();
    const key = items.map((i) => `${i.slot}:${i.qty}`).join(',') + '|' + JSON.stringify(prices);
    if (key !== cartKey) {
      cartKey = key;
      $('v2-cart-list').innerHTML = cartRows(items);
    }
    $('v2-cart-empty').hidden = items.length > 0;
    $('btn-clear').hidden = items.length === 0;
    $('total-items').textContent = cartCount();
    $('total-amount').textContent = peso(cartTotal());
    $('btn-unlock').disabled = items.length === 0 || !pricesKnown() || !machineReady();
  }

  function changeQty(slot, d) {
    const price = prices[slot];
    if (d > 0 && (isOut(slot) || !Number.isInteger(price))) return;
    const qty = Math.max(0, Math.min(MAX_QTY, (cart[slot] || 0) + d));
    if (qty) cart[slot] = qty; else delete cart[slot];
    renderShop();
  }

  $('v2-grid').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-d]');
    if (b) { if (!b.disabled) changeQty(+b.dataset.slot, +b.dataset.d); return; }
    // The whole tile is a target too: a customer taps the bottle they want.
    const card = e.target.closest('.v2-prod');
    if (card) changeQty(+card.dataset.slot, 1);
  });
  $('btn-clear').addEventListener('click', () => { cart = {}; renderShop(); });
  $('btn-unlock').addEventListener('click', () => show('pay'));

  // ---- pay: choose cash or QR ------------------------------------------------------
  function renderPay() {
    $('pay-amount').textContent = peso(cartTotal());
    $('pay-cash').disabled = !cashReady || !machineReady() || sending;
    $('pay-cash-desc').textContent = !cashReady
      ? 'Not set up on this kiosk — please call staff'
      : staffTablet ? 'Pay at the counter' : 'Hand the exact amount to a staff member';
  }

  const PAY_MSG = {
    price_changed: 'Prices were just updated. Please check the new total.',
    machine_busy: 'The machine is still finishing an order. Please wait.',
    order_waiting: 'Another order is waiting for payment. Please wait a moment.',
    offline: 'The machine is not ready. Please try again in a moment.',
    no_prices: 'Prices are still loading. Please wait a moment.',
  };

  $('pay-cash').addEventListener('click', async () => {
    if (sending) return;
    sending = true;
    renderPay();
    const r = await post('/api/order', { items: cartItems(), amount: cartTotal() });
    sending = false;
    if (r.code === 200) {
      pending = r.body.order;
      pendingSeenAt = Date.now();
      myOrder = pending.number;
      endedAt = 0;
      show(staffTablet ? 'order' : 'pin');
      return;
    }
    const e = r.body.error;
    if (e === 'empty') {
      const p = products[(r.body.slot || 1) - 1];
      $('pay-msg').textContent = `Sorry, ${p.name} just ran out. Please change the order.`;
      setTimeout(() => { if (screen === 'pay') show('shop'); }, 2500);
    } else {
      $('pay-msg').textContent = PAY_MSG[e] || PAY_MSG.offline;
    }
    renderPay();
  });

  // ---- order: pay at the counter ------------------------------------------------
  const ENDED = {
    expired: ['Order expired', 'Nothing was charged. You can order again.'],
    customer: ['Order cancelled', 'Nothing was charged.'],
    staff: ['Order cancelled by staff', 'Nothing was charged. Please ask at the counter.'],
    out_of_stock: ['A product ran out', 'Nothing was charged. Please order again.'],
    price_changed: ['Prices changed', 'Nothing was charged. Please order again at the new price.'],
    gone: ['Order no longer available', 'Nothing was charged. Please order again.'],
  };

  function renderOrder() {
    const ended = !!endedAt;
    $('o-live').hidden = ended;
    $('o-wait').hidden = ended;
    $('o-foot').hidden = ended;
    $('o-lead').hidden = ended;
    $('o-ended').hidden = !ended;
    $('o-title').textContent = ended ? `Order ${myOrder || ''}` : 'Pay at the counter';
    if (ended) {
      const c = lastClosed && lastClosed.number === myOrder ? lastClosed : null;
      const key = !c ? 'gone' : c.status === 'expired' ? 'expired' : (c.reason || 'gone');
      const [title, text] = ENDED[key] || ENDED.gone;
      $('o-ended-title').textContent = title;
      $('o-ended-text').textContent = text;
      return;
    }
    const o = myPending();
    if (!o) return;
    $('o-amount').textContent = peso(o.amount);
    $('o-total').textContent = peso(o.amount);
    $('o-number').textContent = o.number;
    $('o-items').innerHTML = cartRows(o.items);
    if (qrFor !== o.number) {
      qrFor = o.number;
      const canQr = !!staffBase && typeof qrcode === 'function';
      if (canQr) {
        const q = qrcode(0, 'M');
        q.addData(`${staffBase}/staff/order/${o.number}`);
        q.make();
        $('o-qr').innerHTML = q.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
      }
      $('o-qr').hidden = !canQr;
      $('o-hint').hidden = !canQr;
    }
    const left = Math.max(0, o.remainingMs - (Date.now() - pendingSeenAt));
    const s = Math.ceil(left / 1000);
    $('o-wait-text').textContent = `Waiting for payment · ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} left`;
    const bar = $('o-bar');
    bar.style.width = `${Math.min(100, (left / o.totalMs) * 100)}%`;
    bar.parentElement.classList.toggle('is-low', left < 30000);
    const c = $('o-cancel');
    const confirming = Date.now() < cancelArmedUntil;
    c.classList.toggle('is-confirm', confirming);
    c.textContent = confirming ? 'Tap again to cancel' : 'Cancel order';
  }

  async function cancelOrder() {
    if (!myOrder) return;
    await post('/api/order/cancel', { number: myOrder });
  }

  // Two taps: a customer brushing the button should not lose their order.
  $('o-cancel').addEventListener('click', async () => {
    if (Date.now() < cancelArmedUntil) {
      cancelArmedUntil = 0;
      await cancelOrder();
      return;
    }
    cancelArmedUntil = Date.now() + 3000;
    renderOrder();
  });
  $('o-staff').addEventListener('click', () => show('pin'));
  $('pin-back').addEventListener('click', async () => {
    if (staffTablet) { show('order'); return; }
    await cancelOrder();
    myOrder = null;
    show('pay');
  });

  // ---- pin: staff confirm the cash ---------------------------------------------------
  function setPinMsg(text, shake) {
    $('pin-msg').textContent = text;
    if (shake) {
      const d = $('pin-dots');
      d.classList.remove('shake'); void d.offsetWidth; d.classList.add('shake');
    }
  }

  function renderPin() {
    const o = myPending();
    const items = o ? o.items : cartItems();
    const amount = o ? o.amount : cartTotal();
    $('pin-summary').innerHTML = cartRows(items);
    $('pin-amount').textContent = $('pin-total').textContent = peso(amount);
    $('pin-items').textContent = items.reduce((a, it) => a + it.qty, 0);
    const slots = Math.max(4, pin.length);
    $('pin-dots').innerHTML = Array.from({ length: slots }, (_, i) =>
      `<i class="${i < pin.length ? 'on' : ''}"></i>`).join('');
    $('confirm-cash').disabled = pin.length < 4 || sending || !machineReady() || !o;
    $('confirm-label').textContent = sending ? 'Checking…' : 'Confirm & Unlock';
  }

  $('keypad').addEventListener('click', (e) => {
    const k = e.target.closest('button[data-k]');
    if (!k || sending) return;
    const key = k.dataset.k;
    if (key === 'clear') pin = '';
    else if (key === 'back') pin = pin.slice(0, -1);
    else if (pin.length < 8) pin += key;
    setPinMsg('');
    renderPin();
  });

  $('confirm-cash').addEventListener('click', async () => {
    if (sending || pin.length < 4 || !myOrder) return;
    sending = true;
    renderPin();
    const r = await post('/api/order/pin', { number: myOrder, pin });
    sending = false;
    pin = '';
    if (r.code === 200) {
      order = { reference: r.body.order.reference, staff: r.body.order.by, items: r.body.order.items };
      renderPin();
      return;       // the credit arrives over the stream and route() goes to dispense
    }
    const e = r.body.error;
    if (e === 'wrong') setPinMsg('Wrong PIN. Please try again.', true);
    else if (e === 'locked') setPinMsg(`Too many wrong PINs. Try again in ${Math.ceil((r.body.retryInMs || 60000) / 1000)} s.`, true);
    else if (e === 'no_staff') setPinMsg('No staff PINs are set up on this kiosk. Please call staff.');
    else if (e === 'machine_busy') setPinMsg('The machine is still finishing an order. Please wait.');
    else if (['not_waiting', 'out_of_stock', 'price_changed'].includes(e)) { /* the stream shows why */ }
    else setPinMsg('The machine is not ready. Don\'t take the cash yet — please try again.');
    renderPin();
  });

  // ---- dispense: the purchased items, side by side ------------------------------
  function trackPours() {
    const now = Date.now();
    for (const s of status.slots) {
      const p = pour[s.slot] || (pour[s.slot] = { max: 0, last: -1, changedAt: 0, pausedLocal: false });
      if (!s.busy) { p.max = 0; p.last = -1; p.pausedLocal = false; continue; }
      if (s.remainingMs !== p.last) { p.last = s.remainingMs; p.changedAt = now; }
      if (s.remainingMs > p.max) p.max = s.remainingMs;
    }
  }

  function isPaused(s) {
    const p = pour[s.slot];
    if (!s.busy || !p) return false;
    return p.pausedLocal || (s.remainingMs > 0 && Date.now() - p.changedAt > PAUSED_AFTER_MS);
  }

  // What was bought. The server remembers the order; anything STATUS still
  // owes that the order does not list (a server restart lost it) is added
  // from STATUS, so paid presses are never missing from the screen.
  function orderItems() {
    const items = order ? order.items.map((i) => ({ slot: i.slot, qty: i.qty })) : [];
    if (status) {
      for (const s of status.slots) {
        if (!hasCredit(s) || items.some((i) => i.slot === s.slot)) continue;
        items.push({ slot: s.slot, qty: s.armed + s.queued + (s.busy ? 1 : 0) });
      }
    }
    return items.sort((a, b) => a.slot - b.slot);
  }

  // Units dispensed = bought - still owed - the one pouring now.
  function units(item) {
    const s = slotState(item.slot);
    const left = s.armed + s.queued;
    const pouring = s.busy ? 1 : 0;
    const qty = Math.max(item.qty, left + pouring);
    return { s, qty, pouring: !!s.busy, done: sawCredit ? qty - left - pouring : 0 };
  }

  function buildCards(items) {
    const key = items.map((i) => `${i.slot}:${i.qty}`).join(',');
    if (key === cardsKey) return;
    cardsKey = key;
    const row = $('d-row');
    row.classList.toggle('many', items.length > 4);
    row.innerHTML = items.map((i) => {
      const p = products[i.slot - 1];
      return `<div class="d-card" id="dc-${i.slot}">
        <div class="d-img"><img src="${p.img}" alt=""></div>
        <div class="d-nozzle">Nozzle ${i.slot}</div>
        <h3 class="d-name">${p.name}</h3>
        <div class="d-qty"></div>
        <div class="d-count"></div>
        <div class="d-pips"></div>
        <div class="d-bar"><i></i></div>
        <button class="d-btn" data-slot="${i.slot}">DISPENSE</button>
      </div>`;
    }).join('');
  }

  const POUR_MSG = {
    no_credit: '',
    empty: 'This product has just run out. Please call a staff member.',
    max_active: 'Please wait — another nozzle is still pouring.',
    priming: 'This nozzle is being cleaned. Please try again in a moment.',
    machine_paused: 'The machine has been paused by staff. Please wait.',
    slot_paused: 'Tap to resume.',
    cooldown: 'Please tap again.',
    timeout: 'The machine did not answer. Please tap again.',
    offline: 'The machine is not ready. Your paid items are safe.',
  };

  function renderDispense() {
    if (!status) return;
    const items = orderItems();
    buildCards(items);
    const anyPouring = status.slots.some((s) => s.busy);
    let unitsLeft = 0;
    let allDone = sawCredit && items.length > 0;

    for (const item of items) {
      const card = $(`dc-${item.slot}`);
      if (!card) continue;
      const prod = products[item.slot - 1];
      const u = units(item);
      const paused = isPaused(u.s);
      const complete = sawCredit && u.done >= u.qty && !u.pouring;
      if (!complete) allDone = false;
      unitsLeft += u.qty - u.done;

      card.classList.toggle('is-pouring', u.pouring && !paused);
      card.classList.toggle('is-paused', u.pouring && paused);
      card.classList.toggle('is-done', complete);
      card.classList.toggle('is-waiting', !u.pouring && !complete && (anyPouring || sending));

      card.querySelector('.d-qty').textContent =
        `Quantity: ${u.qty}${prod.ml ? ` · ${prod.ml} ml each` : ''}`;
      card.querySelector('.d-count').textContent =
        !sawCredit ? 'Unlocking…'
        : u.s.empty && !complete && !u.pouring ? 'Out of stock — call staff'
        : `${u.done} / ${u.qty} dispensed${complete ? ' ✓' : ''}`;
      card.querySelector('.d-pips').innerHTML = u.qty <= 12
        ? Array.from({ length: u.qty }, (_, i) =>
            `<i class="${i < u.done ? 'done' : i === u.done && u.pouring ? 'now' : ''}"></i>`).join('')
        : '';

      const p = pour[item.slot];
      const pct = u.pouring && p && p.max ? Math.round(100 * (1 - u.s.remainingMs / p.max)) : 0;
      card.querySelector('.d-bar i').style.width = `${pct}%`;

      // DISPENSE -> DISPENSING... -> DISPENSED ✓. While pouring, the same
      // button pauses and resumes, so the customer never has to look for it.
      const btn = card.querySelector('.d-btn');
      let act = '';
      let html = 'PLEASE WAIT';
      let cls = 'd-btn';
      if (sending && sendingSlot === item.slot) html = 'STARTING…';
      else if (!sawCredit) html = 'PLEASE WAIT';
      else if (u.pouring && paused) { act = 'resume'; html = 'PAUSED<small>Tap to resume</small>'; cls += ' is-paused'; }
      else if (u.pouring) { act = 'pause'; html = 'DISPENSING…<small>Tap to pause</small>'; cls += ' is-pouring'; }
      else if (complete) { html = 'DISPENSED ✓'; cls += ' is-done'; }
      else if (u.s.empty) html = 'CALL STAFF';
      else if (!anyPouring && !sending) { act = 'dispense'; html = u.done ? 'DISPENSE NEXT' : 'DISPENSE'; }
      btn.dataset.act = act;
      btn.disabled = !act;
      btn.className = cls;
      if (btn.innerHTML !== html) btn.innerHTML = html;
    }

    $('d-sub').textContent = order && order.staff
      ? `Cash received by ${order.staff}. Place your bottle under the nozzle shown, then tap Dispense.`
      : 'Place your bottle under the nozzle shown, then tap Dispense.';
    $('d-msg').textContent = status.paused ? POUR_MSG.machine_paused : pourMsg;
    const finished = allDone && !anyPouring;
    $('d-done').hidden = !finished;
    $('d-left').textContent = finished
      ? 'Everything is dispensed.'
      : sawCredit ? `${unitsLeft} ${unitsLeft === 1 ? 'unit' : 'units'} left to dispense` : 'Unlocking your items…';
  }

  $('d-row').addEventListener('click', async (e) => {
    const btn = e.target.closest('.d-btn');
    if (!btn || btn.disabled || sending) return;
    const act = btn.dataset.act;
    const slot = +btn.dataset.slot;
    if (!act) return;
    sending = true;
    sendingSlot = slot;
    pourMsg = '';
    render();
    const r = await post(`/api/${act}`, { slot });
    sending = false;
    sendingSlot = 0;
    const result = r.body.result || r.body.error;
    const p = pour[slot];
    if (p && act === 'pause' && result === 'ok') p.pausedLocal = true;
    if (p && act === 'resume' && result === 'ok') { p.pausedLocal = false; p.changedAt = Date.now(); }
    pourMsg = result === 'ok' ? '' : (POUR_MSG[result] || '');
    render();
  });
  $('d-done').addEventListener('click', () => show('thanks'));

  // ---- navigation, idle, liveness ------------------------------------------------
  document.addEventListener('click', (e) => {
    const go = e.target.closest('[data-go]');
    if (go && !e.target.closest('button:not([data-go])')) show(go.dataset.go);
  });
  document.addEventListener('pointerdown', () => { lastTouch = Date.now(); }, true);
  document.addEventListener('contextmenu', (e) => e.preventDefault());

  function onState(data) {
    lastMsgAt = Date.now();
    online = data.online;
    status = data.status;
    if (data.order) order = data.order;
    pending = data.pending || null;
    if (pending) pendingSeenAt = Date.now();
    lastClosed = data.lastClosed || null;
    if (data.prices && Object.keys(data.prices).length) prices = data.prices;
    if (status) trackPours();
    route();
    render();
  }

  function openStream() {
    if (es) es.close();
    streamOpenedAt = Date.now();
    es = new EventSource('/api/stream');
    es.onmessage = (e) => { try { onState(JSON.parse(e.data)); } catch (_) {} };
  }

  setInterval(() => {
    const now = Date.now();
    // An open stream that has gone quiet never fires onerror, so rebuild it.
    if (now - lastMsgAt > OFFLINE_MS && now - streamOpenedAt > OFFLINE_MS) openStream();
    // An order keeps the screen: only the order's own timeout ends it.
    if (['shop', 'pay'].includes(screen) && now - lastTouch > idleSeconds * 1000) show('attract');
    if (screen === 'pin' && !myOrder && now - lastTouch > idleSeconds * 1000) show('attract');
    if (screen === 'thanks' && now - thanksAt > THANKS_MS) show('attract');
    route();
    render();
  }, 1000);

  async function boot() {
    try {
      const s = await (await fetch('/api/state')).json();
      products = s.products;
      idleSeconds = s.idleSeconds;
      cashReady = s.cashReady;
      staffTablet = !!s.staffTablet;
      staffBase = s.staffBase || null;
      buildGrid();
      show('attract');
      onState(s);
    } catch (_) {
      setTimeout(boot, 2000);
      return;
    }
    openStream();
  }
  boot();
})();
```

- [ ] **Step 5: Syntax check and suite**

Run: `cd kiosk_server && node --check public/js/kiosk.js && npm test`
Expected: no syntax error; all tests PASS.

- [ ] **Step 6: Check the flow against the real controller**

Start the controller and the kiosk server (see `CLAUDE.md` → "Trying the whole kiosk on a PC"), with `STAFF_TABLET = 1` in the local `CONFIG/config.env`. Then:

```bash
curl -s -X POST localhost:3000/api/order -H 'Content-Type: application/json' -d '{"items":[{"slot":1,"qty":1}],"amount":5}'
curl -s localhost:3000/api/state | grep -o '"staffBase":"[^"]*"'
curl -s -X POST localhost:3000/api/order/cancel -H 'Content-Type: application/json' -d '{"number":"A-1"}'
```

Expected: the first prints an order with `"number":"A-1"`; the second prints `"staffBase":"http://<this PC's LAN IP>:3000"`; the third prints `{"ok":true}`. Open `http://localhost:3000/` in a browser: after Unlock → Cash it shows "Pay at the counter" with a QR and a countdown; **Cancel order** needs two taps.

- [ ] **Step 7: Commit**

```bash
git add kiosk_server/public/js/qrcode.js kiosk_server/public/index.html kiosk_server/public/css/kiosk.css kiosk_server/public/js/kiosk.js
git commit -m "feat(kiosk): Pay at the counter screen with a QR

Cash now creates an order. With the staff tablet on, the kiosk shows the
order -- products, quantities, total -- with a QR linking to it on the staff
page, a small order number and a countdown, and unlocks itself when staff
mark it paid. Expired or cancelled orders say why, then return to the
start. The kiosk PIN confirms the same order. QR encoder vendored from
qrcode-generator 1.4.4 (MIT)."
```

---

### Task 6: The staff tablet page

**Files:**
- Modify: `kiosk_server/public/staff/index.html` (replace the Task 4 placeholder)
- Create: `kiosk_server/public/staff/staff.css`
- Create: `kiosk_server/public/staff/staff.js`

**Interfaces:**
- Consumes: Task 4 HTTP (`/staff/api/login`, `/logout`, `/me`, `/state`, `/order?number=`, `/orders/paid`, `/orders/cancel`); `publicOrder` shape from Task 3.

- [ ] **Step 1: Write `public/staff/index.html`**

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#0B0E14">
  <title>Sabon Express · Staff</title>
  <link rel="stylesheet" href="/staff/staff.css">
</head>
<body>
  <header class="s-top">
    <img class="s-logo" src="/img/sabon-express-logo.png" alt="Sabon Express">
    <span class="s-state" id="s-state"><i></i><b>—</b></span>
    <span class="s-me" id="s-me" hidden></span>
    <button class="s-btn s-ghost s-out" id="s-out" type="button" hidden>Sign out</button>
  </header>

  <main>
    <!-- Sign in, once per shift -->
    <section class="s-card s-login" id="v-login" hidden>
      <h1>Staff sign in</h1>
      <p>Enter your PIN</p>
      <div class="s-dots" id="l-dots"></div>
      <div class="s-msg" id="l-msg" role="alert"></div>
      <div class="s-keypad" id="l-keypad">
        <button data-k="1">1</button><button data-k="2">2</button><button data-k="3">3</button>
        <button data-k="4">4</button><button data-k="5">5</button><button data-k="6">6</button>
        <button data-k="7">7</button><button data-k="8">8</button><button data-k="9">9</button>
        <button data-k="clear" class="k-alt">Clear</button><button data-k="0">0</button><button data-k="back" class="k-alt">⌫</button>
      </div>
      <button class="s-btn s-primary s-wide" id="l-go" type="button" disabled>Sign in</button>
    </section>

    <!-- Main: the waiting order and today -->
    <section id="v-main" hidden>
      <div class="s-card" id="w-card">
        <div class="s-card-head">
          <h2 id="w-title">Waiting for payment</h2>
          <span class="s-num" id="w-num"></span>
        </div>
        <div id="w-body" hidden>
          <ul class="s-items" id="w-items"></ul>
          <div class="s-total"><span>Total</span><b id="w-total"></b></div>
          <div class="s-timer" id="w-timer"></div>
          <button class="s-btn s-primary s-wide s-big" id="w-paid" type="button">Mark as paid</button>
          <button class="s-btn s-danger-ghost s-wide" id="w-cancel" type="button">Cancel order</button>
        </div>
        <p class="s-empty" id="w-empty">No order waiting.</p>
        <p class="s-msg" id="w-msg" role="alert"></p>
      </div>

      <div class="s-card">
        <div class="s-card-head">
          <h2>Today</h2>
          <span class="s-sum" id="t-sum"></span>
        </div>
        <ul class="s-log" id="t-list"></ul>
      </div>
    </section>
  </main>

  <!-- One confirm dialog, reused for paid and cancel -->
  <div class="s-dialog" id="dlg" hidden>
    <div class="s-card">
      <h2 id="dlg-title"></h2>
      <p id="dlg-text"></p>
      <div class="s-row">
        <button class="s-btn s-ghost" id="dlg-no" type="button">Back</button>
        <button class="s-btn s-primary" id="dlg-yes" type="button">Yes</button>
      </div>
    </div>
  </div>

  <script src="/staff/staff.js"></script>
</body>
</html>
```

- [ ] **Step 2: Write `public/staff/staff.css`**

```css
/* Staff tablet page -- the kiosk's black and blue, sized for a phone or tablet. */
@font-face { font-family:'Helvetica Neue LT'; font-weight:400; font-display:swap; src:url('/fonts/helvetica-neue-400.woff2') format('woff2'); }
@font-face { font-family:'Helvetica Neue LT'; font-weight:700; font-display:swap; src:url('/fonts/helvetica-neue-700.woff2') format('woff2'); }

:root {
  --bg: #0B0E14; --surface: #141925; --surface-sub: #1C2333;
  --ink: #F5F7FA; --ink-2: #8A93A6; --line: #232A3B;
  --brand: #3B6DF0; --brand-tint: #172243;
  --green: #34D399; --green-tint: #11291F;
  --amber: #FBBF24; --red: #F87171; --red-tint: #331A1D;
  --r: 20px;
  font-family: 'Helvetica Neue LT', system-ui, sans-serif;
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
html, body { margin: 0; background: var(--bg); color: var(--ink); -webkit-tap-highlight-color: transparent; }
body { max-width: 720px; margin: 0 auto; padding: 12px 14px 40px; }
button { font: inherit; color: inherit; border: 0; background: none; cursor: pointer; touch-action: manipulation; }
img { pointer-events: none; }

.s-top { display: flex; align-items: center; gap: 12px; padding: 8px 0 14px; flex-wrap: wrap; }
.s-logo { height: 40px; }
.s-state { display: inline-flex; align-items: center; gap: 8px; padding: 8px 14px; border-radius: 999px; background: var(--surface); border: 1px solid var(--line); font-size: 15px; }
.s-state i { width: 10px; height: 10px; border-radius: 50%; background: var(--ink-2); }
.s-state.is-ready i { background: var(--green); }
.s-state.is-dispensing i { background: var(--amber); }
.s-state.is-offline i { background: var(--red); }
.s-me { margin-left: auto; font-size: 15px; color: var(--ink-2); }
.s-out { min-height: 44px; }

.s-card { background: var(--surface); border: 1px solid var(--line); border-radius: var(--r); padding: 18px; margin-bottom: 14px; }
.s-card-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; margin-bottom: 12px; }
.s-card-head h2 { margin: 0; font-size: 22px; }
.s-num { font-size: 18px; color: var(--ink-2); font-variant-numeric: tabular-nums; }
#w-card.is-live { border-color: var(--brand); box-shadow: 0 0 0 3px var(--brand-tint); }
#w-card.is-focus { border-color: var(--amber); }

.s-items { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.s-items li { display: grid; grid-template-columns: 52px 1fr auto auto; gap: 12px; align-items: center; padding: 8px 10px; background: var(--surface-sub); border-radius: 14px; }
.s-items img { width: 52px; height: 52px; object-fit: contain; }
.s-items b { font-size: 18px; }
.s-items .q { font-size: 20px; font-weight: 700; }
.s-items .p { font-size: 17px; color: var(--ink-2); font-variant-numeric: tabular-nums; }
.s-total { display: flex; justify-content: space-between; align-items: baseline; margin: 14px 4px 4px; font-size: 18px; }
.s-total b { font-size: 34px; color: #8FB0FF; font-variant-numeric: tabular-nums; }
.s-timer { margin: 4px 4px 14px; color: var(--ink-2); font-variant-numeric: tabular-nums; }
.s-timer.is-low { color: var(--amber); font-weight: 700; }
.s-empty { margin: 6px 0; color: var(--ink-2); font-size: 17px; }
.s-msg { min-height: 22px; margin: 10px 0 0; font-weight: 700; color: var(--red); }
.s-msg.is-ok { color: var(--green); }

.s-btn { display: inline-flex; align-items: center; justify-content: center; min-height: 52px; padding: 0 20px; border-radius: 999px; font-size: 17px; font-weight: 700; border: 1px solid transparent; }
.s-btn:disabled { opacity: .45; }
.s-primary { background: var(--brand); color: #fff; }
.s-ghost { border-color: var(--line); background: var(--surface-sub); }
.s-danger-ghost { border-color: var(--red); color: var(--red); }
.s-wide { width: 100%; margin-top: 10px; }
.s-big { min-height: 68px; font-size: 22px; }
.s-row { display: flex; gap: 10px; margin-top: 16px; }
.s-row .s-btn { flex: 1; }

.s-login { text-align: center; max-width: 420px; margin: 20px auto; }
.s-login h1 { margin: 6px 0 0; font-size: 26px; }
.s-login p { margin: 6px 0 0; color: var(--ink-2); }
.s-dots { display: flex; justify-content: center; gap: 16px; margin: 18px 0 6px; height: 22px; }
.s-dots i { width: 18px; height: 18px; border-radius: 50%; border: 2px solid var(--ink-2); }
.s-dots i.on { background: var(--ink); border-color: var(--ink); }
.s-keypad { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-top: 10px; }
.s-keypad button { min-height: 64px; border-radius: 14px; background: var(--surface-sub); border: 1px solid var(--line); font-size: 26px; font-weight: 700; }
.s-keypad button.k-alt { font-size: 16px; color: var(--ink-2); }
.s-keypad button:active { background: var(--brand-tint); }

.s-sum { font-size: 17px; color: var(--ink-2); }
.s-log { list-style: none; margin: 0; padding: 0; }
.s-log li { display: grid; grid-template-columns: 56px 60px 1fr; gap: 10px; padding: 10px 2px; border-top: 1px solid var(--line); font-size: 15px; }
.s-log li:first-child { border-top: 0; }
.s-log .st-paid { color: var(--green); }
.s-log .st-expired, .s-log .st-cancelled { color: var(--ink-2); }

.s-dialog { position: fixed; inset: 0; display: grid; place-items: center; padding: 16px; background: rgba(0,0,0,.7); z-index: 10; }
.s-dialog .s-card { width: 100%; max-width: 420px; text-align: center; }
.s-dialog h2 { margin: 0; font-size: 24px; }
.s-dialog p { color: var(--ink-2); }
```

- [ ] **Step 3: Write `public/staff/staff.js`**

```js
'use strict';
// Staff tablet page: sign in once per shift, see the kiosk's waiting order,
// mark it paid or cancel it. Polls the server once a second -- on the shop
// Wi-Fi that is live enough and needs nothing more than plain fetch.

(() => {
  const $ = (id) => document.getElementById(id);
  const peso = (n) => '₱' + n;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // A scanned QR opens /staff/order/A-27: that order gets looked up and,
  // if it is not the one waiting, what happened to it is shown.
  const m = location.pathname.match(/^\/staff\/order\/([A-Z]-\d+)$/);
  let focus = m ? m[1] : null;

  let me = null;
  let pin = '';
  let state = null;
  let stateAt = 0;
  let polling = false;
  let busy = false;
  let lastPending = null;
  let focusNote = '';
  let dialogAction = null;
  let audio = null;

  async function api(path, body) {
    const opt = body === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    };
    try {
      const r = await fetch(path, { credentials: 'same-origin', ...opt });
      return { code: r.status, body: await r.json().catch(() => ({})) };
    } catch (_) {
      return { code: 0, body: { error: 'network' } };
    }
  }

  function showView(v) {
    $('v-login').hidden = v !== 'login';
    $('v-main').hidden = v !== 'main';
    $('s-me').hidden = v !== 'main';
    $('s-out').hidden = v !== 'main';
  }

  // A short two-note chime for a new order. Browsers only allow sound after a
  // tap, and signing in is that tap.
  function chime() {
    if (!audio) return;
    const t = audio.currentTime;
    for (const [f, at] of [[880, 0], [1320, 0.16]]) {
      const o = audio.createOscillator();
      const g = audio.createGain();
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t + at);
      g.gain.exponentialRampToValueAtTime(0.3, t + at + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + at + 0.25);
      o.connect(g).connect(audio.destination);
      o.start(t + at);
      o.stop(t + at + 0.3);
    }
  }

  // ---- sign in ----------------------------------------------------------------
  function renderLogin(msg) {
    $('l-dots').innerHTML = Array.from({ length: Math.max(4, pin.length) }, (_, i) =>
      `<i class="${i < pin.length ? 'on' : ''}"></i>`).join('');
    $('l-go').disabled = pin.length < 4 || busy;
    if (msg !== undefined) $('l-msg').textContent = msg;
  }

  $('l-keypad').addEventListener('click', (e) => {
    const k = e.target.closest('button[data-k]');
    if (!k || busy) return;
    const key = k.dataset.k;
    if (key === 'clear') pin = '';
    else if (key === 'back') pin = pin.slice(0, -1);
    else if (pin.length < 8) pin += key;
    renderLogin('');
  });

  $('l-go').addEventListener('click', async () => {
    if (busy || pin.length < 4) return;
    try { audio = audio || new (window.AudioContext || window.webkitAudioContext)(); } catch (_) { audio = null; }
    busy = true;
    renderLogin();
    const r = await api('/staff/api/login', { pin });
    busy = false;
    pin = '';
    if (r.code === 200) { me = r.body.name; start(); return; }
    const e = r.body.error;
    renderLogin(e === 'locked' ? `Too many wrong PINs. Try again in ${Math.ceil((r.body.retryInMs || 60000) / 1000)} s.`
      : e === 'no_staff' ? 'No staff PINs are set up on this kiosk.'
      : e === 'network' ? 'Cannot reach the kiosk. Check the Wi-Fi.'
      : 'Wrong PIN. Please try again.');
  });

  $('s-out').addEventListener('click', async () => {
    await api('/staff/api/logout', {});
    me = null;
    showView('login');
    renderLogin('');
  });

  // ---- main -------------------------------------------------------------------
  function start() {
    $('s-me').textContent = `Signed in as ${me}`;
    showView('main');
    if (focus) lookup(focus);
    if (!polling) { polling = true; poll(); }
  }

  async function poll() {
    const r = await api('/staff/api/state');
    if (r.code === 401) { polling = false; me = null; showView('login'); renderLogin(''); return; }
    if (r.code === 200) { state = r.body; stateAt = Date.now(); render(); }
    else if (r.code === 0) { $('w-msg').className = 's-msg'; $('w-msg').textContent = 'Cannot reach the kiosk. Check the Wi-Fi.'; }
    setTimeout(poll, 1000);
  }

  async function lookup(number) {
    const r = await api(`/staff/api/order?number=${encodeURIComponent(number)}`);
    if (r.code !== 200) { focusNote = `Order ${number} is not known on this kiosk (it may be from another day).`; return; }
    const o = r.body.order;
    if (o.status === 'waiting') { focusNote = ''; return; }
    const when = (o.closed || '').slice(11, 16);
    focusNote = o.status === 'paid' ? `Order ${o.number} was already paid (${o.by}, ${when}).`
      : o.status === 'expired' ? `Order ${o.number} expired — do not take payment. Ask the customer to order again.`
      : `Order ${o.number} was cancelled (${o.reason}${o.by ? `, ${o.by}` : ''}) — do not take payment.`;
  }

  function render() {
    if (!state) return;
    const st = $('s-state');
    st.className = `s-state is-${state.machine}`;
    st.querySelector('b').textContent = { ready: 'Kiosk ready', dispensing: 'Dispensing', offline: 'Kiosk offline' }[state.machine];

    const o = state.pending;
    if (o && o.number !== lastPending) chime();
    lastPending = o ? o.number : null;

    const card = $('w-card');
    card.classList.toggle('is-live', !!o);
    card.classList.toggle('is-focus', !!focus && (!o || o.number !== focus) && !!focusNote);
    $('w-body').hidden = !o;
    $('w-empty').hidden = !!o;
    $('w-num').textContent = o ? `Order ${o.number}` : '';
    if (o) {
      $('w-items').innerHTML = o.items.map((i) => `<li>
        <img src="${esc(i.img)}" alt=""><b>${esc(i.name)}</b><span class="q">× ${i.qty}</span><span class="p">${peso(i.price * i.qty)}</span>
      </li>`).join('');
      $('w-total').textContent = peso(o.amount);
      const left = Math.max(0, o.remainingMs - (Date.now() - stateAt));
      const s = Math.ceil(left / 1000);
      const t = $('w-timer');
      t.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} left to pay`;
      t.classList.toggle('is-low', left < 30000);
      $('w-paid').textContent = `Mark as paid · ${peso(o.amount)}`;
      $('w-paid').disabled = busy || state.machine === 'offline';
      $('w-cancel').disabled = busy;
    }
    if (focusNote && (!o || o.number !== focus)) {
      $('w-msg').className = 's-msg';
      $('w-msg').textContent = focusNote;
    }

    const today = state.today;
    $('t-sum').textContent = `${today.paid} paid · ${peso(today.total)}`;
    $('t-list').innerHTML = today.orders.map((x) => `<li>
      <span>${esc(x.number)}</span><span>${peso(x.amount)}</span>
      <span class="st-${x.status}">${x.status === 'paid' ? `Paid · ${esc(x.by)}` : x.status === 'expired' ? 'Expired'
        : `Cancelled · ${esc(x.reason)}${x.by ? ` · ${esc(x.by)}` : ''}`} · ${esc((x.closed || '').slice(11, 16))}</span>
    </li>`).join('') || '<li><span></span><span></span><span>No orders yet today.</span></li>';
  }

  // ---- confirm dialog ---------------------------------------------------------
  function ask(title, text, yesLabel, action) {
    $('dlg-title').textContent = title;
    $('dlg-text').textContent = text;
    $('dlg-yes').textContent = yesLabel;
    dialogAction = action;
    $('dlg').hidden = false;
  }
  $('dlg-no').addEventListener('click', () => { $('dlg').hidden = true; dialogAction = null; });
  $('dlg-yes').addEventListener('click', async () => {
    $('dlg').hidden = true;
    const act = dialogAction;
    dialogAction = null;
    if (act) await act();
  });

  const PAID_MSG = {
    not_waiting: 'This order is no longer waiting — do not take payment.',
    offline: 'Machine not ready — don\'t take the cash yet.',
    out_of_stock: 'A product ran out — the order was cancelled. Do not take payment.',
    price_changed: 'Prices changed — the order was cancelled. Ask the customer to order again.',
    machine_busy: 'The machine is still busy — wait a moment and try again.',
    network: 'Cannot reach the kiosk. Check the Wi-Fi.',
  };

  $('w-paid').addEventListener('click', () => {
    const o = state && state.pending;
    if (!o) return;
    ask(`Did you receive ${peso(o.amount)} cash?`, `Order ${o.number}`, 'Yes, received', async () => {
      busy = true; render();
      const r = await api('/staff/api/orders/paid', { number: o.number });
      busy = false;
      const msg = $('w-msg');
      if (r.code === 200) { msg.className = 's-msg is-ok'; msg.textContent = `${o.number} paid. The kiosk is unlocked.`; }
      else { msg.className = 's-msg'; msg.textContent = PAID_MSG[r.body.error] || 'That did not work — try again.'; }
      focus = null; focusNote = '';
      render();
    });
  });

  $('w-cancel').addEventListener('click', () => {
    const o = state && state.pending;
    if (!o) return;
    ask(`Cancel order ${o.number}?`, 'The kiosk goes back to the start screen.', 'Yes, cancel', async () => {
      busy = true; render();
      const r = await api('/staff/api/orders/cancel', { number: o.number });
      busy = false;
      const msg = $('w-msg');
      msg.className = r.code === 200 ? 's-msg is-ok' : 's-msg';
      msg.textContent = r.code === 200 ? `${o.number} cancelled.` : (PAID_MSG[r.body.error] || 'That did not work — try again.');
      render();
    });
  });

  // ---- boot ---------------------------------------------------------------------
  (async () => {
    const r = await api('/staff/api/me');
    if (r.code === 200) { me = r.body.name; start(); }
    else { showView('login'); renderLogin(''); }
  })();
})();
```

- [ ] **Step 4: Syntax check and suite**

Run: `cd kiosk_server && node --check public/staff/staff.js && npm test`
Expected: no syntax error; all tests PASS.

- [ ] **Step 5: Try it by hand**

With the controller and kiosk server running (`STAFF_TABLET = 1`), open `http://localhost:3000/staff` in a second browser window, sign in with a staff PIN, then on `http://localhost:3000/` order and choose Cash. The staff window chimes and shows the order; **Mark as paid** → **Yes, received** → the kiosk window moves to *Your purchased items*.

- [ ] **Step 6: Commit**

```bash
git add kiosk_server/public/staff/index.html kiosk_server/public/staff/staff.css kiosk_server/public/staff/staff.js
git commit -m "feat(kiosk): staff tablet page

Sign in once per shift with a staff PIN; the page shows the kiosk's state,
the order waiting for payment with a countdown, Mark as paid behind a 'Did
you receive the cash?' confirm, Cancel order, and today's orders and cash
total. A scanned order link shows that order, or what happened to it. New
orders chime. Polls once a second; black and blue, phone-sized."
```

---

### Task 7: Settings, setup script and docs

**Files:**
- Modify: `CONFIG/config.env.sample`
- Modify: `CONFIG/README.md`
- Modify: `setup_and_run.sh`
- Modify: `CLAUDE.md`
- Modify: `docs/superpowers/specs/2026-09-28-counter-cash-design.md` (one line)

- [ ] **Step 1: Add the keys to `CONFIG/config.env.sample`**

Directly after the `KIOSK_IDLE_S = 60` line add:

```
# --- Staff tablet (counter cash) ---
# 1 = customers pay cash at the counter and staff mark the order paid from a
# phone or tablet on the shop Wi-Fi at http://<this Pi>:<KIOSK_PORT>/staff.
# The server then answers the shop Wi-Fi, but only that staff page: every
# customer action still answers this Pi alone. Put customers on a separate
# guest Wi-Fi -- the staff PIN crosses the shop network unencrypted.
# 0 or unset = cash is confirmed on the kiosk's own PIN pad, as before.
STAFF_TABLET = 0

# How long an order waits for payment before it expires, in seconds.
# Clamped 60..900.
ORDER_PAY_TIMEOUT_S = 180

# Letter in front of order numbers (A-27). Give each kiosk in one shop its own.
KIOSK_LETTER = A
```

- [ ] **Step 2: Document them in `CONFIG/README.md`**

In the "Kiosk server" table, after the `KIOSK_IDLE_S` row add:

```markdown
| `STAFF_TABLET` | `0` | `1` = customers pay cash at the counter and staff mark orders paid at `http://<pi>:<KIOSK_PORT>/staff` on the shop Wi-Fi. Only that page answers the Wi-Fi |
| `ORDER_PAY_TIMEOUT_S` | `180` | Seconds an order waits for payment before it expires. Clamped 60–900 |
| `KIOSK_LETTER` | `A` | Letter in front of order numbers (`A-27`); one per kiosk in a shop |
```

Then, in the "Staff (cash confirmation)" section, replace `Five wrong PINs in a row lock the pad for a minute and are logged to` + `` `logs/pin_lockouts.jsonl`. `` with `Five wrong PINs in a row lock that pad (kiosk or tablet) for a minute and are logged to` + `` `logs/staff_events.jsonl`. ``

- [ ] **Step 3: Print the staff address from `setup_and_run.sh`**

Directly after the line `log "[kiosk] Browser autostart installed: $AUTOSTART_DIR/sabon-kiosk.desktop"` add:

```bash
# Where staff open the tablet page, when counter cash is switched on.
if grep -qE '^[[:space:]]*STAFF_TABLET[[:space:]]*=[[:space:]]*1' "$SCRIPT_DIR/CONFIG/config.env" 2>/dev/null; then
  KPORT="$(sed -n 's/^[[:space:]]*KIOSK_PORT[[:space:]]*=[[:space:]]*//p' "$SCRIPT_DIR/CONFIG/config.env" | tail -1 | tr -d '\r"')"
  log "[kiosk] Staff tablet page: http://$(hostname -I | awk '{print $1}'):${KPORT:-3000}/staff"
fi
```

Then run: `bash -n setup_and_run.sh` — expected: no output.

- [ ] **Step 4: Update `CLAUDE.md`**

1. In the Status table, replace piece 3's row with:
   `| 3 | Counter cash + staff tablet (stage 1 of the counter-cash spec) | **Done** — `docs/superpowers/specs/2026-09-28-counter-cash-design.md` |`
2. In "Where things live", add rows:
   ```markdown
   | `kiosk_server/lib/orders.js` | The one waiting order: number, frozen price, 3-minute life |
   | `kiosk_server/lib/sessions.js`, `lib/access.js` | Staff sign-in; what the shop Wi-Fi may reach |
   | `kiosk_server/public/staff/` | The staff tablet page |
   ```
3. In "How the kiosk decides things", replace the bullet beginning `- **The server prices the sale, not the page.**` with:
   ```markdown
   - **Cash is an order.** `/api/order` prices it from the controller and
     freezes it; `confirmPaid()` in `server.js` is the only way a payment
     becomes presses, from the staff tablet or the kiosk PIN, and runs the
     spec's five checks in order. With `STAFF_TABLET = 1` staff confirm from
     `/staff` on the shop Wi-Fi, which is the only thing the Wi-Fi can reach.
   ```

- [ ] **Step 5: Note the images and fonts in the spec**

In `docs/superpowers/specs/2026-09-28-counter-cash-design.md`, replace the line beginning `- From any address other than the Pi itself, only `/staff*` answers.` with:

```markdown
- From any address other than the Pi itself, only `/staff*` answers, plus
  `/img/*` and `/fonts/*` (the staff page's pictures and fonts — static
  files, no actions). The kiosk page, its stream, and every customer action
  (`/api/order*`, `/api/dispense`, `/api/pause`, `/api/resume`) return 403.
```

(and delete the two continuation lines of the old bullet, which it replaces).

- [ ] **Step 6: Commit**

```bash
git add CONFIG/config.env.sample CONFIG/README.md setup_and_run.sh CLAUDE.md docs/superpowers/specs/2026-09-28-counter-cash-design.md
git commit -m "docs: counter cash settings, staff tablet address, CLAUDE.md

STAFF_TABLET, ORDER_PAY_TIMEOUT_S and KIOSK_LETTER in the sample and the
config README; setup_and_run.sh prints the staff page address when the
tablet is on; CLAUDE.md describes cash as an order confirmed through
confirmPaid()."
```

---

### Task 8: End-to-end check (run by the coordinator, not a subagent)

Against the real controller on mock GPIO, with `STAFF_TABLET = 1`, `ORDER_PAY_TIMEOUT_S = 60` and a staff PIN in the local `CONFIG/config.env`, drive two headless Chrome pages over the DevTools protocol — the kiosk at `http://localhost:3000/` and the staff page at `http://<LAN IP>:3000/staff` — and confirm:

- [ ] Order on the kiosk → the staff page shows it within 2 s → Mark as paid → the kiosk shows *Your purchased items* on its own; `payments.jsonl` has `via: "tablet"` and the staff name; one sale file per unit after dispensing.
- [ ] An order left alone expires at 1:00 → the kiosk says "Order expired", then the start screen; the staff page lists it as Expired.
- [ ] Cancel from the staff page → the kiosk says "Order cancelled by staff".
- [ ] Kiosk PIN fallback confirms the same order → `via: "kiosk_pin"`.
- [ ] From the LAN address, `/` and `/api/order` are 403; `/staff` is 200.
- [ ] Screenshots of the kiosk order screen and the staff page, checked by eye.
- [ ] Set `ORDER_PAY_TIMEOUT_S` back to 180; delete the run's `transaction/` and `logs/` files.
