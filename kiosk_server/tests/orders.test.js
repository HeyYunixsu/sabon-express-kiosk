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
