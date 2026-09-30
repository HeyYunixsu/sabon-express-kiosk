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
  // J. The sidebar is one screen tall (it is sticky, so it stays in view).
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
  // O. Nothing in a table or status list is cut off (checked at every width).
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
        const fails = await js(`(${audit.toString()})(true)`);
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
    await sleep(500);   // let Chrome let go of its profile before removing it
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) { /* best effort */ }
  }
  console.log(`\n${problems ? `${problems} problem(s)` : 'every rule passes'} — screenshots in ${OUT}`);
  process.exit(problems ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
