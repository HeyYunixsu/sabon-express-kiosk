'use strict';
// Shared by the server tests: a stub controller on a real TCP socket and a
// kiosk server started against it in a temp directory.

const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createKioskServer } = require('../server');
const { hashPin } = require('../lib/staff');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await sleep(20); }
  throw new Error('timed out waiting');
}

// STATUS every 50 ms, PRICES on request, scripted DISPENSE replies.
function stubController() {
  const stub = {
    received: [],
    armed: [0, 0, 0, 0, 0, 0],
    busy: [0, 0, 0, 0, 0, 0],
    empty: [0, 0, 0, 0, 0, 0],
    prices: '5,5,10,10,8,8',
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
        if (verb === 'GETPRICES') s.write(`PRICES,${stub.prices}\n`);
        if (verb === 'DISPENSE') s.write(`DISPENSE_ACK,${slot},${stub.dispenseReplies.shift() || 'no_credit'}\n`);
        if (verb === 'PAUSE') s.write(`PAUSE_ACK,${slot},ok\n`);
        if (verb === 'SETPRICE') {
          const r = stub.priceReply || 'ok';
          if (r === 'ok') {
            const p = stub.prices.split(',');
            p[Number(slot) - 1] = l.split(',')[2];
            stub.prices = p.join(',');
          }
          s.write(`PRICE_ACK,${slot},${r}\n`);
        }
        if (verb === 'PRIME') s.write(`PRIME_ACK,${slot},${stub.primeReply || 'started'}\n`);
      }
    });
  });
  // Push a line to the kiosk unasked, as the controller does after SETPRICE.
  stub.sendLine = (l) => { for (const s of stub.sockets) s.write(l + '\n'); };
  stub.close = () => {
    for (const s of stub.sockets) s.destroy();
    stub.server.close();
  };
  return new Promise((r) => stub.server.listen(0, '127.0.0.1', () => {
    stub.port = stub.server.address().port;
    r(stub);
  }));
}

// config: extra config.env lines. host: where the kiosk listens.
async function startKiosk(stub, { config = [], host = '127.0.0.1', orderTimeoutMs } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiosk-'));
  fs.mkdirSync(path.join(dir, 'CONFIG'));
  fs.writeFileSync(path.join(dir, 'CONFIG', 'config.env'), [
    `SOCKET_PORT = ${stub.port}`,
    'PRODUCT1_NAME = Detergent 1',
    'STAFF1_NAME = Ana',
    `STAFF1_PIN_HASH = ${hashPin('4821')}`,
    'STAFF2_NAME = Ben',
    `STAFF2_PIN_HASH = ${hashPin('7777')}`,
    ...config,
  ].join('\n'));
  const k = createKioskServer({
    root: dir,
    controller: { offlineMs: 400, reconnectMs: 100 },
    orderTimeoutMs,
    log: () => {},
  });
  await new Promise((r) => k.server.listen(0, host, r));
  k.port = k.server.address().port;
  k.url = `http://127.0.0.1:${k.port}`;
  k.dir = dir;
  k.post = async (p, body, headers = {}) => {
    const res = await fetch(k.url + p, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    return { code: res.status, body: await res.json().catch(() => ({})), headers: res.headers };
  };
  k.get = async (p, headers = {}) => {
    const res = await fetch(k.url + p, { headers });
    return { code: res.status, body: await res.json().catch(() => ({})) };
  };
  k.rows = (name) => {
    const f = path.join(dir, 'logs', name);
    if (!fs.existsSync(f)) return [];
    return fs.readFileSync(f, 'utf-8').trim().split('\n').filter(Boolean).map(JSON.parse);
  };
  await until(() => k.ctrl.online && Object.keys(k.ctrl.prices).length === 6);
  return k;
}

const arms = (stub) => stub.received.filter((l) => l.startsWith('ARM'));
const sale = { items: [{ slot: 1, qty: 2 }, { slot: 3, qty: 1 }], amount: 20 };

module.exports = { sleep, until, stubController, startKiosk, arms, sale };
