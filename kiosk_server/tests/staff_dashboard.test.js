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
  const now = Math.floor(Date.now() / 1000);
  for (const n of [`${now}_transaction_1_0.json`, `${now}_transaction_1_1.json`, 'state.dat']) {
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
    idsProblem: 'unset', oldestPendingMin: 0,
  });
});

// The backend refuses sales under the sample IDs or with the two swapped, and
// the uploader then keeps them forever: the dashboard must say so.
test('status: machine IDs unset, swapped or right', async (t) => {
  const uuid = '0a1b2c3d-1111-2222-3333-444455556666';
  for (const [config, want] of [
    [['machineId = 24'], 'unset'],
    [['machineId = 24', 'vendorId ='], 'unset'],
    [['machineId = 1', 'vendorId ='], 'unset'],
    [[`machineId = ${uuid}`, 'vendorId = 24'], 'wrong'],
    [['machineId = 24', `vendorId = ${uuid}`], null],
  ]) {
    const { k, headers } = await kiosk(t, { config });
    assert.strictEqual((await state(k, headers)).status.idsProblem, want, config.join(' / '));
  }
});

test('status: how long the oldest waiting sale has waited', async (t) => {
  const { k, headers } = await kiosk(t);
  assert.strictEqual((await state(k, headers)).status.oldestPendingMin, null);
  fs.mkdirSync(path.join(k.dir, 'transaction'), { recursive: true });
  const at = (minAgo) => Math.floor(Date.now() / 1000) - minAgo * 60;
  fs.writeFileSync(path.join(k.dir, 'transaction', `${at(95)}_transaction_1_0.json`), '{}');
  fs.writeFileSync(path.join(k.dir, 'transaction', `${at(5)}_transaction_2_0.json`), '{}');
  assert.strictEqual((await state(k, headers)).status.oldestPendingMin, 95);
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

test('S1: order numbers carry on from the orders log after a restart', async (t) => {
  // Seeded before the server starts: the order book rolls its day off the
  // first STATUS tick, which lands before a post-start write would.
  const { k } = await kiosk(t, {
    preListen: (dir) => {
      const f = path.join(dir, 'logs', 'orders.jsonl');
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, JSON.stringify({
        reference: `${day(0).replace(/-/g, '')}-A-5`, amount: 10, status: 'paid', by: 'Ana', closed: `${day(0)} 09:00:00`,
      }) + '\n');
    },
  });
  const r = await k.post('/api/order', { items: [{ slot: 1, qty: 1 }], amount: 5 });
  assert.strictEqual(r.code, 200);
  assert.strictEqual(r.body.order.number, 'A-6');
});

test('S2: attention counts only today\'s interrupted pours', async (t) => {
  const { k, headers } = await kiosk(t);
  writeRows(k, 'logs/interrupted_sales.jsonl', [
    { slot: 1, amount: 10, reason: 'tank_empty', date_created: `${day(0)} 09:00:00` },
    { slot: 2, amount: 15, reason: 'pause_timeout', date_created: `${day(0)} 09:30:00` },
    { slot: 3, amount: 5, reason: 'tank_empty', date_created: '1999-01-01 00:00:00' },
  ]);
  const s = await state(k, headers);
  assert.strictEqual(s.attention, 2);
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

// Item 1: an order left waiting (never paid or cancelled) when the process
// dies leaves no closed row in orders.jsonl -- lastNumber must still see its
// number, or a restart hands it out again to the next customer.
test('an order still waiting at a restart is not renumbered', async (t) => {
  const stub = await stubController();
  t.after(() => stub.close());
  const k1 = await startKiosk(stub);
  const first = await k1.post('/api/order', { items: [{ slot: 1, qty: 1 }], amount: 5 });
  assert.strictEqual(first.code, 200);
  assert.strictEqual(first.body.order.number, 'A-1');   // still waiting: never paid, never cancelled
  k1.close();

  const k2 = await startKiosk(stub, { dir: k1.dir });
  t.after(() => k2.close());
  const second = await k2.post('/api/order', { items: [{ slot: 1, qty: 1 }], amount: 5 });
  assert.strictEqual(second.code, 200);
  assert.strictEqual(second.body.order.number, 'A-2');
});

// Item 2: staffState() is polled once a second by every open staff page --
// dashboardStats() and todaySummary() must not re-scan the whole log on every
// poll, but the numbers must still be right the instant a new order closes.
test('stats stay correct after a new order closes (the memo invalidates)', async (t) => {
  const { stub, k, headers } = await kiosk(t);
  const before = await state(k, headers);
  assert.deepStrictEqual([before.today.paid, before.today.total, before.stats.today.paid], [0, 0, 0]);

  const { body } = await k.post('/api/order', { items: [{ slot: 1, qty: 1 }], amount: 5 });
  const r = await k.post('/api/order/pin', { number: body.order.number, pin: '4821' });
  assert.strictEqual(r.code, 200);
  await until(() => stub.received.some((l) => l.startsWith('ARM')));

  const after = await state(k, headers);
  assert.deepStrictEqual([after.today.paid, after.today.total, after.stats.today.paid], [1, 5, 1]);
});

// Item 3: the table caps at 200 rows, but the 7-day totals must not -- a
// busy week must not under-report once it passes the cap.
test('GET /staff/api/orders: totals cover the full window, not the 200-row cap', async (t) => {
  const { k, headers } = await kiosk(t);
  const ord = (n, status, method) => ({
    reference: `${day(0).replace(/-/g, '')}-A-${n}`, amount: 5, status, method,
    by: status === 'paid' ? 'Ana' : null, closed: `${day(0)} 12:00:00`,
  });
  const rows = [];
  for (let i = 1; i <= 205; i++) rows.push(ord(i, 'paid'));
  rows.push(ord(206, 'paid', 'qr'));
  rows.push(ord(207, 'cancelled'));
  writeRows(k, 'logs/orders.jsonl', rows);
  const r = await k.get('/staff/api/orders', headers);
  assert.strictEqual(r.code, 200);
  assert.strictEqual(r.body.orders.length, 200);   // the table still caps
  assert.deepStrictEqual(r.body.totals, { orders: 207, paid: 205, cash: 205 * 5 });
});

// Item 4: the Pi's clock decides "today", not whatever device is looking at
// the dashboard.
test('staffState carries the day and hour, for the page\'s own clock', async (t) => {
  const { k, headers } = await kiosk(t);
  const s = await state(k, headers);
  assert.strictEqual(s.day, day(0));
  assert.strictEqual(s.hour, new Date().getHours());
});
