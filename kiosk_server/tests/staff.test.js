'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { hashPin, pinMatches, loadStaff, createPinPad, MAX_WRONG, LOCK_MS } = require('../lib/staff');

test('a hashed PIN matches itself and nothing else', () => {
  const h = hashPin('4821');
  assert.match(h, /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
  assert.ok(pinMatches('4821', h));
  assert.ok(!pinMatches('4822', h));
  assert.ok(!pinMatches('4821', 'garbage'));
});

test('the same PIN hashes differently each time (salted)', () => {
  assert.notStrictEqual(hashPin('4821'), hashPin('4821'));
});

test('loadStaff takes only complete name + hash pairs', () => {
  const staff = loadStaff({
    STAFF1_NAME: 'Ana', STAFF1_PIN_HASH: hashPin('1111'),
    STAFF2_NAME: 'Ben',                                   // no hash: ignored
    STAFF3_PIN_HASH: hashPin('3333'),                     // no name: ignored
  });
  assert.deepStrictEqual(staff.map((s) => s.name), ['Ana']);
});

test('the pad names who confirmed', () => {
  const pad = createPinPad(loadStaff({
    STAFF1_NAME: 'Ana', STAFF1_PIN_HASH: hashPin('1111'),
    STAFF2_NAME: 'Ben', STAFF2_PIN_HASH: hashPin('2222'),
  }));
  assert.deepStrictEqual(pad.check('2222'), { ok: true, name: 'Ben' });
  assert.strictEqual(pad.check('9999').reason, 'wrong');
});

test('no staff configured means no cash confirmation at all', () => {
  assert.strictEqual(createPinPad([]).check('1111').reason, 'no_staff');
});

test(`${MAX_WRONG} wrong PINs lock the pad, even to the right PIN, until the lock expires`, () => {
  let t = 1000;
  let locks = 0;
  const pad = createPinPad(loadStaff({ STAFF1_NAME: 'Ana', STAFF1_PIN_HASH: hashPin('1111') }),
    { now: () => t, onLock: () => locks++ });

  for (let i = 1; i < MAX_WRONG; i++) assert.strictEqual(pad.check('0000').reason, 'wrong');
  assert.strictEqual(pad.check('0000').reason, 'locked');
  assert.strictEqual(locks, 1);
  assert.strictEqual(pad.check('1111').reason, 'locked');

  t += LOCK_MS;
  assert.deepStrictEqual(pad.check('1111'), { ok: true, name: 'Ana' });
});

test('a right PIN resets the wrong count', () => {
  const pad = createPinPad(loadStaff({ STAFF1_NAME: 'Ana', STAFF1_PIN_HASH: hashPin('1111') }));
  for (let i = 1; i < MAX_WRONG; i++) pad.check('0000');
  assert.ok(pad.check('1111').ok);
  assert.strictEqual(pad.check('0000').reason, 'wrong');
});
