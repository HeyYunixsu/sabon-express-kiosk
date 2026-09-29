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

test('salesToday caches parsed transaction files by path and drops deleted ones', () => {
  const root = tmp();
  const p = logPaths({}, root);
  fs.mkdirSync(p.salesArchive, { recursive: true });
  fs.mkdirSync(p.transactions, { recursive: true });
  const file = path.join(p.transactions, '1_transaction_9_0.json');
  fs.writeFileSync(file, JSON.stringify({ machine_id: '1', vendor_id: '', voucher_id: '', amount: 10, slot: '4', date_created: '2026-09-29 12:00:00' }));
  assert.deepStrictEqual(salesToday(p, '2026-09-29'), { bySlot: { 4: { presses: 1, amount: 10 } }, presses: 1, amount: 10 });
  fs.unlinkSync(file);
  assert.deepStrictEqual(salesToday(p, '2026-09-29'), { bySlot: {}, presses: 0, amount: 0 });
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
