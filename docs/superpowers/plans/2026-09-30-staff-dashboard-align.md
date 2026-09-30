# Staff Dashboard: Organize, Align, 12-hour Times — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put every part of the staff dashboard on one grid so edges, rows and heights line up, and show every clock time as 12-hour with AM/PM.

**Architecture:** A measurable definition of "aligned" comes first: a layout audit (headless Chrome) that checks the rules below on every section at two window sizes and fails loudly. Then a small shared time formatter (`public/staff/time.js`, unit-tested). Then the page moves onto one 12-column grid where cards in a row share their height and stacked columns end on the same line. Last, the components inside the grid get fixed row heights, fixed columns and single-line text.

**Tech Stack:** Plain HTML/CSS/JS in `kiosk_server/public/staff/`, Node ≥ 20 standard library, `node:test`; the audit tool uses Chrome over the DevTools protocol (Node ≥ 22 for the built-in `WebSocket`; dev PC only, never the Pi).

**Branch:** `piece-7/dashboard-align` from `main`.

## What is wrong today (audited 2026-09-30 at 1440×900)

1. Top bar: the kiosk card is 84 px tall, the Staff and Sign out pills 56 px — different heights and centre lines.
2. Sections use different column splits (Overview 70/30, Health and Inventory 50/50, Settings a half-width card with nothing beside it).
3. Cards side by side have different heights (Health: 590 vs 170; Inventory: 640 vs 180; Transactions: 530 vs 290), and the two Overview columns end on different lines.
4. Text wraps where it should not: the "Today's sales" title and its summary, "Inventory & Prices" in its tile, the stat cards' "↑ 250% / vs. yesterday", Kiosk Status sub-lines.
5. Stat cards have 1 to 3 text lines, so their sparklines sit at different heights.
6. Order rows with a cancel reason are taller than the others, and "customer" / "by customer" says the same thing twice.
7. The sidebar card runs the full page height, so its "System Online" box floats in the middle of it.
8. Price history hangs under the price editor in a different column layout; the Health status rows are a different size from Overview's.
9. Times are 24-hour: `13:31`, `Last confirmed 10:45`, `09-29 09:05`, `11:12`, the sidebar clock `08:42`, `Last updated … 08:42:41`, the scanned-order note `(Ron, 15:55)`.

## Global Constraints

- Edit only `kiosk_server/public/staff/` (`index.html`, `staff.css`, `staff.js`, new `time.js`), plus the new `kiosk_server/tools/layout_audit.js`, the new `kiosk_server/tests/staff_time.test.js`, and one line in `CLAUDE.md`. No server change.
- Keep every element id the page uses today (the scripts and the existing browser checks depend on them) and every behaviour (sign-in, polling, chime, Mark as paid / Cancel, the scanned-order note, every staff tool and its confirm dialog). The only visible text changes are the ones this plan lists.
- Keep the 60-30-10 palette exactly (tokens at the top of `staff.css`): no new colours, gradients, glows or shadows.
- Times: 12-hour, no leading zero, a space, then `AM`/`PM`: `1:31 PM`, `12:05 AM`. With a date: `Sep 28 · 10:36 AM`. Sidebar clock: `Sep 30, 2026 · 8:42 AM`. Last updated: `Sep 30, 2026 · 8:42:41 AM`. The payment countdown (`2:41 left to pay`) is a timer, not a clock: unchanged. Same style as the kiosk's own header clock (`2:24 PM`).
- The grid: 12 columns, 24 px gaps, 24 px card padding. Cards in one row share their top and bottom edge. In a stacked column the last card reaches the column's bottom. Card titles never wrap. Every section's cards line up with the top bar's left and right edges.
- Must pass the layout audit at 1440×900 and at the page's minimum 1180×800.

## The layout, section by section (1440 px; at 1180–1359 px `span-8` becomes 7 and `span-4` becomes 5)

| Section | Row 1 | Row 2 | Row 3 |
|---|---|---|---|
| Overview | 4 stat cards, `span-3` each | hero `span-8` · Quick Actions `span-4` | Recent Orders `span-8` · column `span-4`: banner, then Kiosk Status (grows) |
| Transactions | Orders `span-8` · Today's sales `span-4` | | |
| Kiosk Health | Needs attention `span-12` | Kiosk Status `span-6` · Air clear `span-6` | |
| Inventory | Stock per tank `span-12` | Prices `span-7` · column `span-5`: Waiting credits, then Recent price changes (grows) | |
| Settings | This machine `span-6` · Tanks `span-6` | | |

---

### Task 1: The layout audit

**Files:**
- Create: `kiosk_server/tools/layout_audit.js`
- Modify: `CLAUDE.md` (Commands section)

**Interfaces:**
- Produces: `node kiosk_server/tools/layout_audit.js [outDir]` → prints `PASS <section> @<width>` or `FAIL <section> @<width>  <rule>: <detail>` lines, saves `<section>-<width>.png` full-page screenshots in `outDir` (default `<tmp>/staff-layout-audit`), exits 0 when every rule passes, 1 otherwise. Env: `KIOSK_URL` (default `http://localhost:3000`), `STAFF_PIN` (default `1234`), `CHROME` (default `C:/Program Files/Google/Chrome/Application/chrome.exe`), `AUDIT_ORDER=1` to audit with a waiting order (creates one on slot 1 and cancels it at the end).
- Rule letters used by later tasks: A row edges, B column bottom, C title wraps, D header heights, E order row height, F status row heights, G stat cards, H quick action text, I top bar, J sidebar height, K AM/PM, L sideways scroll, N section edges, O text cut off (1440 only).

- [ ] **Step 1: Write the tool**

Create `kiosk_server/tools/layout_audit.js`:

```js
'use strict';
// Staff dashboard layout audit. Signs in to a running kiosk server in
// headless Chrome, opens every dashboard section at two window sizes, checks
// the alignment rules in audit() and saves a full-page screenshot of each.
//
//   node kiosk_server/tools/layout_audit.js [outDir]
//
// Env: KIOSK_URL (http://localhost:3000), STAFF_PIN (1234), CHROME (the
// Windows install path), AUDIT_ORDER=1 to audit with an order waiting.
// Exit code 0 when every rule passes, 1 otherwise. A developer tool: it needs
// Chrome and Node >= 22 (built-in WebSocket) and is never run on the Pi.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BASE = process.env.KIOSK_URL || 'http://localhost:3000';
const PIN = process.env.STAFF_PIN || '1234';
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'staff-layout-audit'));
const SIZES = [[1440, 900], [1180, 800]];
const SECTIONS = ['overview', 'transactions', 'health', 'inventory', 'settings'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Runs inside the page (sent as source text); returns [{ rule, detail }] for
// the section on screen. Every rule is a promise the layout makes.
function audit(wide) {
  const fails = [];
  const TOL = 1.5;
  const vis = (el) => !!el && el.getClientRects().length > 0;
  const box = (el) => el.getBoundingClientRect();
  const label = (el) => (el.id ? `#${el.id}` : `${el.tagName.toLowerCase()}.${String(el.className).trim().split(/\s+/).join('.')}`);
  const spread = (vals) => Math.max(...vals) - Math.min(...vals);
  const fail = (rule, detail) => fails.push({ rule, detail });
  const section = [...document.querySelectorAll('.d-main > section')].find(vis);
  if (!section) return [{ rule: 'section', detail: 'no section visible' }];

  // A. Everything in one row shares its top and bottom edge.
  for (const row of section.querySelectorAll('.d-row')) {
    const kids = [...row.children].filter(vis);
    if (kids.length < 2) continue;
    if (spread(kids.map((k) => box(k).top)) > TOL) fail('A row tops', kids.map((k) => `${label(k)}@${Math.round(box(k).top)}`).join(' '));
    if (spread(kids.map((k) => box(k).bottom)) > TOL) fail('A row bottoms', kids.map((k) => `${label(k)}@${Math.round(box(k).bottom)}`).join(' '));
  }
  // B. In a stacked column the last card reaches the column's bottom edge.
  for (const col of section.querySelectorAll('.d-col')) {
    const last = [...col.children].filter(vis).pop();
    if (last && Math.abs(box(last).bottom - box(col).bottom) > TOL) {
      fail('B column bottom', `${label(last)} ends ${Math.round(box(col).bottom - box(last).bottom)}px above its column`);
    }
  }
  // C. Card titles are one line.
  for (const h of section.querySelectorAll('.d-head h2')) if (vis(h) && box(h).height > 34) fail('C title wraps', h.textContent.trim());
  // D. Card headers side by side are the same height.
  for (const row of section.querySelectorAll('.d-row')) {
    const heads = [...row.children].filter(vis).map((k) => k.querySelector('.d-head')).filter(vis);
    if (heads.length > 1 && spread(heads.map((h) => box(h).height)) > TOL) {
      fail('D header heights', heads.map((h) => `${h.textContent.trim().slice(0, 18)}=${Math.round(box(h).height)}`).join(' | '));
    }
  }
  // E. Every order row is one 56px line.
  for (const tr of section.querySelectorAll('.d-table tbody tr:not(.is-none)')) {
    if (vis(tr) && Math.abs(box(tr).height - 56) > 2) fail('E order row height', `${tr.cells[0].textContent.trim()}=${Math.round(box(tr).height)}`);
  }
  // F. Status rows in one list are the same height.
  for (const ul of section.querySelectorAll('.d-status')) {
    const lis = [...ul.children].filter(vis);
    if (lis.length > 1 && spread(lis.map((li) => box(li).height)) > TOL) fail('F status row heights', lis.map((li) => Math.round(box(li).height)).join(','));
  }
  // G. Stat cards: equal heights, sparklines on one line, one line per text.
  const kpis = [...section.querySelectorAll('.kpi')].filter(vis);
  if (kpis.length) {
    if (spread(kpis.map((k) => box(k).height)) > TOL) fail('G stat card heights', kpis.map((k) => Math.round(box(k).height)).join(','));
    const sparks = kpis.map((k) => k.querySelector('.k-spark')).filter(vis);
    if (sparks.length > 1 && spread(sparks.map((s) => box(s).bottom)) > TOL) fail('G sparkline bottoms', sparks.map((s) => Math.round(box(s).bottom)).join(','));
    for (const d of section.querySelectorAll('.kpi small, .k-delta, .k-sub')) if (vis(d) && box(d).height > 20) fail('G stat text wraps', d.textContent.trim());
  }
  // H. Quick action titles and sub-lines are one line.
  for (const t of section.querySelectorAll('.q-tile b, .q-tile small')) if (vis(t) && box(t).height > 20) fail('H quick action text wraps', t.textContent.trim());
  // I. Top bar: the kiosk card and both pills share height and centre line.
  const top = ['.d-kiosk', '#s-me', '#s-out'].map((s) => document.querySelector(s)).filter(vis);
  if (spread(top.map((e) => box(e).height)) > TOL) fail('I top bar heights', top.map((e) => `${label(e)}=${Math.round(box(e).height)}`).join(' '));
  if (spread(top.map((e) => box(e).top + box(e).height / 2)) > TOL) fail('I top bar centres', top.map(label).join(' '));
  // J. The sidebar is one screen tall and stays put while the page scrolls.
  const side = document.querySelector('.d-side');
  if (vis(side) && box(side).height > innerHeight - 47) fail('J sidebar height', `${Math.round(box(side).height)} > ${innerHeight - 48}`);
  // K. Every clock time says AM or PM (the payment countdown is a timer).
  const text = document.querySelector('.d-app').innerText.replace(/\d+:\d{2} left to pay/g, '');
  const bare = text.match(/\b\d{1,2}:\d{2}(?::\d{2})?(?![:\d])(?!\s?[AP]M)/g);
  if (bare) fail('K time without AM/PM', [...new Set(bare)].slice(0, 6).join(', '));
  // L. No sideways scrolling at this width.
  if (document.documentElement.scrollWidth > innerWidth + 1) fail('L sideways scroll', `${document.documentElement.scrollWidth} > ${innerWidth}`);
  // N. The section's cards line up with the top bar's left and right edges.
  const cards = [...section.querySelectorAll('.d-card, .d-hero, .d-banner')].filter(vis);
  const bar = box(document.querySelector('.d-top'));
  const left = Math.min(...cards.map((c) => box(c).left));
  const right = Math.max(...cards.map((c) => box(c).right));
  if (Math.abs(left - bar.left) > TOL || Math.abs(right - bar.right) > TOL) {
    fail('N section edges', `cards ${Math.round(left)}–${Math.round(right)}, top bar ${Math.round(bar.left)}–${Math.round(bar.right)}`);
  }
  // O. At full width nothing in a table or status list is cut off.
  if (wide) {
    for (const el of section.querySelectorAll('.d-table td, .d-status small, .d-status b')) {
      if (vis(el) && el.scrollWidth > el.clientWidth + 1) fail('O text cut off', el.textContent.trim().slice(0, 40));
    }
  }
  return fails;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const port = 9350 + Math.floor(Math.random() * 40);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-chrome-'));
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--hide-scrollbars', 'about:blank']);
  let problems = 0;
  let order = null;
  try {
    await sleep(2500);
    const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r) => ws.addEventListener('open', r));
    let id = 0;
    const pending = new Map();
    const errors = [];
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
      if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    });
    const cdp = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
    const js = async (expr) => (await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result.result.value;
    await cdp('Page.enable');
    await cdp('Runtime.enable');
    await cdp('Network.enable');
    await cdp('Network.clearBrowserCookies');

    if (process.env.AUDIT_ORDER === '1') {
      const st = await (await fetch(`${BASE}/api/state`)).json();
      const r = await fetch(`${BASE}/api/order`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: [{ slot: 1, qty: 1 }], amount: st.prices[1] }),
      });
      const b = await r.json();
      if (r.status !== 200) throw new Error(`could not create a test order: ${b.error}`);
      order = b.order.number;
    }

    for (const [w, h] of SIZES) {
      await cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
      await cdp('Page.navigate', { url: `${BASE}/staff` });
      await sleep(2000);
      if (await js(`!document.getElementById('v-login').hidden`)) {
        for (const k of PIN) await js(`document.querySelector('#l-keypad [data-k="${k}"]').click()`);
        await js(`document.getElementById('l-go').click()`);
        await sleep(2500);
      }
      for (const v of SECTIONS) {
        await js(`document.querySelector('#s-nav [data-view="${v}"]').click()`);
        await sleep(v === 'overview' ? 1500 : 3500);   // the tools sections load /staff/api/tools
        const fails = await js(`(${audit.toString()})(${w >= 1440})`);
        const height = Math.max(h, await js('document.documentElement.scrollHeight'));
        const shot = await cdp('Page.captureScreenshot', {
          format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: w, height, scale: 1 },
        });
        fs.writeFileSync(path.join(OUT, `${v}-${w}.png`), Buffer.from(shot.result.data, 'base64'));
        if (!fails.length) console.log(`PASS ${v} @${w}`);
        for (const f of fails) console.log(`FAIL ${v} @${w}  ${f.rule}: ${f.detail}`);
        problems += fails.length;
      }
    }
    for (const e of errors) { console.log(`FAIL page script error: ${e}`); problems++; }
  } finally {
    if (order) {
      await fetch(`${BASE}/api/order/cancel`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ number: order }),
      }).catch(() => {});
    }
    chrome.kill();
  }
  console.log(`\n${problems ? `${problems} problem(s)` : 'every rule passes'} — screenshots in ${OUT}`);
  process.exit(problems ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
```

- [ ] **Step 2: Give it data and a server to look at (dev PC only)**

The audit needs today's and yesterday's records to fill the dashboard. On the dev PC only (never a kiosk — it writes pretend records), from the repo root, with `logs/` absent or disposable (it is git-ignored):

```bash
node -e "
const fs=require('fs'),path=require('path');const {stamp}=require('./kiosk_server/lib/records');
const day=(o)=>stamp(new Date(Date.now()-o*864e5)).slice(0,10);const ref=(d,n)=>d.replace(/-/g,'')+'-A-'+n;
const w=(f,rows)=>{fs.mkdirSync(path.dirname(f),{recursive:true});fs.appendFileSync(f,rows.map(r=>JSON.stringify(r)).join('\n')+'\n');};
const t=day(0),y=day(1);
w('logs/orders.jsonl',[{reference:ref(y,1),amount:10,status:'paid',by:'Ana',closed:y+' 10:01:00',method:'cash'},{reference:ref(y,2),amount:5,status:'expired',reason:'timeout',closed:y+' 15:03:00',method:'cash'},{reference:ref(t,1),amount:20,status:'paid',by:'Ron',closed:t+' 10:33:00',method:'cash'},{reference:ref(t,2),amount:10,status:'paid',by:'Ron',closed:t+' 10:36:00',method:'cash'},{reference:ref(t,3),amount:10,status:'cancelled',reason:'customer',closed:t+' 10:36:10',method:'cash'},{reference:ref(t,4),amount:10,status:'cancelled',reason:'out_of_stock',closed:t+' 10:36:40',method:'cash'},{reference:ref(t,5),amount:5,status:'paid',by:'Ron',closed:t+' 13:31:00',method:'cash'}]);
w('logs/payments.jsonl',[{reference:ref(y,1),method:'cash',amount:10,staff:'Ana',via:'tablet',date_created:y+' 10:01:00'},{reference:ref(t,1),method:'cash',amount:20,staff:'Ron',via:'tablet',date_created:t+' 10:33:00'},{reference:ref(t,2),method:'cash',amount:10,staff:'Ron',via:'tablet',date_created:t+' 10:36:00'},{reference:ref(t,5),method:'cash',amount:5,staff:'Ron',via:'kiosk_pin',date_created:t+' 13:31:00'}]);
w('logs/sales/sales-'+t.slice(0,7)+'.jsonl',[1,1,3,3,2,2].map((s,i)=>({machine_id:'1',slot:String(s),amount:5,date_created:t+' 10:4'+i+':00'})));
w('logs/interrupted_sales.jsonl',[{machine_id:'1',slot:'4',amount:5,reason:'tank_empty',date_created:t+' 11:12:00'}]);
w('logs/unclaimed_credits.jsonl',[{machine_id:'1',slot:'2',qty:1,amount:5,reason:'timeout',date_created:t+' 12:05:00'}]);
w('logs/price_changes.jsonl',[{machine_id:'1',slot:'1',from:5,to:6,date_created:y+' 09:00:00'},{machine_id:'1',slot:'1',from:6,to:5,date_created:y+' 21:05:00'}]);
w('logs/prime_events.jsonl',[{machine_id:'1',slot:'4',seconds:3,date_created:t+' 11:20:00'}]);"
```

Start the controller (mock GPIO) and the kiosk server as `CLAUDE.md` "Trying the whole kiosk on a PC" describes, with `CONFIG/config.env` holding a staff member whose PIN is 1234.

- [ ] **Step 3: Run it to see today's problems (RED)**

Run: `node kiosk_server/tools/layout_audit.js`
Expected: exit code 1, with FAIL lines for at least rules C ("Today's sales"), E (the cancelled rows), G, H ("Inventory & Prices"), I, J and K. Keep the output: it is the "before" of this plan.

- [ ] **Step 4: Document the command**

In `CLAUDE.md`, in the Commands section, after the `hash_pin.js` block, add:

````
```bash
# Staff dashboard layout audit (dev PC: a running kiosk server, Chrome, Node 22+)
node kiosk_server/tools/layout_audit.js
```
````

- [ ] **Step 5: Commit**

```bash
git add kiosk_server/tools/layout_audit.js CLAUDE.md
git commit -m "tools: staff dashboard layout audit"
```

---

### Task 2: 12-hour times with AM/PM

**Files:**
- Create: `kiosk_server/public/staff/time.js`
- Create: `kiosk_server/tests/staff_time.test.js`
- Modify: `kiosk_server/public/staff/index.html` (script tag)
- Modify: `kiosk_server/public/staff/staff.js` (the time sites)

**Interfaces:**
- Produces: `window.StaffTime` in the page (and `module.exports` for tests): `clock12(h, m, s?) → '1:31 PM' | '1:31:07 PM'`; `timeOf('YYYY-MM-DD HH:MM:SS') → '1:31 PM'` (`''` for anything else); `dateTimeOf('YYYY-MM-DD HH:MM:SS') → 'Sep 28 · 10:36 AM'` (`''` for anything else).

- [ ] **Step 1: Write the failing test**

Create `kiosk_server/tests/staff_time.test.js`:

```js
'use strict';
// The staff dashboard's clock format: 12-hour with AM/PM, like the kiosk.
const test = require('node:test');
const assert = require('node:assert');
const { clock12, timeOf, dateTimeOf } = require('../public/staff/time');

test('clock12: 12-hour, no leading zero, AM/PM, midnight and noon', () => {
  assert.strictEqual(clock12(0, 5), '12:05 AM');
  assert.strictEqual(clock12(9, 5), '9:05 AM');
  assert.strictEqual(clock12(11, 59), '11:59 AM');
  assert.strictEqual(clock12(12, 0), '12:00 PM');
  assert.strictEqual(clock12(13, 31), '1:31 PM');
  assert.strictEqual(clock12(23, 59, 7), '11:59:07 PM');
});

test('timeOf and dateTimeOf read the logs\' date format', () => {
  assert.strictEqual(timeOf('2026-09-30 13:31:00'), '1:31 PM');
  assert.strictEqual(timeOf('2026-09-30 00:15:09'), '12:15 AM');
  assert.strictEqual(dateTimeOf('2026-09-28 10:36:00'), 'Sep 28 · 10:36 AM');
  assert.strictEqual(dateTimeOf('2026-01-05 21:05:00'), 'Jan 5 · 9:05 PM');
  for (const bad of ['', null, undefined, 'soon', '2026-09-30']) {
    assert.strictEqual(timeOf(bad), '');
    assert.strictEqual(dateTimeOf(bad), '');
  }
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd kiosk_server && node --test tests/staff_time.test.js`
Expected: FAIL — `Cannot find module '../public/staff/time'`.

- [ ] **Step 3: Write `time.js`**

Create `kiosk_server/public/staff/time.js`:

```js
'use strict';
// Clock times on the staff dashboard: 12-hour with AM/PM, like the kiosk's
// own header clock ("2:24 PM"). Loaded by the page before staff.js, and
// required by the tests.

(function (root) {
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const pad = (n) => String(n).padStart(2, '0');

  // clock12(13, 31) -> '1:31 PM'; with seconds, '1:31:07 PM'.
  function clock12(h, m, s) {
    const t = `${h % 12 || 12}:${pad(m)}${s === undefined ? '' : `:${pad(s)}`}`;
    return `${t} ${h < 12 ? 'AM' : 'PM'}`;
  }

  // The logs' 'YYYY-MM-DD HH:MM:SS' as numbers, or null.
  function parts(str) {
    const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/.exec(String(str || ''));
    return m ? m.slice(1).map(Number) : null;
  }

  // '2026-09-30 13:31:00' -> '1:31 PM'
  function timeOf(str) {
    const p = parts(str);
    return p ? clock12(p[3], p[4]) : '';
  }

  // '2026-09-28 10:36:00' -> 'Sep 28 · 10:36 AM'
  function dateTimeOf(str) {
    const p = parts(str);
    return p ? `${MONTHS[p[1] - 1]} ${p[2]} · ${clock12(p[3], p[4])}` : '';
  }

  const api = { clock12, timeOf, dateTimeOf };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.StaffTime = api;
})(this);
```

- [ ] **Step 4: Run it to see it pass**

Run: `cd kiosk_server && node --test tests/staff_time.test.js` → 2 tests PASS.

- [ ] **Step 5: Load it in the page**

In `kiosk_server/public/staff/index.html`, replace

```html
  <script src="/staff/staff.js"></script>
```

with

```html
  <script src="/staff/time.js"></script>
  <script src="/staff/staff.js"></script>
```

- [ ] **Step 6: Use it everywhere a clock time is shown**

In `kiosk_server/public/staff/staff.js`:

1. In `lookup()`, replace `const when = (o.closed || '').slice(11, 16);` with `const when = StaffTime.timeOf(o.closed);`
2. Replace `const hm = (d) => \`${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}\`;` with `const hm = (d) => StaffTime.clock12(d.getHours(), d.getMinutes());`
3. In `renderHero()`, replace
   `$('h-updated').textContent = \`Last updated: ${dateOf(d)} ${hm(d)}:${String(d.getSeconds()).padStart(2, '0')}\`;`
   with
   `$('h-updated').textContent = \`Last updated: ${dateOf(d)} · ${StaffTime.clock12(d.getHours(), d.getMinutes(), d.getSeconds())}\`;`
4. In `statusRows()`, replace `.slice(11, 16)` in the `synced` line so it reads
   `const synced = s.lastSynced ? \`Last confirmed ${esc(StaffTime.timeOf(s.lastSynced))}\` : 'None this month';`
5. In `orderRows()`, replace
   `const time = withDate && c ? \`${MONTHS[Number(c.slice(5, 7)) - 1]} ${Number(c.slice(8, 10))} · ${c.slice(11, 16)}\` : c.slice(11, 16);`
   with
   `const time = withDate ? StaffTime.dateTimeOf(c) : StaffTime.timeOf(c);`
6. Replace the two tools helpers
   ```js
     const hhmm = (d) => String(d || '').slice(11, 16);
     const when = (d) => String(d || '').slice(5, 16);
   ```
   with
   ```js
     const hhmm = (d) => StaffTime.timeOf(d);
     const when = (d) => StaffTime.dateTimeOf(d);
   ```
7. The sidebar clock line (`$('s-clock').textContent = \`${dateOf(d)} · ${hm(d)}\`;`) needs no edit: `hm` now returns 12-hour time.

If `MONTHS` in `staff.js` is now used only by `dateOf`, leave it.

- [ ] **Step 7: Check**

Run: `cd kiosk_server && node --check public/staff/staff.js && node --check public/staff/time.js && npm test` → all pass (111 + 2).
Run: `node kiosk_server/tools/layout_audit.js` → no `K time without AM/PM` lines left (other rules still fail until Tasks 3–4).

- [ ] **Step 8: Commit**

```bash
git add kiosk_server/public/staff/time.js kiosk_server/tests/staff_time.test.js kiosk_server/public/staff/index.html kiosk_server/public/staff/staff.js
git commit -m "feat(staff): every clock time in 12-hour with AM/PM"
```

---

### Task 3: One grid — shell, rows and sections

**Files:**
- Modify: `kiosk_server/public/staff/index.html` (the five sections)
- Modify: `kiosk_server/public/staff/staff.css` (layout rules)
- Modify: `kiosk_server/public/staff/staff.js` (Today's sales total, Tanks card, empty price history)

**Interfaces:**
- Consumes: `StaffTime` (Task 2), the audit (Task 1).
- Produces: CSS classes `d-row`, `d-col`, `d-grow`, `span-3|4|5|6|7|8|12`, `s-grid-3`, `s-total`; new element ids `x-sales-total` and `x-tanks`.

- [ ] **Step 1: Replace the five sections in `index.html`**

Replace everything from `<!-- Overview -->` down to the closing `</section>` of `v-settings` (just before `</main>`) with the block below. Inner markup of the hero, stat cards, tables, lists and tiles is unchanged except where noted: the stat cards, Quick Actions, banner and Kiosk Status move; the stat-card icon circles drop their colour classes; the Health status list loses `is-big`; price history moves into its own card; Settings gains a Tanks card; Today's sales gains a total line; the "Inventory & Prices" tile becomes "Inventory"; the Staff column header becomes "By" (Task 4 fills it).

```html
      <!-- Overview: stats / hero + quick actions / orders + attention + status -->
      <section id="v-overview" hidden>
        <div class="d-row d-kpis">
          <div class="d-card kpi span-3" id="k-sales">
            <span class="k-circ">₱</span>
            <div><small>Total Sales Today</small><b class="k-val"></b><p class="k-delta"></p><p class="k-sub"></p></div>
            <svg class="k-spark" viewBox="0 0 200 48" preserveAspectRatio="none"></svg>
          </div>
          <div class="d-card kpi span-3" id="k-paid">
            <span class="k-circ"><svg class="i"><use href="#i-check"/></svg></span>
            <div><small>Paid Orders</small><b class="k-val"></b><p class="k-delta"></p><p class="k-sub"></p></div>
            <svg class="k-spark" viewBox="0 0 200 48" preserveAspectRatio="none"></svg>
          </div>
          <div class="d-card kpi span-3" id="k-pending">
            <span class="k-circ"><svg class="i"><use href="#i-clock"/></svg></span>
            <div><small>Pending Orders</small><b class="k-val"></b><p class="k-delta"></p><p class="k-sub"></p></div>
            <svg class="k-spark" viewBox="0 0 200 48" preserveAspectRatio="none"></svg>
          </div>
          <div class="d-card kpi span-3" id="k-cancel">
            <span class="k-circ"><svg class="i"><use href="#i-x"/></svg></span>
            <div><small>Cancelled</small><b class="k-val"></b><p class="k-delta"></p><p class="k-sub"></p></div>
            <svg class="k-spark" viewBox="0 0 200 48" preserveAspectRatio="none"></svg>
          </div>
        </div>

        <div class="d-row">
          <div class="d-hero span-8" id="w-card">
            <div id="w-empty" class="h-idle">
              <p class="h-kicker" id="h-kicker">TODAY'S PERFORMANCE</p>
              <h1 id="h-title">Kiosk is Running Smoothly</h1>
              <p class="h-text" id="h-text"></p>
              <p class="h-updated"><i></i><span id="h-updated"></span></p>
              <div class="h-art" aria-hidden="true">
                <img src="/img/products/1.webp" alt=""><img src="/img/products/3.webp" alt=""><img src="/img/products/5.webp" alt="">
                <img src="/img/products/2.webp" alt=""><img src="/img/products/4.webp" alt=""><img src="/img/products/6.webp" alt="">
              </div>
            </div>
            <div id="w-body" class="h-wait" hidden>
              <div class="w-left">
                <p class="h-kicker"><span id="w-title">Waiting for payment</span></p>
                <h1 id="w-num"></h1>
                <ul class="w-items" id="w-items"></ul>
              </div>
              <div class="w-right">
                <div class="w-total"><span>Total</span><b id="w-total"></b></div>
                <div class="w-timer" id="w-timer"></div>
                <div class="w-bar"><i id="w-bar"></i></div>
                <button class="s-btn s-primary s-big" id="w-paid" type="button">Mark as paid</button>
                <button class="s-btn s-danger-ghost" id="w-cancel" type="button">Cancel order</button>
              </div>
            </div>
            <p class="s-msg" id="w-msg" role="alert"></p>
          </div>

          <div class="d-card span-4">
            <div class="d-head"><h2><svg class="i i-fill"><use href="#i-bolt"/></svg>Quick Actions</h2></div>
            <div class="d-quick">
              <button type="button" class="q-tile" data-go="transactions">
                <svg class="i"><use href="#i-receipt"/></svg><b>Transactions</b><small>Orders and sales</small>
                <span class="q-chev"><svg class="i"><use href="#i-chev"/></svg></span>
              </button>
              <button type="button" class="q-tile" data-go="inventory">
                <svg class="i"><use href="#i-tag"/></svg><b>Inventory</b><small>Stock and prices</small>
                <span class="q-chev"><svg class="i"><use href="#i-chev"/></svg></span>
              </button>
              <button type="button" class="q-tile" data-go="health" data-scroll="c-prime">
                <svg class="i"><use href="#i-wind"/></svg><b>Air Clear</b><small>After a refill</small>
                <span class="q-chev"><svg class="i"><use href="#i-chev"/></svg></span>
              </button>
              <button type="button" class="q-tile" data-go="inventory" data-scroll="c-credits">
                <svg class="i"><use href="#i-coins"/></svg><b>Waiting Credits</b><small>Paid, not poured</small>
                <span class="q-badge" id="q-credits" hidden></span>
                <span class="q-chev"><svg class="i"><use href="#i-chev"/></svg></span>
              </button>
            </div>
          </div>
        </div>

        <div class="d-row">
          <div class="d-card span-8">
            <div class="d-head">
              <h2><svg class="i"><use href="#i-list"/></svg>Recent Orders</h2>
              <div class="d-switch" data-for="overview">
                <button type="button" data-range="today" class="on"><svg class="i"><use href="#i-cal"/></svg>Today</button>
                <button type="button" data-range="7d">7 Days</button>
              </div>
            </div>
            <div class="d-table">
              <table>
                <thead><tr><th>Order</th><th>Amount</th><th>Status</th><th>By</th><th>Time</th></tr></thead>
                <tbody id="t-list"></tbody>
              </table>
            </div>
            <div class="d-foot">
              <span><i></i><span id="t-sum"></span></span>
              <button type="button" class="d-link" data-go="transactions">View all transactions<svg class="i"><use href="#i-arrow"/></svg></button>
            </div>
          </div>

          <div class="d-col span-4">
            <button type="button" class="d-banner" id="d-banner">
              <span class="b-ico"><svg class="i"><use href="#i-spark"/></svg></span>
              <span class="b-text"><b id="b-title">Smarter Kiosk. Better Service.</b><small id="b-sub">Real-time monitoring for a seamless experience.</small></span>
              <span class="q-chev"><svg class="i"><use href="#i-chev"/></svg></span>
            </button>
            <div class="d-card d-grow">
              <div class="d-head"><h2><svg class="i i-fill"><use href="#i-shield"/></svg>Kiosk Status</h2></div>
              <ul class="d-status" id="st-list"></ul>
            </div>
          </div>
        </div>
      </section>

      <!-- Transactions -->
      <section id="v-transactions" hidden>
        <div class="d-row">
          <div class="d-card span-8">
            <div class="d-head">
              <h2><svg class="i"><use href="#i-list"/></svg>Orders</h2>
              <div class="d-switch" data-for="transactions">
                <button type="button" data-range="today" class="on"><svg class="i"><use href="#i-cal"/></svg>Today</button>
                <button type="button" data-range="7d">7 Days</button>
              </div>
            </div>
            <div class="d-table">
              <table>
                <thead><tr><th>Order</th><th>Amount</th><th>Status</th><th>By</th><th>Time</th></tr></thead>
                <tbody id="o-list"></tbody>
              </table>
            </div>
            <div class="d-foot"><span><i></i><span id="o-sum"></span></span></div>
          </div>
          <div class="d-card span-4">
            <div class="d-head"><h2><svg class="i"><use href="#i-coins"/></svg>Today's sales</h2></div>
            <div class="s-total"><b id="x-sales-total">₱0</b><span class="s-sum" id="x-sales-sum"></span></div>
            <ul class="s-list" id="x-sales"></ul>
            <ul class="s-list s-cash" id="x-cash"></ul>
          </div>
        </div>
      </section>

      <!-- Kiosk Health -->
      <section id="v-health" hidden>
        <div class="d-row">
          <div class="d-card span-12">
            <div class="d-head"><h2><svg class="i"><use href="#i-alert"/></svg>Needs attention</h2></div>
            <p class="s-hint">Pours cut short today. The customer was charged in full — settle it with them.</p>
            <ul class="s-list" id="x-attention"></ul>
          </div>
        </div>
        <div class="d-row">
          <div class="d-card span-6">
            <div class="d-head"><h2><svg class="i i-fill"><use href="#i-shield"/></svg>Kiosk Status</h2></div>
            <ul class="d-status" id="hx-status"></ul>
          </div>
          <div class="d-card span-6" id="c-prime">
            <div class="d-head"><h2><svg class="i"><use href="#i-wind"/></svg>Air clear</h2><span class="s-sum" id="x-prime-sec"></span></div>
            <p class="s-hint">After a gallon change, push the air out of the hose so the next customer is not charged for air.</p>
            <div class="s-grid s-grid-3" id="x-primes"></div>
          </div>
        </div>
      </section>

      <!-- Inventory -->
      <section id="v-inventory" hidden>
        <div class="d-row">
          <div class="d-card span-12">
            <div class="d-head"><h2><svg class="i"><use href="#i-box"/></svg>Stock per tank</h2></div>
            <div class="d-stock" id="x-stock"></div>
          </div>
        </div>
        <div class="d-row">
          <div class="d-card span-7">
            <div class="d-head"><h2><svg class="i"><use href="#i-tag"/></svg>Prices</h2><span class="s-sum">per press</span></div>
            <ul class="s-rows" id="x-prices"></ul>
          </div>
          <div class="d-col span-5">
            <div class="d-card" id="c-credits">
              <div class="d-head"><h2><svg class="i"><use href="#i-coins"/></svg>Waiting credits</h2><span class="s-sum" id="x-credit-sum"></span></div>
              <p class="s-hint">Paid for but never poured, last 7 days.</p>
              <ul class="s-rows" id="x-credits"></ul>
            </div>
            <div class="d-card d-grow">
              <div class="d-head"><h2><svg class="i"><use href="#i-clock"/></svg>Recent price changes</h2></div>
              <ul class="s-list s-hist" id="x-price-log"></ul>
            </div>
          </div>
        </div>
      </section>

      <!-- Settings -->
      <section id="v-settings" hidden>
        <div class="d-row">
          <div class="d-card span-6">
            <div class="d-head"><h2><svg class="i"><use href="#i-gear"/></svg>This machine</h2></div>
            <dl class="s-dl" id="x-machine"></dl>
          </div>
          <div class="d-card span-6">
            <div class="d-head"><h2><svg class="i"><use href="#i-drop"/></svg>Tanks</h2></div>
            <dl class="s-dl" id="x-tanks"></dl>
          </div>
        </div>
      </section>
```

- [ ] **Step 2: `staff.js` — Today's sales total, Tanks, empty price history**

In `renderTools()`:

1. Replace `$('x-sales-sum').textContent = \`${s.presses} presses · ${peso(s.amount)}\`;` with:

```js
    $('x-sales-total').textContent = peso(s.amount);
    $('x-sales-sum').textContent = `${s.presses} ${s.presses === 1 ? 'press' : 'presses'} today`;
```

2. Replace the whole `put('x-machine', …);` statement (it ends with `}).join('')}\`);`) with:

```js
    put('x-machine', `<dt>Machine ID</dt><dd>${esc(m.machineId || '—')}</dd>
      <dt>Controller</dt><dd class="${m.online ? 'ok' : 'bad'}">${m.online ? 'Online' : 'Offline'}</dd>
      <dt>Staff page</dt><dd>${esc(m.staffBase ? `${m.staffBase}/staff` : 'No network address')}</dd>
      <dt>QR demo</dt><dd class="${m.qrDemo ? 'warn' : ''}">${m.qrDemo ? 'On — QR payments are pretend' : 'Off'}</dd>`);
    put('x-tanks', t.products.map((p) => {
      const st = stockOf(p.slot);
      return `<dt>${esc(p.name)}</dt><dd class="${!st ? '' : st.empty ? 'bad' : 'ok'}">${!st ? '—' : st.empty ? 'Empty' : 'Has stock'}</dd>`;
    }).join(''));
```

3. In the `put('x-price-log', …)` statement, change the closing `</li>\`).join(''));` to `</li>\`).join('') || '<li class="s-none">No price changes yet.</li>');`

- [ ] **Step 3: `staff.css` — the grid, the shell, the card anatomy**

1. Delete these rules (they belong to the old layout): `.d-grid { … }`, `.d-grid.d-half { … }`, the old `.d-col { … }`, `.d-right .d-card { … }`, `.d-kpis { … }`, `.d-narrow { … }`, the four `.d-status.is-big …` rules, and inside the `@media (max-width: 1359px)` block the lines `.d-kpis { grid-template-columns: 1fr 1fr; }` and `.d-status b { white-space: normal; }`.

2. In `:root`, after `--r: 16px;` add `--gap: 24px; --pad: 24px;`.

3. Replace the `/* ---- cards ---- */` block (`.d-card`, `.d-head`, `.d-head h2`, `.d-head h2 .i`) with:

```css
/* ---- cards: header, body, footer; titles never wrap ---- */
.d-card { display: flex; flex-direction: column; min-width: 0; background: var(--surface); border: 1px solid var(--line); border-radius: var(--r); padding: var(--pad); }
.d-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 54px; margin-bottom: 16px; }
.d-head h2 { display: flex; align-items: center; gap: 12px; min-width: 0; font-size: 20px; line-height: 1.2; white-space: nowrap; }
.d-head h2 .i { width: 26px; height: 26px; color: var(--ink-2); }
.d-head .s-sum { white-space: nowrap; }

/* ---- the grid: 12 columns; a row's cards share their height; a stacked
   column's last card (.d-grow) takes up the slack so both columns end on
   one line ---- */
.d-row { display: grid; grid-template-columns: repeat(12, minmax(0, 1fr)); gap: var(--gap); align-items: stretch; }
.span-3 { grid-column: span 3; } .span-4 { grid-column: span 4; } .span-5 { grid-column: span 5; }
.span-6 { grid-column: span 6; } .span-7 { grid-column: span 7; } .span-8 { grid-column: span 8; }
.span-12 { grid-column: span 12; }
.d-col { display: flex; flex-direction: column; gap: var(--gap); min-width: 0; }
.d-col > .d-grow { flex: 1 1 auto; }
```

4. Replace the app-shell rules `.d-side { … }` and `.d-side-in { … }` with (the sidebar is one screen tall and stays put; its status card sits at its foot):

```css
.d-side { position: sticky; top: 24px; align-self: start; height: calc(100vh - 48px); min-height: 560px; border-radius: var(--r); border: 1px solid var(--line); background: var(--surface); }
.d-side-in { height: 100%; display: flex; flex-direction: column; padding: 22px 14px 14px; }
```

5. Replace the top-bar rules `.d-top`, `.d-kiosk`, `.k-ico`, `.k-ico .i`, `.d-pill` with (one 72 px row; the kiosk card and both pills share its height):

```css
.d-top { display: flex; align-items: stretch; justify-content: space-between; gap: var(--gap); height: 72px; }
.d-kiosk { display: flex; align-items: center; gap: 14px; padding: 0 24px 0 12px; border-radius: var(--r); border: 1px solid var(--line); background: var(--surface); min-width: 360px; }
.k-ico { width: 48px; height: 48px; border-radius: 12px; display: grid; place-items: center; color: var(--ink-2); background: var(--surface-sub); border: 1px solid var(--line); }
.k-ico .i { width: 26px; height: 26px; }
.d-pill { display: inline-flex; align-items: center; gap: 12px; height: 100%; padding: 0 22px 0 14px; border-radius: var(--r); border: 1px solid var(--line); background: var(--surface); font-size: 15px; }
```

6. Replace `.d-hero { … }` with (a hero stretched by its row keeps its content centred):

```css
.d-hero { position: relative; overflow: hidden; display: flex; flex-direction: column; justify-content: center; min-height: 220px; padding: 28px; border-radius: var(--r); border: 1px solid var(--line); background: var(--surface); }
```

7. Replace `.d-foot { … }` with (the footer sits at the card's foot even when the row makes the card taller):

```css
.d-foot { display: flex; align-items: center; justify-content: space-between; margin-top: auto; padding-top: 16px; font-size: 14px; color: var(--ink-2); }
```

8. Replace `.s-cash { … }` (keep `.s-cash:empty`) with, and add the two new rules:

```css
.s-cash { margin-top: auto; padding-top: 10px; border-top: 1px solid var(--line); }
.s-total { display: flex; align-items: baseline; gap: 12px; margin-bottom: 12px; }
.s-total b { font-size: 30px; line-height: 36px; font-variant-numeric: tabular-nums; }
.s-grid.s-grid-3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
```

9. At the end of the `@media (max-width: 1359px)` block add (below 1360 px the wide/narrow pairs become 7/5):

```css
  .d-row > .span-8 { grid-column: span 7; }
  .d-row > .span-4 { grid-column: span 5; }
```

- [ ] **Step 4: Check**

Run: `cd kiosk_server && node --check public/staff/staff.js && npm test` → all pass.
Run: `node kiosk_server/tools/layout_audit.js` → no FAIL lines for rules A, B, C, D, I, J, L, N at either width. Rules E, F, G, H may still fail (Task 4). Open the screenshots and compare with the table at the top of this plan.

- [ ] **Step 5: Commit**

```bash
git add kiosk_server/public/staff
git commit -m "style(staff): one 12-column grid — rows share heights, columns end on one line"
```

---

### Task 4: Components that line up inside the grid

**Files:**
- Modify: `kiosk_server/public/staff/staff.css`
- Modify: `kiosk_server/public/staff/staff.js` (`orderRows`, `statusRows`, `renderStatus`)

**Interfaces:**
- Consumes: the grid classes (Task 3), `StaffTime` (Task 2), the audit (Task 1).

- [ ] **Step 1: Stat cards — one structure for all four**

Replace every stat-card rule (from `.kpi {` through `#k-sales .k-spark polyline { … }`, keeping the three `.k-delta .up/.down/.flat` rules and `.k-delta .nw`) with:

```css
/* stat cards: icon beside the label, the value, one line for the change and
   one for the note, the sparkline along the bottom edge of every card */
.kpi { display: grid; grid-template-columns: 44px minmax(0, 1fr); grid-template-rows: 1fr auto; column-gap: 14px; row-gap: 14px; padding: 20px 20px 16px; }
.kpi > div { min-width: 0; }
.kpi small { display: block; font-size: 13px; line-height: 18px; color: var(--ink-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.k-val { display: block; margin-top: 2px; font-size: 30px; line-height: 36px; font-variant-numeric: tabular-nums; }
.k-delta, .k-sub { margin-top: 6px; font-size: 13px; line-height: 18px; color: var(--ink-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.k-delta + .k-sub { margin-top: 2px; }
.k-circ { width: 44px; height: 44px; border-radius: 50%; display: grid; place-items: center; color: var(--ink-2); background: var(--surface-sub); border: 1px solid var(--line); font-size: 20px; font-weight: 700; }
.k-circ .i { width: 22px; height: 22px; stroke-width: 2.2; }
.k-spark { grid-column: 1 / -1; width: 100%; height: 40px; display: block; }
.k-spark polyline { fill: none; stroke: var(--line-2); stroke-width: 1.5; vector-effect: non-scaling-stroke; stroke-linejoin: round; }
.k-spark polygon { fill: none; }
#k-sales .k-spark polyline { stroke: var(--brand); opacity: .6; }
```

- [ ] **Step 2: Orders table — fixed columns, one line per row, "By" says who or why**

In `staff.css`, replace `.d-table table { … }`, `.d-table td { … }` and `.d-reason { … }` with:

```css
.d-table table { width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 15px; }
.d-table th:nth-child(1), .d-table td:nth-child(1) { width: 12%; }
.d-table th:nth-child(2), .d-table td:nth-child(2) { width: 14%; text-align: right; padding-right: 28px; }
.d-table th:nth-child(3), .d-table td:nth-child(3) { width: 24%; }
.d-table th:nth-child(4), .d-table td:nth-child(4) { width: 20%; }
.d-table th:nth-child(5), .d-table td:nth-child(5) { width: 30%; text-align: right; }
.d-table td { height: 56px; padding: 0 16px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; border-top: 1px solid var(--line); font-variant-numeric: tabular-nums; }
.d-table td:nth-child(5) { font-size: 14px; }
.d-reason { color: var(--ink-2); }
```

In `staff.js` `orderRows()`, replace the body of the `rows.map((x) => { … })` callback with (the badge alone in Status; the By column names the person, or says why when the kiosk closed the order itself):

```js
      const [label, ic] = BADGE[x.status] || [x.status, 'clock'];
      const c = String(x.closed || '');
      const time = withDate ? StaffTime.dateTimeOf(c) : StaffTime.timeOf(c);
      // Who closed it, or why the kiosk did. A QR order cancelled by the
      // customer says "customer", not "QR demo".
      const system = SYSTEM_REASON[x.reason];
      const by = x.reason === 'customer' ? 'customer'
        : x.by || system || (x.method === 'qr' ? 'QR demo' : '—');
      const why = x.reason ? ` title="${esc(x.status)}: ${esc(x.reason)}"` : '';
      return `<tr class="is-${esc(x.status)}">
        <td>${esc(x.number)}</td><td>${peso(x.amount)}</td>
        <td><span class="d-badge b-${esc(x.status)}"${why}><i>${icon(ic)}</i>${esc(label)}</span></td>
        <td${!x.by && system ? ' class="d-reason"' : ''}>${esc(by)}</td><td>${esc(time)}</td>
      </tr>`;
```

and replace the `REASON_WORDS` constant (and its comment) with:

```js
  // Orders the kiosk closed by itself, in words, for the By column.
  const SYSTEM_REASON = { out_of_stock: 'product ran out', price_changed: 'price changed', timeout: 'not paid in time' };
```

- [ ] **Step 3: Kiosk Status rows — one height, fixed columns, one sub-line**

In `staff.css`, replace the rules `.d-status li { … }`, `.d-status li:first-child { … }`, `.d-status li:last-child { … }`, `.s-ico { … }`, `.s-ico .i { … }`, `.d-status b { … }`, `.d-status small { … }` and `.s-word { … }` with:

```css
.d-status li { display: grid; grid-template-columns: 44px minmax(0, 1fr) 80px; gap: 14px; align-items: center; height: 64px; border-top: 1px solid var(--line); }
.d-status li:first-child { border-top: 0; }
.s-ico { width: 44px; height: 44px; border-radius: 50%; display: grid; place-items: center; color: var(--ink-2); background: var(--surface-sub); border: 1px solid var(--line); }
.s-ico .i { width: 22px; height: 22px; }
.d-status b, .d-status small { display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.d-status b { font-size: 15px; }
.d-status small { margin-top: 2px; font-size: 13px; line-height: 18px; color: var(--ink-2); }
.s-word { justify-self: start; display: inline-flex; align-items: center; gap: 8px; font-size: 14px; font-weight: 700; }
```

In `staff.js` `statusRows()`, replace the `synced` and `queued` lines and the `sync` row so Last Sync has one sub-line:

```js
    const queued = s.uploadQueue ? `${s.uploadQueue} waiting` : 'All uploaded';
    const syncLine = s.lastSynced ? `${queued} · ${esc(StaffTime.timeOf(s.lastSynced))}` : queued;
```

```js
      ['sync', 'sync', 'Last Sync', syncLine, s.uploadQueue ? ['warn', 'Waiting'] : ['ok', 'OK']],
```

In `renderStatus()`, give the sub-line its full text as a tooltip (it can be cut off at the narrowest width): change `<small>${sub}</small>` to `<small title="${sub}">${sub}</small>` (every `sub` is already escaped or fixed text).

- [ ] **Step 4: Quick Actions — a list of equal rows**

Replace the Quick Actions rules (`.d-quick { … }` through `.q-badge { … }`) with (icon, title and note, count, chevron — one row each, all the same height):

```css
.d-quick { display: grid; gap: 10px; }
.q-tile { display: grid; grid-template-columns: 24px minmax(0, 1fr) auto 28px; grid-template-areas: "ico title badge chev" "ico sub badge chev"; column-gap: 14px; align-items: center; height: 64px; padding: 0 14px; border-radius: 12px; text-align: left; background: var(--surface-sub); border: 1px solid var(--line); }
.q-tile:hover { border-color: var(--line-2); }
.q-tile > .i { grid-area: ico; width: 24px; height: 24px; color: var(--ink-2); }
.q-tile b { grid-area: title; align-self: end; font-size: 15px; line-height: 20px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.q-tile small { grid-area: sub; align-self: start; font-size: 12px; line-height: 16px; color: var(--ink-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.q-badge { grid-area: badge; min-width: 26px; height: 26px; padding: 0 8px; border-radius: 999px; display: grid; place-items: center; font-size: 13px; font-weight: 700; background: var(--brand); color: #fff; }
.q-chev { grid-area: chev; width: 28px; height: 28px; border-radius: 50%; display: grid; place-items: center; color: var(--ink-2); border: 1px solid var(--line-2); }
.q-chev .i { width: 16px; height: 16px; stroke-width: 2.4; }
```

and the banner's chevron (it used the old absolute tile chevron) becomes part of the banner's flex row: replace `.d-banner .q-chev { … }` with `.d-banner .q-chev { margin-left: auto; }` and in `.d-banner { … }` change `padding: 16px 56px 16px 16px;` to `padding: 16px;`.

- [ ] **Step 5: Lists — aligned columns**

Replace `.s-list li { … }` and `.s-list li span:last-child { … }` with, and add the price-history columns:

```css
.s-list li { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 12px; min-height: 48px; padding: 0 2px; border-top: 1px solid var(--line); font-size: 15px; }
.s-list li > span:last-child { text-align: right; color: var(--ink-2); font-variant-numeric: tabular-nums; }
.s-list li.s-none { display: block; padding-top: 14px; }
.s-hist li { grid-template-columns: minmax(0, 1fr) auto 140px; }
```

- [ ] **Step 6: Check**

Run: `cd kiosk_server && node --check public/staff/staff.js && npm test` → all pass.
Run: `node kiosk_server/tools/layout_audit.js` → `every rule passes`, exit code 0.
Run: `AUDIT_ORDER=1 node kiosk_server/tools/layout_audit.js "<tmp>/audit-waiting"` (Git Bash) → `every rule passes` with an order waiting; open `overview-1440.png` and `overview-1180.png` there and check the waiting hero still shows the items, total, countdown and both buttons.

- [ ] **Step 7: Commit**

```bash
git add kiosk_server/public/staff
git commit -m "style(staff): fixed rows and columns — stat cards, orders, status, quick actions, lists"
```

---

## Final verification

1. `cd kiosk_server && npm test` — everything passes (111 + 2).
2. `node kiosk_server/tools/layout_audit.js` and `AUDIT_ORDER=1 node kiosk_server/tools/layout_audit.js <dir>` — every rule passes at 1440 and 1180.
3. The browser checks used before (order → Mark as paid, QR demo, scanned link) still pass — the ids did not change.
4. Before/after screenshots of all five sections at 1440 for the owner.
