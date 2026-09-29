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

test('air clear is reported as priming, not as a customer pour, until STATUS shows the nozzle free', async (t) => {
  const { stub, k, headers } = await kiosk(t);

  const r = await k.post('/staff/api/prime', { slot: 3, confirm: true }, headers);
  assert.deepStrictEqual([r.code, r.body.result], [200, 'started']);
  assert.deepStrictEqual((await k.get('/api/state')).body.priming, [3]);

  stub.busy[2] = 0; // the stub never actually reports the prime busy; STATUS just says "not busy"
  await until(async () => {
    const { priming } = (await k.get('/api/state')).body;
    return Array.isArray(priming) && priming.length === 0;
  });
  assert.deepStrictEqual((await k.get('/api/state')).body.priming, []);
});

test('air clear runs while presses are owed but not while a nozzle is pouring', async (t) => {
  const { stub, k, headers } = await kiosk(t);

  stub.armed[2] = 1;
  await until(() => k.ctrl.status.slots[2].armed === 1);
  const tools1 = (await k.get('/staff/api/tools', headers)).body;
  assert.strictEqual(tools1.busy, 'machine_busy');
  assert.strictEqual(tools1.primeBusy, null);
  const r1 = await k.post('/staff/api/prime', { slot: 4, confirm: true }, headers);
  assert.deepStrictEqual([r1.code, r1.body.result], [200, 'started']);
  stub.armed[2] = 0;
  await until(() => k.ctrl.status.slots[2].armed === 0);

  stub.busy[0] = 1;
  await until(() => k.ctrl.status.slots[0].busy === true);
  const r2 = await k.post('/staff/api/prime', { slot: 4, confirm: true }, headers);
  assert.deepStrictEqual([r2.code, r2.body.error], [409, 'machine_busy']);
  stub.busy[0] = 0;
  await until(() => k.ctrl.status.slots[0].busy === false);
});

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

test('give back refuses when the price changed since the credit was paid; write off still works', async (t) => {
  const { stub, k, headers } = await kiosk(t);
  const now = stamp();
  // Stub prices are 5,5,10,10,8,8: slot 1 x 2 should be 10, not 99.
  writeRows(k, 'logs/unclaimed_credits.jsonl', [
    { machine_id: '1', slot: '1', qty: 2, amount: 99, reason: 'timeout', date_created: now },
  ]);
  const open = (await k.get('/staff/api/tools', headers)).body.credits;
  const r = await k.post('/staff/api/credits/give-back', { id: open[0].id }, headers);
  assert.deepStrictEqual([r.code, r.body.error], [409, 'price_changed']);
  assert.deepStrictEqual(arms(stub), []);
  const w = await k.post('/staff/api/credits/write-off', { id: open[0].id }, headers);
  assert.strictEqual(w.code, 200);
});

test('give back refuses on an empty tank', async (t) => {
  const { stub, k, headers } = await kiosk(t);
  const now = stamp();
  // Slot 3 price is 10, so qty 2 x 10 = 20 matches -- only the empty tank refuses it.
  writeRows(k, 'logs/unclaimed_credits.jsonl', [
    { machine_id: '1', slot: '3', qty: 2, amount: 20, reason: 'timeout', date_created: now },
  ]);
  stub.empty[2] = 1;
  await until(() => k.ctrl.status.slots[2].empty === true);
  const open = (await k.get('/staff/api/tools', headers)).body.credits;
  const r = await k.post('/staff/api/credits/give-back', { id: open[0].id }, headers);
  assert.deepStrictEqual([r.code, r.body.error], [409, 'slot_empty']);
  assert.deepStrictEqual(arms(stub), []);
});
