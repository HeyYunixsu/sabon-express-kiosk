'use strict';
// Sabon Express Kiosk server.
//
// Serves the touchscreen UI and stands between it and the controller. The
// browser never talks to the controller directly: it sees parsed state over
// /api/stream and asks for actions over POST, and this process decides what
// is allowed -- above all, what a cash sale costs and who confirmed it.
//
// Cash is an order: the kiosk creates it, staff confirm it (on the kiosk's
// PIN pad, or from the staff tablet), and confirmPaid() is the one place that
// turns a confirmation into presses on the machine.
//
// Node standard library only, so a Pi needs no npm install for it.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { createController, dispensePaid, SLOTS } = require('./lib/controller');
const { loadStaff, createPinPad } = require('./lib/staff');
const { stamp, appendJsonl } = require('./lib/records');
const { createOrderBook } = require('./lib/orders');

const MAX_QTY = 20;

function loadEnv(file) {
  const vars = {};
  let text = '';
  try { text = fs.readFileSync(file, 'utf-8'); } catch (e) {
    console.error(`[kiosk] could not read ${file}: ${e.message}`);
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (/^(['"]).*\1$/.test(val)) val = val.slice(1, -1);
    if (key) vars[key] = val;
  }
  return vars;
}

function clampInt(v, lo, hi, dflt) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2', '.ico': 'image/x-icon',
};

function createKioskServer({
  root = path.resolve(__dirname, '..'),
  configPath = path.join(root, 'CONFIG', 'config.env'),
  logsDir = path.join(root, 'logs'),
  controller = {},
  orderTimeoutMs,
  log = console.log,
} = {}) {
  const config = loadEnv(configPath);
  const publicDir = path.join(__dirname, 'public');
  const paymentsLog = path.join(logsDir, 'payments.jsonl');
  const ordersLog = path.join(logsDir, 'orders.jsonl');
  const staffLog = path.join(logsDir, 'staff_events.jsonl');

  const products = [];
  for (let i = 1; i <= SLOTS; i++) {
    products.push({
      slot: i,
      name: config[`PRODUCT${i}_NAME`] || `Product ${i}`,
      ml: parseInt(config[`PRODUCT${i}_ML`] || '0', 10) || 0,
      img: `/img/products/${i}.webp`,
    });
  }
  const idleSeconds = parseInt(config.KIOSK_IDLE_S || '60', 10) || 60;
  const staffTablet = config.STAFF_TABLET === '1';
  const letter = /^[A-Z]$/.test(config.KIOSK_LETTER || '') ? config.KIOSK_LETTER : 'A';
  const timeoutMs = orderTimeoutMs || clampInt(config.ORDER_PAY_TIMEOUT_S, 60, 900, 180) * 1000;

  // A record that cannot be written must not break the sale in front of the
  // customer -- but it must be loud.
  function record(file, obj) {
    try { appendJsonl(file, obj); }
    catch (e) { log(`[kiosk] NOT LOGGED to ${path.basename(file)} ${JSON.stringify(obj)}: ${e.message}`); }
  }
  function staffEvent(event, fields = {}) {
    record(staffLog, { event, ...fields, date_created: stamp() });
  }

  const staff = loadStaff(config);
  const kioskPad = createPinPad(staff, {
    onLock: () => {
      log('[kiosk] kiosk PIN pad locked after repeated wrong PINs');
      staffEvent('pin_locked', { where: 'kiosk' });
    },
  });

  const ctrl = createController({
    host: config.SOCKET_IP || '127.0.0.1',
    port: parseInt(config.SOCKET_PORT || '8080', 10),
    log,
    ...controller,
  });

  // ---- orders -------------------------------------------------------------
  const itemsText = (items) => items.map((i) => `${i.slot}:${i.qty}`).join(',');
  const orders = createOrderBook({
    letter,
    timeoutMs,
    onClose: (o) => {
      record(ordersLog, {
        reference: o.reference, items: itemsText(o.items), amount: o.amount,
        status: o.status, reason: o.reason, by: o.by,
        created: stamp(new Date(o.createdAt)), closed: stamp(new Date(o.closedAt)),
      });
      log(`[kiosk] order ${o.number} ${o.status}${o.reason ? ` (${o.reason})` : ''}${o.by ? ` by ${o.by}` : ''}`);
      push();
    },
  });
  // Expiry is decided at request time; this only makes sure the screens hear
  // about it promptly when nobody is asking.
  const expiryTimer = setInterval(() => orders.expireIfDue(), 500);

  function publicOrder(o) {
    if (!o) return null;
    return {
      number: o.number, reference: o.reference, amount: o.amount,
      status: o.status, reason: o.reason, by: o.by,
      items: o.items.map((i) => ({
        slot: i.slot, qty: i.qty, price: i.price,
        name: products[i.slot - 1].name, img: products[i.slot - 1].img,
      })),
      remainingMs: o.status === 'waiting' ? Math.max(0, o.expiresAt - Date.now()) : 0,
      totalMs: o.expiresAt - o.createdAt,
      created: stamp(new Date(o.createdAt)),
      closed: o.closedAt ? stamp(new Date(o.closedAt)) : null,
    };
  }

  // ---- live state to the browser ----------------------------------------
  const streams = new Set();
  // The order being dispensed: what was bought, so the screen can say "1 of
  // 2 dispensed". STATUS only knows what is still owed. Held in memory; after
  // a restart the page rebuilds it from what STATUS still owes.
  let dispenseOrder = null;
  function snapshot() {
    const closed = orders.closed();
    return {
      online: ctrl.online, status: ctrl.status, prices: ctrl.prices,
      order: dispenseOrder,
      pending: publicOrder(orders.current()),
      lastClosed: publicOrder(closed[0] || null),
    };
  }
  function push() {
    const data = `data: ${JSON.stringify(snapshot())}\n\n`;
    for (const res of streams) res.write(data);
  }
  ctrl.on('status', push);
  ctrl.on('online', push);
  ctrl.on('prices', push);

  // ---- helpers ------------------------------------------------------------
  function json(res, code, body) {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  }
  function readBody(req) {
    return new Promise((resolve) => {
      let data = '';
      req.on('data', (c) => {
        data += c;
        if (data.length > 10 * 1024) { data = ''; req.destroy(); }
      });
      req.on('end', () => {
        try { resolve(JSON.parse(data || '{}')); } catch (_) { resolve(null); }
      });
    });
  }
  const validSlot = (s) => Number.isInteger(s) && s >= 1 && s <= SLOTS;
  const machineInUse = () =>
    !ctrl.status || ctrl.status.slots.some((s) => s.armed > 0 || s.busy || s.queued > 0);
  const pinRefusal = (who) => [
    who.reason === 'locked' ? 423 : who.reason === 'no_staff' ? 503 : 401,
    { error: who.reason, retryInMs: who.retryInMs },
  ];

  // Between sending ARM and the STATUS that shows it, the machine still looks
  // free. Without this, a second confirm in that half second arms twice.
  let armingUntil = 0;
  const dispensing = new Set();

  // The price is the controller's, never the page's.
  function priceItems(raw) {
    const items = Array.isArray(raw) ? raw : [];
    if (items.length === 0) return { code: 400, body: { error: 'bad_items' } };
    const seen = new Set();
    for (const it of items) {
      if (!it || !validSlot(it.slot) || seen.has(it.slot)) return { code: 400, body: { error: 'bad_items' } };
      if (!Number.isInteger(it.qty) || it.qty < 1 || it.qty > MAX_QTY) return { code: 400, body: { error: 'bad_items' } };
      seen.add(it.slot);
    }
    const priced = [];
    for (const it of items) {
      if (ctrl.status.slots[it.slot - 1].empty) return { code: 409, body: { error: 'empty', slot: it.slot } };
      const price = ctrl.prices[it.slot];
      if (!Number.isInteger(price)) return { code: 503, body: { error: 'no_prices' } };
      priced.push({ slot: it.slot, qty: it.qty, price });
    }
    return { items: priced, amount: priced.reduce((a, i) => a + i.price * i.qty, 0) };
  }

  // The one way a payment becomes presses. The spec's five checks, in order,
  // stopping at the first failure. Returns [httpCode, body].
  function confirmPaid(o, name, via) {
    orders.expireIfDue();
    if (!o || o.status !== 'waiting') return [409, { error: 'not_waiting', order: publicOrder(o) }];
    if (!ctrl.online) return [503, { error: 'offline' }];
    if (o.items.some((i) => ctrl.status.slots[i.slot - 1].empty)) {
      orders.cancel(o, 'out_of_stock');
      return [409, { error: 'out_of_stock', order: publicOrder(o) }];
    }
    if (o.items.some((i) => ctrl.prices[i.slot] !== i.price)) {
      orders.cancel(o, 'price_changed');
      return [409, { error: 'price_changed', order: publicOrder(o) }];
    }
    if (Date.now() < armingUntil || machineInUse()) return [409, { error: 'machine_busy' }];
    const batch = itemsText(o.items);
    if (!ctrl.send(`ARM_BATCH,${batch}`)) return [503, { error: 'offline' }];
    armingUntil = Date.now() + 3000;
    record(paymentsLog, {
      reference: o.reference, method: 'cash', amount: o.amount, items: batch,
      staff: name, via, date_created: stamp(),
    });
    dispenseOrder = { reference: o.reference, staff: name, items: o.items.map(({ slot, qty }) => ({ slot, qty })) };
    log(`[kiosk] cash ${o.reference} P${o.amount} by ${name} via ${via}: ARM_BATCH,${batch}`);
    orders.paid(o, name);   // onClose pushes the new state to the screens
    return [200, { ok: true, order: publicOrder(o) }];
  }

  // ---- kiosk routes -------------------------------------------------------
  async function createOrder(req, res) {
    const body = await readBody(req);
    if (!body) return json(res, 400, { error: 'bad_request' });
    if (!ctrl.online) return json(res, 503, { error: 'offline' });
    if (Date.now() < armingUntil || machineInUse()) return json(res, 409, { error: 'machine_busy' });
    if (orders.current()) return json(res, 409, { error: 'order_waiting', order: publicOrder(orders.current()) });
    const p = priceItems(body.items);
    if (p.code) return json(res, p.code, p.body);
    if (body.amount !== p.amount) return json(res, 409, { error: 'price_changed', amount: p.amount });
    const o = orders.create(p.items);
    log(`[kiosk] order ${o.number} P${o.amount}: ${itemsText(o.items)}`);
    push();
    json(res, 200, { order: publicOrder(o) });
  }

  async function orderPin(req, res) {
    const body = await readBody(req);
    if (!body) return json(res, 400, { error: 'bad_request' });
    const o = orders.current();
    if (!o || o.number !== body.number) {
      return json(res, 409, { error: 'not_waiting', order: publicOrder(orders.find(body.number)) });
    }
    const who = kioskPad.check(body.pin);
    if (!who.ok) return json(res, ...pinRefusal(who));
    json(res, ...confirmPaid(o, who.name, 'kiosk_pin'));
  }

  async function orderCancel(req, res) {
    const body = await readBody(req);
    const o = orders.current();
    if (!body || !o || o.number !== body.number) return json(res, 409, { error: 'not_waiting' });
    orders.cancel(o, 'customer');
    json(res, 200, { ok: true });
  }

  async function slotCommand(req, res, verb) {
    const body = await readBody(req);
    const slot = body && body.slot;
    if (!validSlot(slot)) return json(res, 400, { error: 'bad_slot' });
    if (!ctrl.online) return json(res, 503, { error: 'offline' });

    if (verb === 'DISPENSE') {
      if (dispensing.has(slot)) return json(res, 409, { error: 'already_dispensing' });
      dispensing.add(slot);
      // One unit per tap, so the customer can count them off and swap
      // bottles between units.
      try {
        return json(res, 200, await dispensePaid(ctrl, slot, { maxPresses: 1 }));
      } finally {
        dispensing.delete(slot);
      }
    }
    json(res, 200, { result: await ctrl.request(`${verb},${slot}`) });
  }

  function stream(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
    streams.add(res);
    // State, not a comment, once a second: the page times out on silence, so
    // a live server must never look silent just because nothing changed.
    const beat = setInterval(() => res.write(`data: ${JSON.stringify(snapshot())}\n\n`), 1000);
    req.on('close', () => { clearInterval(beat); streams.delete(res); });
  }

  function serveStatic(req, res) {
    let rel;
    try { rel = decodeURIComponent(req.url.split('?')[0]); } catch (_) { rel = ''; }
    if (rel === '/') rel = '/index.html';
    const file = path.normalize(path.join(publicDir, rel));
    if (!file.startsWith(publicDir + path.sep)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end('Not found'); }
      const ext = path.extname(file).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        // Revalidate the page itself so a git pull shows on the next load;
        // fonts and images never change under the same name.
        'Cache-Control': /\.(html|css|js)$/.test(ext) ? 'no-cache' : 'max-age=86400',
      });
      res.end(data);
    });
  }

  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (req.method === 'GET' && url === '/api/state') {
      return json(res, 200, { products, idleSeconds, cashReady: staff.length > 0, staffTablet, ...snapshot() });
    }
    if (req.method === 'GET' && url === '/api/stream') return stream(req, res);
    if (req.method === 'POST' && url === '/api/order') return createOrder(req, res);
    if (req.method === 'POST' && url === '/api/order/pin') return orderPin(req, res);
    if (req.method === 'POST' && url === '/api/order/cancel') return orderCancel(req, res);
    if (req.method === 'POST' && url === '/api/dispense') return slotCommand(req, res, 'DISPENSE');
    if (req.method === 'POST' && url === '/api/pause') return slotCommand(req, res, 'PAUSE');
    if (req.method === 'POST' && url === '/api/resume') return slotCommand(req, res, 'RESUME');
    if (req.method === 'GET') return serveStatic(req, res);
    res.writeHead(405); res.end();
  });

  return {
    server,
    ctrl,
    port: parseInt(config.KIOSK_PORT || '3000', 10),
    close() {
      clearInterval(expiryTimer);
      ctrl.close();
      for (const res of streams) res.end();
      server.close();
      server.closeAllConnections();
    },
  };
}

module.exports = { createKioskServer, loadEnv };

if (require.main === module) {
  const k = createKioskServer();
  // Loopback only: the touchscreen is on this Pi, and a server that takes
  // payment confirmations has no business answering the shop LAN.
  k.server.listen(k.port, '127.0.0.1', () =>
    console.log(`[kiosk] listening on http://localhost:${k.port}/`));
}
