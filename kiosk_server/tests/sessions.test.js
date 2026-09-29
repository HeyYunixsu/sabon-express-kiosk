'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createSessions, tokenFrom, cookieFor, clearCookie, SESSION_MS } = require('../lib/sessions');
const { isLocal, lanAllowed, lanAddress } = require('../lib/access');

test('a session names its staff member until it expires', () => {
  let t = 1000;
  const s = createSessions({ ttlMs: 5000, now: () => t });
  const token = s.create('Ana');
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.strictEqual(s.get(token).name, 'Ana');
  t += 4999;
  assert.ok(s.get(token));
  t += 1;
  assert.strictEqual(s.get(token), null);
});

test('sign out ends a session; unknown tokens are nobody', () => {
  const s = createSessions();
  const token = s.create('Ben');
  s.destroy(token);
  assert.strictEqual(s.get(token), null);
  assert.strictEqual(s.get('nope'), null);
  assert.strictEqual(s.get(null), null);
});

test('two sign-ins get different tokens', () => {
  const s = createSessions();
  assert.notStrictEqual(s.create('Ana'), s.create('Ana'));
});

test('the cookie is read back from a request and is locked down', () => {
  const req = { headers: { cookie: 'x=1; sabon_staff=abc123; y=2' } };
  assert.strictEqual(tokenFrom(req), 'abc123');
  assert.strictEqual(tokenFrom({ headers: {} }), null);
  const c = cookieFor('abc123', SESSION_MS);
  assert.match(c, /^sabon_staff=abc123;/);
  for (const part of ['HttpOnly', 'SameSite=Strict', 'Path=/staff', 'Max-Age=43200']) assert.ok(c.includes(part), part);
  assert.match(clearCookie(), /Max-Age=0/);
});

test('isLocal: only the Pi itself', () => {
  const req = (a) => ({ socket: { remoteAddress: a } });
  for (const a of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) assert.ok(isLocal(req(a)), a);
  for (const a of ['192.168.1.20', '::ffff:192.168.1.20', '10.0.0.5']) assert.ok(!isLocal(req(a)), a);
});

test('lanAllowed: the staff page and its pictures, nothing else', () => {
  for (const u of ['/staff', '/staff/', '/staff/order/A-3', '/staff/api/state', '/staff/staff.js',
                   '/img/products/1.webp', '/fonts/inter-v20-latin-700.woff2'])
    assert.ok(lanAllowed(u, { staff: true }), u);
  for (const u of ['/', '/index.html', '/api/state', '/api/order', '/api/order/pin', '/api/dispense',
                   '/js/kiosk.js', '/staffx', '/staff/../api/order', '/staff/%2e%2e/api/order'])
    assert.ok(!lanAllowed(u, { staff: true }), u);
});

test('lanAllowed: without { staff: true }, /staff is refused; pictures still answer', () => {
  for (const u of ['/staff', '/staff/', '/staff/api/state']) assert.ok(!lanAllowed(u), u);
  for (const u of ['/img/products/1.webp', '/fonts/inter-v20-latin-700.woff2']) assert.ok(lanAllowed(u), u);
});

test('lanAddress picks the first non-internal IPv4', () => {
  const ifaces = {
    lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
    wlan0: [{ family: 'IPv6', address: 'fe80::1', internal: false },
            { family: 'IPv4', address: '192.168.1.50', internal: false }],
  };
  assert.strictEqual(lanAddress(ifaces), '192.168.1.50');
  assert.strictEqual(lanAddress({ lo: ifaces.lo }), null);
});

test('lanAddress skips link-local 169.254.x.x addresses', () => {
  assert.strictEqual(lanAddress({
    wlan0: [{ family: 'IPv4', address: '169.254.10.20', internal: false }],
  }), null);
  assert.strictEqual(lanAddress({
    wlan0: [{ family: 'IPv4', address: '169.254.10.20', internal: false },
            { family: 'IPv4', address: '192.168.1.50', internal: false }],
  }), '192.168.1.50');
});
