'use strict';
// QR payment demo: a pretend QR Ph payment, only with QR_DEMO = 1.
const test = require('node:test');
const assert = require('node:assert');
const { lanAddress } = require('../lib/access');
const { sleep, until, stubController, startKiosk, arms, sale } = require('./helpers');

const qrSale = { ...sale, method: 'qr' };
const NO_LAN = 'no LAN address on this machine (a QR order needs one)';

async function kiosk(t, opts = { config: ['QR_DEMO = 1'] }) {
  const stub = await stubController();
  const k = await startKiosk(stub, opts);
  t.after(() => { k.close(); stub.close(); });
  return { stub, k };
}

test('QR demo off: QR orders refused and /pay does not exist', async (t) => {
  const { k } = await kiosk(t, { config: [] });
  assert.strictEqual((await k.get('/api/state')).body.qrDemo, false);
  const r = await k.post('/api/order', qrSale);
  assert.deepStrictEqual([r.code, r.body.error], [400, 'qr_off']);
  assert.strictEqual((await fetch(k.url + '/pay/A-1')).status, 404);
  assert.strictEqual((await k.post('/pay/api/confirm', { number: 'A-1' })).code, 404);
});

test('QR demo: the phone pays, the machine arms, the payment is logged qr_demo', async (t) => {
  if (!lanAddress()) return t.skip(NO_LAN);
  const { stub, k } = await kiosk(t);
  assert.strictEqual((await k.get('/api/state')).body.qrDemo, true);
  const { body } = await k.post('/api/order', qrSale);
  const n = body.order.number;
  assert.strictEqual(body.order.method, 'qr');
  assert.strictEqual((await fetch(k.url + `/pay/${n}`)).status, 200);
  const o = await k.get(`/pay/api/order?number=${n}`);
  assert.deepStrictEqual([o.code, o.body.order.amount, o.body.order.status], [200, 20, 'waiting']);

  const r = await k.post('/pay/api/confirm', { number: n });
  assert.strictEqual(r.code, 200);
  await until(() => arms(stub).length === 1);
  const pay = k.rows('payments.jsonl')[0];
  assert.deepStrictEqual([pay.method, pay.staff, pay.via, pay.amount], ['qr_demo', 'QR demo', 'phone', 20]);
  assert.strictEqual(k.rows('orders.jsonl').find((r) => r.closed).method, 'qr');

  const again = await k.post('/pay/api/confirm', { number: n });
  assert.deepStrictEqual([again.code, again.body.error], [409, 'not_waiting']);
  assert.strictEqual(arms(stub).length, 1);
});

test('QR demo: a QR order is not paid as cash, a cash order is not paid by QR', async (t) => {
  if (!lanAddress()) return t.skip(NO_LAN);
  const { stub, k } = await kiosk(t);
  const login = await k.post('/staff/api/login', { pin: '4821' });
  const headers = { cookie: (login.headers.get('set-cookie') || '').split(';')[0] };

  const { body } = await k.post('/api/order', qrSale);
  const n = body.order.number;
  let r = await k.post('/staff/api/orders/paid', { number: n }, headers);
  assert.deepStrictEqual([r.code, r.body.error], [409, 'qr_order']);
  r = await k.post('/api/order/pin', { number: n, pin: '4821' });
  assert.deepStrictEqual([r.code, r.body.error], [409, 'qr_order']);
  r = await k.post('/staff/api/orders/cancel', { number: n }, headers);
  assert.strictEqual(r.code, 200);

  const cash = await k.post('/api/order', sale);
  const c = cash.body.order.number;
  assert.strictEqual(cash.body.order.method, 'cash');
  r = await k.post('/pay/api/confirm', { number: c });
  assert.deepStrictEqual([r.code, r.body.error], [409, 'not_qr']);
  assert.strictEqual((await k.get(`/pay/api/order?number=${c}`)).code, 404);
  assert.deepStrictEqual(arms(stub), []);
});

test('QR demo: an expired QR order cannot be paid', async (t) => {
  if (!lanAddress()) return t.skip(NO_LAN);
  const { stub, k } = await kiosk(t, { config: ['QR_DEMO = 1'], orderTimeoutMs: 300 });
  const { body } = await k.post('/api/order', qrSale);
  await sleep(400);
  const r = await k.post('/pay/api/confirm', { number: body.order.number });
  assert.deepStrictEqual([r.code, r.body.error, r.body.order.status], [409, 'not_waiting', 'expired']);
  assert.deepStrictEqual(arms(stub), []);
});

test('QR demo: from the shop Wi-Fi /pay answers only in demo mode', async (t) => {
  const ip = lanAddress();
  if (!ip) return t.skip(NO_LAN);
  const on = await kiosk(t, { config: ['QR_DEMO = 1'], host: '0.0.0.0' });
  const lanOn = `http://${ip}:${on.k.port}`;
  assert.strictEqual((await fetch(lanOn + '/pay/A-1')).status, 200);
  assert.strictEqual((await fetch(lanOn + '/pay/api/order?number=A-1')).status, 404);
  assert.strictEqual((await fetch(lanOn + '/api/order', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(qrSale),
  })).status, 403);

  const off = await kiosk(t, { config: ['STAFF_TABLET = 1'], host: '0.0.0.0' });
  assert.strictEqual((await fetch(`http://${ip}:${off.k.port}/pay/A-1`)).status, 403);

  assert.strictEqual((await fetch(lanOn + '/staff')).status, 403);
});

test('QR demo: a demo payment is not counted as cash in the staff totals', async (t) => {
  if (!lanAddress()) return t.skip(NO_LAN);
  const { stub, k } = await kiosk(t);
  const { body } = await k.post('/api/order', qrSale);
  const n = body.order.number;
  const r = await k.post('/pay/api/confirm', { number: n });
  assert.strictEqual(r.code, 200);
  await until(() => arms(stub).length === 1);

  const login = await k.post('/staff/api/login', { pin: '4821' });
  const headers = { cookie: (login.headers.get('set-cookie') || '').split(';')[0] };
  const state = await k.get('/staff/api/state', headers);
  assert.deepStrictEqual([state.body.today.paid, state.body.today.total], [0, 0]);
  const tools = await k.get('/staff/api/tools', headers);
  assert.deepStrictEqual(tools.body.cashByStaff, {});
});
