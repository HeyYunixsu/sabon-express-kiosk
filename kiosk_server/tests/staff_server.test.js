'use strict';
// The staff tablet side of the server.
const test = require('node:test');
const assert = require('node:assert');
const { lanAddress } = require('../lib/access');
const { until, stubController, startKiosk, arms, sale } = require('./helpers');

async function kiosk(t, opts) {
  const stub = await stubController();
  const k = await startKiosk(stub, opts);
  t.after(() => { k.close(); stub.close(); });
  return { stub, k };
}

async function signIn(k, pin = '4821') {
  const r = await k.post('/staff/api/login', { pin });
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
  return { r, headers: { cookie } };
}

test('staff sign in once and are named on every action', async (t) => {
  const { stub, k } = await kiosk(t);

  await t.test('without signing in, every staff API says signed_out', async () => {
    assert.strictEqual((await k.get('/staff/api/state')).code, 401);
    assert.strictEqual((await k.post('/staff/api/orders/paid', { number: 'A-1' })).code, 401);
  });

  await t.test('a wrong PIN signs nobody in', async () => {
    const { r } = await signIn(k, '0000');
    assert.strictEqual(r.code, 401);
  });

  await t.test('a login that is not JSON is refused', async () => {
    const res = await fetch(k.url + '/staff/api/login', {
      method: 'POST', body: 'pin=4821',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    assert.strictEqual(res.status, 415);
  });

  const { r, headers } = await signIn(k, '7777');
  await t.test('the right PIN names the person and sets a locked-down cookie', () => {
    assert.deepStrictEqual([r.code, r.body.name], [200, 'Ben']);
    const c = r.headers.get('set-cookie');
    assert.ok(c.includes('HttpOnly') && c.includes('SameSite=Strict') && c.includes('Path=/staff'));
  });

  await t.test('state shows the waiting order', async () => {
    await k.post('/api/order', sale);
    const s = await k.get('/staff/api/state', headers);
    assert.strictEqual(s.code, 200);
    assert.strictEqual(s.body.machine, 'ready');
    assert.strictEqual(s.body.pending.number, 'A-1');
    assert.strictEqual(s.body.pending.items[0].name, 'Detergent 1');
  });

  await t.test('mark paid arms, logs Ben and via tablet', async () => {
    const p = await k.post('/staff/api/orders/paid', { number: 'A-1' }, headers);
    assert.strictEqual(p.code, 200);
    await until(() => arms(stub).length === 1);
    const pay = k.rows('payments.jsonl');
    assert.deepStrictEqual([pay[0].staff, pay[0].via, pay[0].amount], ['Ben', 'tablet', 20]);
    const s = await k.get('/staff/api/state', headers);
    assert.deepStrictEqual([s.body.today.paid, s.body.today.total], [1, 20]);
    assert.deepStrictEqual([s.body.today.orders[0].number, s.body.today.orders[0].by], ['A-1', 'Ben']);
  });

  await t.test('a scanned QR for a closed order shows what happened', async () => {
    const o = await k.get('/staff/api/order?number=A-1', headers);
    assert.deepStrictEqual([o.code, o.body.order.status, o.body.order.by], [200, 'paid', 'Ben']);
    assert.strictEqual((await k.get('/staff/api/order?number=A-99', headers)).code, 404);
  });

  await t.test('sign out ends the session', async () => {
    await k.post('/staff/api/logout', {}, headers);
    assert.strictEqual((await k.get('/staff/api/me', headers)).code, 401);
    const ev = k.rows('staff_events.jsonl').map((e) => [e.event, e.staff]);
    assert.deepStrictEqual(ev, [['sign_in', 'Ben'], ['sign_out', 'Ben']]);
  });
});

test('staff can cancel the waiting order', async (t) => {
  const { stub, k } = await kiosk(t);
  const { headers } = await signIn(k);
  await k.post('/api/order', sale);
  const r = await k.post('/staff/api/orders/cancel', { number: 'A-1' }, headers);
  assert.strictEqual(r.code, 200);
  assert.deepStrictEqual(arms(stub), []);
  const row = k.rows('orders.jsonl').find((r) => r.closed);
  assert.deepStrictEqual([row.status, row.reason, row.by], ['cancelled', 'staff', 'Ana']);
  const again = await k.post('/staff/api/orders/paid', { number: 'A-1' }, headers);
  assert.deepStrictEqual([again.code, again.body.error], [409, 'not_waiting']);
});

test('five wrong tablet PINs lock the tablet pad, not the kiosk pad', async (t) => {
  const { k } = await kiosk(t);
  for (let i = 0; i < 4; i++) assert.strictEqual((await signIn(k, '1111')).r.code, 401);
  assert.strictEqual((await signIn(k, '1111')).r.code, 423);
  assert.strictEqual((await signIn(k, '4821')).r.code, 423);
  const { body } = await k.post('/api/order', sale);
  const r = await k.post('/api/order/pin', { number: body.order.number, pin: '4821' });
  assert.strictEqual(r.code, 200);
  const ev = k.rows('staff_events.jsonl').find((e) => e.event === 'pin_locked');
  assert.strictEqual(ev.where, 'tablet');
});

test('the staff page is served for /staff and a scanned order link', async (t) => {
  const { k } = await kiosk(t);
  for (const p of ['/staff', '/staff/order/A-12']) {
    const res = await fetch(k.url + p);
    assert.strictEqual(res.status, 200, p);
    assert.match(await res.text(), /<html/i);
  }
});

test('from the shop Wi-Fi only the staff page answers', async (t) => {
  const ip = lanAddress();
  if (!ip) return t.skip('no LAN address on this machine');
  const { k } = await kiosk(t, { config: ['STAFF_TABLET = 1'], host: '0.0.0.0' });
  const lan = `http://${ip}:${k.port}`;
  const post = (p) => fetch(lan + p, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sale),
  });

  for (const p of ['/', '/index.html', '/api/state', '/api/stream', '/js/kiosk.js']) {
    assert.strictEqual((await fetch(lan + p)).status, 403, p);
  }
  for (const p of ['/api/order', '/api/order/pin', '/api/order/cancel', '/api/dispense', '/api/pause', '/api/resume']) {
    assert.strictEqual((await post(p)).status, 403, p);
  }
  assert.strictEqual((await fetch(lan + '/staff')).status, 200);
  assert.strictEqual((await fetch(lan + '/img/products/1.webp')).status, 200);
  // KIOSK_PORT is unset in tests, so the QR base uses the default 3000.
  const s = await k.get('/api/state');
  assert.strictEqual(s.body.staffBase, `http://${ip}:3000`);
});
