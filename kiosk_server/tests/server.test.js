'use strict';
// The kiosk server against a stub controller on a real TCP socket.
const test = require('node:test');
const assert = require('node:assert');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createKioskServer } = require('../server');
const { hashPin } = require('../lib/staff');
const { parseStatus } = require('../lib/controller');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return; await sleep(20); }
  throw new Error('timed out waiting');
}

// Speaks just enough of the controller protocol: STATUS every 50 ms, PRICES on
// request, and scripted DISPENSE replies.
function stubController() {
  const stub = {
    received: [],
    armed: [0, 0, 0, 0, 0, 0],
    busy: [0, 0, 0, 0, 0, 0],
    empty: [0, 0, 0, 0, 0, 0],
    silent: false,
    dispenseReplies: [],
    sockets: new Set(),
  };
  const line = () => ['STATUS', ...stub.armed, 0, 0, 0, 0, 0, 0, ...stub.empty,
    ...stub.busy, 0, 0, 0, 0, 0, 0, 0, 0, 0].join(',') + '\n';
  stub.server = net.createServer((s) => {
    let buf = '';
    stub.sockets.add(s);
    const timer = setInterval(() => { if (!stub.silent) s.write(line()); }, 50);
    s.on('close', () => { clearInterval(timer); stub.sockets.delete(s); });
    s.on('error', () => {});
    s.on('data', (d) => {
      buf += d;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const l of lines) {
        stub.received.push(l);
        const [verb, slot] = l.split(',');
        if (verb === 'GETPRICES') s.write('PRICES,5,5,10,10,8,8\n');
        if (verb === 'DISPENSE') s.write(`DISPENSE_ACK,${slot},${stub.dispenseReplies.shift() || 'no_credit'}\n`);
        if (verb === 'PAUSE') s.write(`PAUSE_ACK,${slot},ok\n`);
      }
    });
  });
  stub.close = () => {
    for (const s of stub.sockets) s.destroy();
    stub.server.close();
  };
  return new Promise((r) => stub.server.listen(0, '127.0.0.1', () => {
    stub.port = stub.server.address().port;
    r(stub);
  }));
}

async function startKiosk(stub) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiosk-'));
  fs.mkdirSync(path.join(dir, 'CONFIG'));
  fs.writeFileSync(path.join(dir, 'CONFIG', 'config.env'), [
    `SOCKET_PORT = ${stub.port}`,
    'PRODUCT1_NAME = Detergent 1',
    'STAFF1_NAME = Ana',
    `STAFF1_PIN_HASH = ${hashPin('4821')}`,
  ].join('\n'));
  const k = createKioskServer({
    root: dir,
    controller: { offlineMs: 400, reconnectMs: 100 },
    log: () => {},
  });
  await new Promise((r) => k.server.listen(0, '127.0.0.1', r));
  k.url = `http://127.0.0.1:${k.server.address().port}`;
  k.dir = dir;
  k.post = async (p, body) => {
    const res = await fetch(k.url + p, { method: 'POST', body: JSON.stringify(body) });
    return { code: res.status, body: await res.json() };
  };
  await until(() => k.ctrl.online && Object.keys(k.ctrl.prices).length === 6);
  return k;
}

const sale = { items: [{ slot: 1, qty: 2 }, { slot: 3, qty: 1 }], amount: 20 };
const arms = (stub) => stub.received.filter((l) => l.startsWith('ARM'));

test('parseStatus reads all six slots and rejects a torn line', () => {
  const s = parseStatus('STATUS,2,0,0,0,0,0,1500,0,0,0,0,0,0,0,1,0,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,1,0');
  assert.deepStrictEqual(s.slots[0], { slot: 1, armed: 2, remainingMs: 1500, empty: false, busy: true, queued: 0 });
  assert.strictEqual(s.slots[2].empty, true);
  assert.strictEqual(parseStatus('STATUS,1,2,3'), null);
});

test('cash sale: PIN, price and state rules', async (t) => {
  const stub = await stubController();
  const k = await startKiosk(stub);
  t.after(() => { k.close(); stub.close(); });

  await t.test('a wrong PIN never arms', async () => {
    const r = await k.post('/api/cash', { ...sale, pin: '0000' });
    assert.strictEqual(r.code, 401);
    assert.deepStrictEqual(arms(stub), []);
  });

  await t.test('a total that is not the controller\'s price is refused', async () => {
    const r = await k.post('/api/cash', { ...sale, amount: 15, pin: '4821' });
    assert.strictEqual(r.code, 409);
    assert.deepStrictEqual(r.body, { error: 'price_changed', amount: 20 });
    assert.deepStrictEqual(arms(stub), []);
  });

  await t.test('an empty tank cannot be sold', async () => {
    stub.empty[2] = 1;
    await sleep(120);
    const r = await k.post('/api/cash', { ...sale, pin: '4821' });
    assert.deepStrictEqual([r.code, r.body.error], [409, 'empty']);
    stub.empty[2] = 0;
    await sleep(120);
  });

  await t.test('the right PIN arms the batch and logs who took the cash', async () => {
    const r = await k.post('/api/cash', { ...sale, pin: '4821' });
    assert.strictEqual(r.code, 200);
    assert.strictEqual(r.body.staff, 'Ana');
    await until(() => arms(stub).length === 1);
    assert.deepStrictEqual(arms(stub), ['ARM_BATCH,1:2,3:1']);

    const rows = fs.readFileSync(path.join(k.dir, 'logs', 'payments.jsonl'), 'utf-8')
      .trim().split('\n').map(JSON.parse);
    assert.strictEqual(rows.length, 1);
    assert.deepStrictEqual(
      { method: rows[0].method, amount: rows[0].amount, staff: rows[0].staff, items: rows[0].items },
      { method: 'cash', amount: 20, staff: 'Ana', items: '1:2,3:1' });
    assert.match(rows[0].date_created, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
    assert.strictEqual(rows[0].reference, r.body.reference);
  });

  await t.test('a second confirm straight after cannot arm again', async () => {
    const r = await k.post('/api/cash', { ...sale, pin: '4821' });
    assert.deepStrictEqual([r.code, r.body.error], [409, 'machine_busy']);
    assert.strictEqual(arms(stub).length, 1);
  });

  await t.test('no new sale while paid presses are still on the machine', async () => {
    stub.armed[0] = 2;
    await sleep(3100);   // past the post-ARM guard, so only STATUS is holding it
    const r = await k.post('/api/cash', { ...sale, pin: '4821' });
    assert.deepStrictEqual([r.code, r.body.error], [409, 'machine_busy']);
    stub.armed[0] = 0;
  });
});

test('dispense starts every paid press, retrying the cooldown', async (t) => {
  const stub = await stubController();
  const k = await startKiosk(stub);
  t.after(() => { k.close(); stub.close(); });

  stub.dispenseReplies = ['cooldown', 'ok', 'ok', 'ok', 'no_credit'];
  const r = await k.post('/api/dispense', { slot: 2 });
  assert.deepStrictEqual(r.body, { result: 'ok', poured: 3 });
  assert.strictEqual(stub.received.filter((l) => l === 'DISPENSE,2').length, 5);
});

test('dispense with no credit at all is reported, not called success', async (t) => {
  const stub = await stubController();
  const k = await startKiosk(stub);
  t.after(() => { k.close(); stub.close(); });

  const r = await k.post('/api/dispense', { slot: 2 });
  assert.deepStrictEqual(r.body, { result: 'no_credit', poured: 0 });
});

test('pause answers with the controller\'s ACK', async (t) => {
  const stub = await stubController();
  const k = await startKiosk(stub);
  t.after(() => { k.close(); stub.close(); });

  assert.deepStrictEqual((await k.post('/api/pause', { slot: 4 })).body, { result: 'ok' });
  assert.strictEqual((await k.post('/api/pause', { slot: 9 })).code, 400);
});

test('STATUS silence marks the machine offline and stops sales', async (t) => {
  const stub = await stubController();
  const k = await startKiosk(stub);
  t.after(() => { k.close(); stub.close(); });

  stub.silent = true;               // socket stays open: only the silence says so
  await until(() => !k.ctrl.online, 2000);
  const r = await k.post('/api/cash', { ...sale, pin: '4821' });
  assert.deepStrictEqual([r.code, r.body.error], [503, 'offline']);
  assert.deepStrictEqual(arms(stub), []);

  stub.silent = false;
  await until(() => k.ctrl.online, 2000);
});

test('five wrong PINs lock the pad and log it', async (t) => {
  const stub = await stubController();
  const k = await startKiosk(stub);
  t.after(() => { k.close(); stub.close(); });

  for (let i = 0; i < 4; i++) assert.strictEqual((await k.post('/api/cash', { ...sale, pin: '1111' })).code, 401);
  assert.strictEqual((await k.post('/api/cash', { ...sale, pin: '1111' })).code, 423);
  assert.strictEqual((await k.post('/api/cash', { ...sale, pin: '4821' })).code, 423);
  assert.deepStrictEqual(arms(stub), []);
  const log = fs.readFileSync(path.join(k.dir, 'logs', 'pin_lockouts.jsonl'), 'utf-8');
  assert.match(log, /"event":"pin_locked"/);
});

test('static files are served and cannot escape public/', async (t) => {
  const stub = await stubController();
  const k = await startKiosk(stub);
  t.after(() => { k.close(); stub.close(); });

  const page = await fetch(k.url + '/');
  assert.strictEqual(page.status, 200);
  assert.match(await page.text(), /<html/i);
  const escape = await fetch(k.url + '/%2e%2e/server.js');
  assert.notStrictEqual(escape.status, 200);
});
