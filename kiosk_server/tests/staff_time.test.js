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
