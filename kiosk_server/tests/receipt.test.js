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
  // [...] copies the array out of the vm's realm: assert.deepStrictEqual
  // treats an Array from a different vm context as a different type even
  // with identical contents, since each realm has its own Array prototype.
  assert.deepStrictEqual([...R.when('2026-10-02 14:14:05')], ['Oct 2, 2026', '2:14 PM']);
  assert.deepStrictEqual([...R.when('2026-01-09 00:05:00')], ['Jan 9, 2026', '12:05 AM']);
  assert.deepStrictEqual([...R.when('')], ['', '']);
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
