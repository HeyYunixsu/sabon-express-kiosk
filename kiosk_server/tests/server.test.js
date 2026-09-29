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
