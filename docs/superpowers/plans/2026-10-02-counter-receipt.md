# Counter Receipt + Hold-to-Accept Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The kiosk's "Pay at the counter" shows a thermal-paper receipt instead of a QR, and the cashier tablet pops the cash order up over everything with a hold-to-accept button.

**Architecture:** One shared receipt renderer (`public/staff/receipt.js` + `receipt.css`) used by both pages; the kiosk swaps its cash-order QR for the receipt; the staff page gains a pop-up overlay and a `holdButton()` helper used by the pop-up and the Overview hero. No server logic changes except `/api/state` carrying `kioskName`.

**Tech Stack:** Node (standard library, `node:test`, `vm`), plain browser JS/CSS.

**Spec:** `docs/superpowers/specs/2026-10-02-counter-receipt-design.md`

## Global Constraints

- Kiosk screen is 1920×1080 landscape; nothing tappable under 72px on the kiosk. Staff page is tablet/laptop (audit at 1440 and 1180).
- Receipt look: off-white `#FCFCF9` paper, `'Courier New', Courier, monospace`, dashed rules, torn bottom edge; all sizes in `em` from `.rcpt`'s `font-size`.
- Receipt content, in order: `SABON EXPRESS`; `<kiosk name> · Self-service refill`; rule; `ORDER` / number; date `Oct 2, 2026` / time `2:14 PM`; rule; one row per item `name xQTY` / line total; rule; `TOTAL` / amount; `Payment` / `CASH` (or `QR`); rule; `Pay at the counter` (or `Scan to pay`); `Thank you!`.
- Hold to accept: `HOLD_MS = 1000`; pointer or Space/Enter; early release does nothing; a click alone does nothing; when full → `POST /staff/api/orders/paid {number}` exactly as today; no confirm dialog.
- Pop-up only for cash orders (`method !== 'qr'`) while signed in; stacking: pop-up `z-index: 8` < notifications 9 < confirm dialog 10.
- Keep ids used elsewhere: `w-paid`, `w-cancel`, `o-qr`, `o-hint`, `o-number`, `o-items`, `o-total`.
- Escape every server string put into HTML.

---

### Task 1: Shared receipt + `kioskName` in `/api/state`

**Files:**
- Create: `kiosk_server/public/staff/receipt.js`
- Create: `kiosk_server/public/staff/receipt.css`
- Create: `kiosk_server/tests/receipt.test.js`
- Modify: `kiosk_server/server.js` (the `/api/state` handler, ~line 828)
- Modify: `kiosk_server/tests/server.test.js` (one assertion)

**Interfaces:**
- Produces: `window.Receipt.html(order, kioskName) → string` where `order` is a public order (`{ number, amount, method, created: 'YYYY-MM-DD HH:MM:SS', items: [{ name, qty, price }] }`); `window.Receipt.when(stamp) → [day, time]`. CSS classes `.rcpt`, `.rc-c`, `.rc-big`, `.rc-hr`, `.rc-row`, `.rc-tot`. `/api/state` → `kioskName: string`.

- [ ] **Step 1: Write the failing tests**

`kiosk_server/tests/receipt.test.js`:

```js
'use strict';
// receipt.js is a browser script (window.Receipt); run it in a VM.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function load() {
  const ctx = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'staff', 'receipt.js'), 'utf8'), ctx);
  return ctx.window.Receipt;
}
const ORDER = {
  number: 'A-12', amount: 25, method: 'cash', created: '2026-10-02 14:14:05',
  items: [{ name: 'Detergent 1', qty: 2, price: 5 }, { name: 'Fabcon <1>', qty: 1, price: 15 }],
};

test('date and 12-hour time from the order stamp', () => {
  const R = load();
  assert.deepStrictEqual(R.when('2026-10-02 14:14:05'), ['Oct 2, 2026', '2:14 PM']);
  assert.deepStrictEqual(R.when('2026-01-09 00:05:00'), ['Jan 9, 2026', '12:05 AM']);
  assert.deepStrictEqual(R.when(''), ['', '']);
});

test('a cash receipt: header, order, lines, total, payment', () => {
  const html = load().html(ORDER, 'Kiosk A');
  for (const s of ['SABON EXPRESS', 'Kiosk A · Self-service refill', 'A-12', 'Oct 2, 2026', '2:14 PM',
    'Detergent 1 x2', '₱10', 'TOTAL', '₱25', 'CASH', 'Pay at the counter', 'Thank you!']) {
    assert.ok(html.includes(s), `missing ${s}`);
  }
});

test('names are escaped; a QR order says QR', () => {
  const html = load().html({ ...ORDER, method: 'qr' }, '<b>K</b>');
  assert.ok(html.includes('Fabcon &lt;1&gt; x1'));
  assert.ok(html.includes('&lt;b&gt;K&lt;/b&gt;'));
  assert.ok(html.includes('>QR<') && html.includes('Scan to pay'));
});
```

In `kiosk_server/tests/server.test.js`, in the test that does `const s = await k.get('/api/state');` right after creating order A-1, add after `assert.strictEqual(s.body.pending.number, 'A-1');`:

```js
    assert.strictEqual(s.body.kioskName, 'Kiosk A');
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `cd kiosk_server && node --test tests/receipt.test.js tests/server.test.js`
Expected: receipt tests fail (ENOENT, file missing); the server assertion fails (`undefined !== 'Kiosk A'`).

- [ ] **Step 3: Write `receipt.js`**

```js
'use strict';
// The receipt for an order, as the customer (kiosk, Pay at the counter) and
// the cashier (staff page, the cash pop-up) see it -- and as a receipt
// printer would print it if one is ever added. One renderer so the two
// screens always match. Plain browser script: window.Receipt.
(function () {
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);
  const peso = (n) => '₱' + n;

  // "2026-10-02 14:14:05" -> ["Oct 2, 2026", "2:14 PM"]
  function when(stamp) {
    const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/.exec(String(stamp || ''));
    if (!m) return ['', ''];
    const h = Number(m[4]);
    return [`${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}`, `${h % 12 || 12}:${m[5]} ${h < 12 ? 'AM' : 'PM'}`];
  }

  function html(o, kioskName) {
    const [day, time] = when(o.created);
    const qr = o.method === 'qr';
    const rows = o.items.map((i) =>
      `<div class="rc-row"><span>${esc(i.name)} x${i.qty}</span><span>${peso(i.price * i.qty)}</span></div>`).join('');
    return `<div class="rcpt">
      <div class="rc-c rc-big">SABON EXPRESS</div>
      <div class="rc-c">${esc(kioskName || 'Kiosk')} · Self-service refill</div>
      <div class="rc-hr"></div>
      <div class="rc-row"><span>ORDER</span><b>${esc(o.number)}</b></div>
      <div class="rc-row"><span>${day}</span><span>${time}</span></div>
      <div class="rc-hr"></div>
      ${rows}
      <div class="rc-hr"></div>
      <div class="rc-row rc-tot"><span>TOTAL</span><span>${peso(o.amount)}</span></div>
      <div class="rc-row"><span>Payment</span><span>${qr ? 'QR' : 'CASH'}</span></div>
      <div class="rc-hr"></div>
      <div class="rc-c">${qr ? 'Scan to pay' : 'Pay at the counter'}</div>
      <div class="rc-c">Thank you!</div>
    </div>`;
  }

  window.Receipt = { html, when };
})();
```

- [ ] **Step 4: Write `receipt.css`**

```css
/* The order receipt (receipt.js): thermal paper, the same on the kiosk and
   the staff page. Set the size with font-size on .rcpt; all else is in em. */
.rcpt {
  position: relative; width: 22em; max-width: 100%; padding: 1.2em 1.2em 2em;
  background: #FCFCF9; color: #111; font-family: 'Courier New', Courier, monospace;
  font-size: 13px; line-height: 1.4; text-align: left;
  box-shadow: 0 .8em 2.4em rgba(0,0,0,.45);
}
/* The torn edge: a zigzag of the paper colour below the bottom. */
.rcpt::after {
  content: ''; position: absolute; left: 0; right: 0; bottom: -.75em; height: .75em;
  background:
    linear-gradient(-45deg, transparent .38em, #FCFCF9 .38em) 0 0 / .75em .75em,
    linear-gradient(45deg, transparent .38em, #FCFCF9 .38em) 0 0 / .75em .75em;
}
.rc-c { text-align: center; }
.rc-big { font-size: 1.7em; font-weight: 700; letter-spacing: .05em; }
.rc-hr { border-top: 1px dashed #555; margin: .7em 0; }
.rc-row { display: flex; justify-content: space-between; gap: 1em; }
.rc-row > :first-child { min-width: 0; overflow-wrap: anywhere; }
.rc-row > :last-child { flex: none; white-space: nowrap; }
.rc-tot { font-size: 1.25em; font-weight: 700; }
```

- [ ] **Step 5: `/api/state` carries `kioskName`**

In `kiosk_server/server.js`, the `/api/state` handler:

```js
      return json(res, 200, {
        products, idleSeconds, cashReady: staff.length > 0, staffTablet, qrDemo, ...snapshot(),
      });
```

becomes

```js
      return json(res, 200, {
        products, idleSeconds, cashReady: staff.length > 0, staffTablet, qrDemo, kioskName, ...snapshot(),
      });
```

- [ ] **Step 6: Run the tests**

Run: `cd kiosk_server && node --test tests/receipt.test.js tests/server.test.js` → all pass. Then `npm test` → all pass (127).

- [ ] **Step 7: Commit**

```bash
git add kiosk_server/public/staff/receipt.js kiosk_server/public/staff/receipt.css kiosk_server/tests/receipt.test.js kiosk_server/server.js kiosk_server/tests/server.test.js
git commit -m "feat: one thermal receipt renderer for the kiosk and the staff page; /api/state carries kioskName"
```

---

### Task 2: Kiosk — the receipt on "Pay at the counter"

**Files:**
- Modify: `kiosk_server/public/index.html` (`<head>`; `#v-order` ~lines 112-131; scripts ~line 230)
- Modify: `kiosk_server/public/js/kiosk.js` (`boot()` ~line 715; `renderOrder()` ~lines 350-395)
- Modify: `kiosk_server/public/css/kiosk.css` (the `order: pay at the counter` block ~lines 436-453)

**Interfaces:**
- Consumes: `window.Receipt.html(order, kioskName)`, `.rcpt` styles (Task 1), `/api/state` `kioskName`.

- [ ] **Step 1: Load the receipt on the kiosk page**

In `kiosk_server/public/index.html` `<head>`, after the kiosk stylesheet link, add:

```html
  <!-- The order receipt, shared with the staff page (served under /staff/) -->
  <link rel="stylesheet" href="/staff/receipt.css">
```

and before `<script src="js/kiosk.js"></script>` add:

```html
<script src="/staff/receipt.js"></script>
```

- [ ] **Step 2: Markup for the cash layout**

In `#v-order`, give the order column an id and add a cash column and the receipt slot:

```html
      <div class="o-layout" id="o-live">
        <div class="o-order" id="o-order">
          <ul class="v2-cart-list o-items" id="o-items"></ul>
          <div class="v2-totals">
            <div class="v2-total-row"><span>Total to pay</span><span class="v2-total-v v2-total-money" id="o-total">₱0</span></div>
          </div>
        </div>
        <!-- Cash: the order number large; the receipt on the right carries the rest -->
        <div class="o-cash" id="o-cash" hidden>
          <span>Order</span>
          <b id="o-cash-num">—</b>
          <span class="o-cash-amt">Pay <b id="o-cash-amt">₱0</b> at the counter</span>
        </div>
        <div class="o-side" id="o-side">
          <div class="o-qr" id="o-qr"></div>
          <p class="o-hint" id="o-hint">Or show staff a photo of this code.</p>
          <div class="o-number">Order <b id="o-number">—</b></div>
          <div class="o-receipt" id="o-receipt" hidden></div>
        </div>
      </div>
```

(Keep everything else in `#v-order` as it is.)

- [ ] **Step 3: `kiosk.js` — remember the kiosk name**

Next to `let staffBase = null;` add `let kioskName = '';`. In `boot()`, next to `staffBase = s.staffBase || null;`, add `kioskName = s.kioskName || '';`.

- [ ] **Step 4: `kiosk.js` — render the cash order as a receipt**

In `renderOrder()`:

1. Change the cash lead text to:

```js
      : 'Pay exactly <b class="k-amount" id="o-amount"></b> to the cashier. The machine unlocks by itself once they accept it.';
```

2. After `$('o-items').innerHTML = cartRows(o.items);` add:

```js
    // Cash: no QR (one kiosk, one tablet: the order reaches the cashier by
    // itself). The receipt on the right, the order number large on the left.
    const cash = !qr;
    $('o-order').hidden = cash;
    $('o-cash').hidden = !cash;
    $('o-receipt').hidden = !cash;
    $('o-side').classList.toggle('is-receipt', cash);
    $('o-number').hidden = cash;
    $('o-cash-num').textContent = o.number;
    $('o-cash-amt').textContent = peso(o.amount);
```

3. In the `if (qrFor !== qrKey) { ... }` block, at its start (after `qrFor = qrKey;`) add:

```js
      if (cash) $('o-receipt').innerHTML = Receipt.html(o, kioskName);
```

change the QR-building `if (canQr) { … }` to `if (!cash && canQr) { … }`, and change the two visibility lines at the block's end to:

```js
      $('o-qr').hidden = cash || !canQr;
      $('o-hint').hidden = cash || !canQr;
```

- [ ] **Step 5: `kiosk.css` — the cash layout**

After the `.o-number b` rule add:

```css
/* Cash: the order number large on the left, the receipt on the right. */
.o-cash { display: flex; flex-direction: column; justify-content: center; gap: 12px; }
.o-cash > span:first-child { font-size: 30px; color: var(--ink-2); }
.o-cash > b { font-size: 120px; line-height: 1; font-variant-numeric: tabular-nums; }
.o-cash-amt { margin-top: 12px; font-size: 34px; color: var(--ink-2); }
.o-cash-amt b { color: var(--ink); }
.o-side.is-receipt { background: none; border: 0; padding: 0; justify-content: center; }
.o-receipt .rcpt { font-size: 19px; width: 20em; }
```

- [ ] **Step 6: Check it**

Run: `cd kiosk_server && node --check public/js/kiosk.js && npm test` → all pass.
Run the real controller and `node server.js`, open `http://localhost:3000/` at 1920×1080 (headless Chrome screenshot is fine), add two products, Unlock → Cash: the screen shows the large order number and amount on the left and the receipt on the right, no QR, the countdown below. With `QR_DEMO = 1`, QR Ph still shows its QR. No console errors.

- [ ] **Step 7: Commit**

```bash
git add kiosk_server/public/index.html kiosk_server/public/js/kiosk.js kiosk_server/public/css/kiosk.css
git commit -m "feat(kiosk): Pay at the counter shows a thermal receipt instead of a QR"
```

---

### Task 3: Staff — the cash pop-up and hold to accept

**Files:**
- Modify: `kiosk_server/public/staff/index.html` (`<head>` stylesheet; the hero's `#w-paid`; a new `#pay-pop` before `#dlg`; the receipt script before `staff.js`)
- Modify: `kiosk_server/public/staff/staff.css`
- Modify: `kiosk_server/public/staff/staff.js`

**Interfaces:**
- Consumes: `window.Receipt.html(order, kioskName)`; `state.kiosk.name`; existing `api`, `notify`, `ask`, `render`, `busy`, `focus`, `focusNote`, `PAID_MSG`, `peso`, `stateAt`, `chime`.

- [ ] **Step 1: Markup**

In `<head>`, after the staff stylesheet: `<link rel="stylesheet" href="/staff/receipt.css">`. Before `<script src="/staff/staff.js"></script>`: `<script src="/staff/receipt.js"></script>`.

The hero button becomes a hold button (same id):

```html
                <button class="s-btn s-hold s-big" id="w-paid" type="button"><span>Hold · Cash received</span></button>
```

Before the `<!-- One confirm dialog … -->` comment add:

```html
  <!-- A cash order waiting at the counter: over every section until it is
       paid, cancelled or expired (staff.js renderPayPop). Under the
       notifications and the confirm dialog. -->
  <div class="p-pop" id="pay-pop" hidden>
    <div class="d-card p-card" role="dialog" aria-modal="true" aria-label="Cash order">
      <div class="p-receipt" id="pp-receipt"></div>
      <div class="p-side">
        <p class="h-kicker">NEW CASH ORDER</p>
        <b class="p-amt" id="pp-amt"></b>
        <div class="w-timer" id="pp-timer"></div>
        <div class="w-bar"><i id="pp-bar"></i></div>
        <button class="s-btn s-hold s-big" id="pp-hold" type="button"><span></span></button>
        <p class="p-hint">Hold until it fills</p>
        <button class="s-btn s-danger-ghost" id="pp-cancel" type="button">Cancel order</button>
      </div>
    </div>
  </div>
```

- [ ] **Step 2: CSS**

Append to `staff.css` (before the `@media (prefers-reduced-motion: reduce)` block, and add `.s-hold::before` to the reduced-motion `transition: none` list):

```css
/* Hold to accept: the green fill grows while held (HOLD_MS in staff.js);
   letting go early empties it. */
.s-hold { position: relative; overflow: hidden; color: var(--ink); border-color: var(--green); background: transparent; touch-action: none; user-select: none; -webkit-user-select: none; }
.s-hold::before { content: ''; position: absolute; inset: 0; width: 0; background: var(--green); opacity: .85; transition: width .15s ease; }
.s-hold.is-holding::before { width: 100%; transition: width 1s linear; }
.s-hold > span { position: relative; }
.s-hold:disabled { opacity: .5; }

/* The cash-order pop-up: over every section, under notifications (9) and the
   confirm dialog (10). */
.p-pop { position: fixed; inset: 0; z-index: 8; display: grid; place-items: center; padding: 16px; background: rgba(5,8,14,.7); animation: fade-in .2s ease; }
:root[data-theme="light"] .p-pop { background: rgba(17,24,39,.35); }
.p-card { display: flex; align-items: center; gap: 28px; width: min(720px, 100%); padding: 28px; border-color: var(--line-2); box-shadow: 0 16px 40px rgba(0,0,0,.45); animation: pop-in .2s var(--ease); }
.p-receipt .rcpt { font-size: 13px; }
.p-side { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 10px; }
.p-amt { font-size: 44px; line-height: 1.1; font-variant-numeric: tabular-nums; }
.p-hint { margin: -4px 0 4px; font-size: 13px; color: var(--ink-2); text-align: center; }
```

- [ ] **Step 3: JS — the hold helper**

In `staff.js`, after the notifications helpers (`notify`), add:

```js
  // A hold-to-confirm button: the fill grows while held; letting go early
  // empties it and does nothing, and a plain click does nothing. Held for
  // HOLD_MS (pointer, or Space / Enter) it runs onDone: accepting cash is one
  // deliberate press, no dialog.
  const HOLD_MS = 1000;
  function holdButton(btn, onDone) {
    let timer = null;
    const stop = () => { clearTimeout(timer); timer = null; btn.classList.remove('is-holding'); };
    const start = (e) => {
      if (btn.disabled || timer) return;
      if (e.type === 'keydown') {
        if ((e.key !== ' ' && e.key !== 'Enter') || e.repeat) return;
        e.preventDefault();
      }
      btn.classList.add('is-holding');
      timer = setTimeout(() => { stop(); onDone(); }, HOLD_MS);
    };
    btn.addEventListener('pointerdown', start);
    btn.addEventListener('keydown', start);
    for (const ev of ['pointerup', 'pointerleave', 'pointercancel', 'blur']) btn.addEventListener(ev, stop);
    btn.addEventListener('keyup', (e) => { if (e.key === ' ' || e.key === 'Enter') stop(); });
    btn.addEventListener('click', (e) => e.preventDefault());
    btn.addEventListener('contextmenu', (e) => e.preventDefault());   // touch long-press menu
  }
```

- [ ] **Step 4: JS — accept and cancel, shared by hero and pop-up**

Replace the `$('w-paid').addEventListener('click', …)` and `$('w-cancel').addEventListener('click', …)` blocks with:

```js
  // Cash received: the hold on the hero or the pop-up. Marked paid exactly
  // as before (logged with the staff name); no extra dialog.
  async function acceptCash() {
    const o = state && state.pending;
    if (!o || busy) return;
    busy = true; render();
    const r = await api('/staff/api/orders/paid', { number: o.number });
    busy = false;
    if (r.code === 200) notify({ kind: 'ok', title: `${o.number} paid`, sub: 'The kiosk is unlocked.' });
    else notify({ kind: 'bad', title: `${o.number} not marked paid`, sub: PAID_MSG[r.body.error] || 'That did not work — try again.' });
    focus = null; focusNote = '';
    $('w-msg').textContent = '';
    render();
  }
  holdButton($('w-paid'), acceptCash);
  holdButton($('pp-hold'), acceptCash);

  function cancelOrder() {
    const o = state && state.pending;
    if (!o) return;
    ask(`Cancel order ${o.number}?`, 'The kiosk goes back to the start screen.', 'Yes, cancel', async () => {
      busy = true; render();
      const r = await api('/staff/api/orders/cancel', { number: o.number });
      busy = false;
      if (r.code === 200) notify({ kind: 'ok', title: `${o.number} cancelled` });
      else notify({ kind: 'bad', title: `${o.number} not cancelled`, sub: PAID_MSG[r.body.error] || 'That did not work — try again.' });
      render();
    });
  }
  $('w-cancel').addEventListener('click', cancelOrder);
  $('pp-cancel').addEventListener('click', cancelOrder);
```

- [ ] **Step 5: JS — time left, shared; the hero's button label**

Add near `renderHero`:

```js
  // Time left on the waiting order, for the hero and the pop-up.
  function timeLeft(o) {
    const left = Math.max(0, o.remainingMs - (Date.now() - stateAt));
    const s = Math.ceil(left / 1000);
    return {
      text: `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} left to pay`,
      pct: o.totalMs ? Math.min(100, (left / o.totalMs) * 100) : 0,
      low: left < 30000,
    };
  }
```

In `renderHero()`, replace the timer/bar lines (`const left = …` through `$('w-bar').classList.toggle(…)`) with:

```js
      const tl = timeLeft(o);
      $('w-timer').textContent = tl.text;
      $('w-timer').classList.toggle('is-low', tl.low);
      $('w-bar').style.width = `${tl.pct}%`;
      $('w-bar').classList.toggle('is-low', tl.low);
```

and replace `$('w-paid').textContent = `Mark as paid · ${peso(o.amount)}`;` with:

```js
      $('w-paid').querySelector('span').textContent = `Hold · Cash received ${peso(o.amount)}`;
```

- [ ] **Step 6: JS — the pop-up**

In `renderHero()`'s new-order block, keep `chime()` for every new order but send the "New order" notification only for QR orders (the pop-up replaces it for cash):

```js
    if (o && seenFirstState && o.number !== lastPending) {
      chime();
      if (o.method === 'qr') {
        notify({
          kind: 'info', title: `New order ${o.number} · ${peso(o.amount)}`, sub: 'Waiting for QR payment',
          onClick: () => { showView('overview'); window.scrollTo({ top: 0, behavior: 'smooth' }); },
        });
      }
    }
```

Add, and call `renderPayPop();` in `render()` right after `renderHero();`:

```js
  // The cash-order pop-up: shown over every section while a cash order waits
  // and someone is signed in; gone once it is paid, cancelled or expired.
  function renderPayPop() {
    const o = state && state.pending;
    const show = !!o && o.method !== 'qr' && !$('app').hidden;
    $('pay-pop').hidden = !show;
    if (!show) { payPopFor = null; return; }
    if (payPopFor !== o.number) {
      payPopFor = o.number;
      $('pp-receipt').innerHTML = Receipt.html(o, state.kiosk.name);
    }
    $('pp-amt').textContent = peso(o.amount);
    const tl = timeLeft(o);
    $('pp-timer').textContent = tl.text;
    $('pp-timer').classList.toggle('is-low', tl.low);
    $('pp-bar').style.width = `${tl.pct}%`;
    $('pp-bar').classList.toggle('is-low', tl.low);
    $('pp-hold').querySelector('span').textContent = `Hold · Cash received ${peso(o.amount)}`;
    $('pp-hold').disabled = busy || state.machine === 'offline';
    $('pp-cancel').disabled = busy;
  }
```

Declare `let payPopFor = null;   // the order the pop-up's receipt was drawn for` with the other state `let`s near the top of the file. Hide the pop-up when signing out: in `showScreen(v)`'s non-main branch add `$('pay-pop').hidden = true; payPopFor = null;`.

- [ ] **Step 7: Check it**

Run: `cd kiosk_server && node --check public/staff/staff.js && npm test` → all pass. Run the layout audit plain and with `AUDIT_ORDER=1` → every rule passes.
In a browser (headless Chrome via CDP is fine), signed in on `/staff`:
- create a cash order (`POST /api/order`) → the pop-up appears on Overview and on another section, with the receipt and `Hold · Cash received ₱X`;
- `pointerdown` then `pointerup` after 300 ms on `#pp-hold` → the order is still waiting;
- `pointerdown`, wait 1200 ms, `pointerup` → `… paid` notification, pop-up gone, `logs/payments.jsonl` has the payment by the signed-in staff;
- a new order then Cancel → confirm dialog shows above the pop-up; Yes → cancelled, pop-up gone;
- a QR order (`QR_DEMO = 1`) → no pop-up, the "New order" notification shows.

- [ ] **Step 8: Commit**

```bash
git add kiosk_server/public/staff/index.html kiosk_server/public/staff/staff.css kiosk_server/public/staff/staff.js
git commit -m "feat(staff): cash orders pop up over every section; hold to accept the cash"
```
