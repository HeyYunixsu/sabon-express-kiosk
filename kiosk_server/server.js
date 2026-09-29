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
const { createSessions, tokenFrom, cookieFor, clearCookie, SESSION_MS } = require('./lib/sessions');
const { isLocal, lanAllowed, lanAddress } = require('./lib/access');
const { readJsonl, logPaths, salesToday, openCredits } = require('./lib/logs');

const MAX_QTY = 20;
const MAX_PRICE = 10000;   // the controller's own limit, controller/includes/hardware_config.h
const CREDIT_DAYS = 7;     // how far back Waiting credits looks

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
  const logs = logPaths(config, root);
  // What the controller runs a prime for, clamped as the controller clamps it.
  const primeSeconds = Math.min(15, Math.max(0.5, parseFloat(config.PRIME_SECONDS) || 3));

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
  // A pretend QR Ph payment for demos: the kiosk decides the payment
  // succeeded, which a real shop must never do (CLAUDE.md rule 3).
  const qrDemo = config.QR_DEMO === '1';
  if (qrDemo) log('[kiosk] QR DEMO MODE — QR payments are pretend; switch QR_DEMO off for a real shop');
  const letterRaw = (config.KIOSK_LETTER || '').trim().toUpperCase();
  const letterValid = /^[A-Z]$/.test(letterRaw);
  const letter = letterValid ? letterRaw : 'A';
  if (letterRaw && !letterValid) {
    log(`[kiosk] KIOSK_LETTER "${letterRaw}" is not a single letter A-Z - using A`);
  }
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
  // The tablet has its own pad, so a stranger hammering the tablet cannot
  // lock staff out of the kiosk's PIN fallback, or the other way round.
  const tabletPad = createPinPad(staff, {
    onLock: () => {
      log('[kiosk] tablet PIN pad locked after repeated wrong PINs');
      staffEvent('pin_locked', { where: 'tablet' });
    },
  });
  const sessions = createSessions();
  const port = parseInt(config.KIOSK_PORT || '3000', 10);
  // What the QR on the kiosk points at. Null when neither the tablet nor the
  // QR demo is on, or the Pi has no network, and the kiosk then shows no QR.
  // Recomputed, not fixed at boot: PM2 starts before Wi-Fi DHCP on a Pi, so
  // the address at startup is often not the address a minute later. Cached
  // briefly so it is not an os.networkInterfaces() call on every /api/state
  // and every stream tick.
  const STAFF_BASE_CACHE_MS = 30000;
  let staffBaseCache = { at: 0, value: null };
  function staffBase() {
    if (!staffTablet && !qrDemo) return null;
    const now = Date.now();
    if (now - staffBaseCache.at < STAFF_BASE_CACHE_MS) return staffBaseCache.value;
    const lanIp = lanAddress();
    staffBaseCache = { at: now, value: lanIp ? `http://${lanIp}:${port}` : null };
    return staffBaseCache.value;
  }

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
        reference: o.reference, method: o.method, items: itemsText(o.items), amount: o.amount,
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
      number: o.number, reference: o.reference, amount: o.amount, method: o.method,
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
  // A prime (air clear) makes the controller report that slot busy in STATUS,
  // the same as a paid pour -- there is no field that says "priming". Tracked
  // here so the kiosk page can hide it: slot -> { until, notBusySince }.
  // Cleared once STATUS has shown the slot free for 500ms (debounced so a
  // one-tick blip mid-prime does not end it early), and always by its
  // deadline in case STATUS never shows it free (a wedged nozzle, a missed
  // line).
  const priming = new Map();
  function updatePriming(s) {
    const now = Date.now();
    for (const [slot, p] of priming) {
      const busy = s.slots[slot - 1] && s.slots[slot - 1].busy;
      if (busy) p.notBusySince = null;
      else if (p.notBusySince === null) p.notBusySince = now;
      if (now >= p.until || (p.notBusySince !== null && now - p.notBusySince >= 500)) {
        priming.delete(slot);
      }
    }
  }
  function snapshot() {
    const closed = orders.closed();
    return {
      online: ctrl.online, status: ctrl.status, prices: ctrl.prices,
      order: dispenseOrder,
      pending: publicOrder(orders.current()),
      lastClosed: publicOrder(closed[0] || null),
      staffBase: staffBase(),
      priming: [...priming.keys()].sort((a, b) => a - b),
    };
  }
  function push() {
    const data = `data: ${JSON.stringify(snapshot())}\n\n`;
    for (const res of streams) res.write(data);
  }
  ctrl.on('status', (s) => { updatePriming(s); push(); });
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
    const method = o.method === 'qr' ? 'qr_demo' : 'cash';
    record(paymentsLog, {
      reference: o.reference, method, amount: o.amount, items: batch,
      staff: name, via, date_created: stamp(),
    });
    dispenseOrder = {
      reference: o.reference, staff: o.method === 'qr' ? null : name,
      items: o.items.map(({ slot, qty }) => ({ slot, qty })),
    };
    log(`[kiosk] ${method} ${o.reference} P${o.amount} by ${name} via ${via}: ARM_BATCH,${batch}`);
    orders.paid(o, name);   // onClose pushes the new state to the screens
    return [200, { ok: true, order: publicOrder(o) }];
  }

  // ---- kiosk routes -------------------------------------------------------
  async function createOrder(req, res) {
    const body = await readBody(req);
    if (!body) return json(res, 400, { error: 'bad_request' });
    const method = body.method === undefined ? 'cash' : body.method;
    if (method !== 'cash' && method !== 'qr') return json(res, 400, { error: 'bad_method' });
    if (method === 'qr' && !qrDemo) return json(res, 400, { error: 'qr_off' });
    // The QR points the phone at this Pi's Wi-Fi address; without one there
    // is nothing to scan.
    if (method === 'qr' && !staffBase()) return json(res, 503, { error: 'no_network' });
    if (!ctrl.online) return json(res, 503, { error: 'offline' });
    if (Date.now() < armingUntil || machineInUse()) return json(res, 409, { error: 'machine_busy' });
    if (orders.current()) return json(res, 409, { error: 'order_waiting', order: publicOrder(orders.current()) });
    const p = priceItems(body.items);
    if (p.code) return json(res, p.code, p.body);
    if (body.amount !== p.amount) return json(res, 409, { error: 'price_changed', amount: p.amount });
    const o = orders.create(p.items, method);
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
    if (o.method === 'qr') return json(res, 409, { error: 'qr_order' });
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

  // ---- staff tablet ---------------------------------------------------------
  const isJson = (req) => /^application\/json/i.test(req.headers['content-type'] || '');
  const staffName = (req) => { const s = sessions.get(tokenFrom(req)); return s ? s.name : null; };

  const today = () => stamp().slice(0, 10);
  const onToday = (field) => (r) => String(r[field] || '').startsWith(today());

  // Today's cash and orders, from the logs so they survive a restart.
  function todaySummary() {
    const pays = readJsonl(paymentsLog).filter(onToday('date_created'));
    return {
      paid: pays.length,
      total: pays.reduce((a, p) => a + (Number(p.amount) || 0), 0),
      orders: readJsonl(ordersLog).filter(onToday('closed')).slice(-20).reverse().map((o) => ({
        number: String(o.reference).split('-').slice(1).join('-'),
        amount: Number(o.amount) || 0, status: o.status, reason: o.reason, by: o.by, closed: o.closed,
      })),
    };
  }

  function staffState() {
    return {
      online: ctrl.online,
      machine: !ctrl.online ? 'offline' : machineInUse() ? 'dispensing' : 'ready',
      pending: publicOrder(orders.current()),
      today: todaySummary(),
    };
  }

  // Price changes and give-backs wait for a free machine: no order waiting
  // (its prices are frozen and it may be paid any second), no presses owed,
  // no ARM on its way. Air clear is the exception (owner decision
  // 2026-09-29): a gallon can be swapped mid-sale, so with primeOk it does
  // not refuse on presses merely armed -- only on a nozzle actually pouring
  // (the controller itself refuses a press while priming).
  function toolRefusal({ primeOk = false } = {}) {
    if (!ctrl.online) return [503, { error: 'offline' }];
    if (orders.current()) return [409, { error: 'order_waiting' }];
    if (Date.now() < armingUntil) return [409, { error: 'machine_busy' }];
    if (primeOk) {
      if (!ctrl.status || ctrl.status.slots.some((s) => s.busy || s.queued > 0)) return [409, { error: 'machine_busy' }];
    } else if (machineInUse()) {
      return [409, { error: 'machine_busy' }];
    }
    return null;
  }

  const creditSince = () => stamp(new Date(Date.now() - (CREDIT_DAYS - 1) * 86400000)).slice(0, 10);

  function staffTools() {
    const primesToday = {};
    for (const r of readJsonl(logs.primes).filter(onToday('date_created'))) {
      primesToday[Number(r.slot)] = (primesToday[Number(r.slot)] || 0) + 1;
    }
    const cashByStaff = {};
    for (const p of readJsonl(paymentsLog).filter(onToday('date_created'))) {
      const c = cashByStaff[p.staff] || (cashByStaff[p.staff] = { count: 0, amount: 0 });
      c.count++;
      c.amount += Number(p.amount) || 0;
    }
    const refused = toolRefusal();
    const primeRefused = toolRefusal({ primeOk: true });
    return {
      products: products.map(({ slot, name, img }) => ({ slot, name, img })),
      prices: ctrl.prices,
      priceHistory: readJsonl(logs.prices).slice(-10).reverse().map((r) => ({
        slot: Number(r.slot), from: Number(r.from), to: Number(r.to), date_created: r.date_created,
      })),
      primeSeconds,
      primesToday,
      sales: salesToday(logs, today()),
      cashByStaff,
      credits: openCredits(readJsonl(logs.unclaimed), readJsonl(staffLog), creditSince()),
      attention: readJsonl(logs.interrupted).filter(onToday('date_created')).reverse().map((r) => ({
        slot: Number(r.slot), amount: Number(r.amount) || 0, reason: r.reason, date_created: r.date_created,
      })),
      machine: {
        machineId: config.machineId || '',
        online: ctrl.online,
        staffBase: staffBase(),
        stock: ctrl.status ? ctrl.status.slots.map((s) => ({ slot: s.slot, empty: s.empty })) : [],
      },
      busy: refused ? refused[1].error : null,
      primeBusy: primeRefused ? primeRefused[1].error : null,
    };
  }

  // A controller reply as an HTTP code: accepted, not reachable, or refused.
  const ackCode = (result, accepted) =>
    accepted.includes(result) ? 200 : result === 'offline' || result === 'timeout' ? 503 : 409;

  async function staffSetPrice(req, res, name) {
    if (!isJson(req)) return json(res, 415, { error: 'json_only' });
    const body = await readBody(req);
    const slot = body && body.slot;
    const price = body && body.price;
    if (!validSlot(slot) || !Number.isInteger(price) || price < 1 || price > MAX_PRICE) {
      return json(res, 400, { error: 'bad_price' });
    }
    const refused = toolRefusal();
    if (refused) return json(res, ...refused);
    if (!Number.isInteger(ctrl.prices[slot])) return json(res, 503, { error: 'no_prices' });
    const from = ctrl.prices[slot];
    const result = await ctrl.request(`SETPRICE,${slot},${price}`);
    if (result === 'ok' || result === 'not_saved') {
      // The controller does not broadcast a change: ask, so the kiosk's
      // screens and the next order use the new price.
      ctrl.send('GETPRICES');
      staffEvent('price_change', { staff: name, slot, from, to: price, result });
      log(`[kiosk] price slot ${slot} ${from} -> ${price} by ${name} (${result})`);
    }
    json(res, ackCode(result, ['ok', 'not_saved']), { result });
  }

  async function staffPrime(req, res, name) {
    if (!isJson(req)) return json(res, 415, { error: 'json_only' });
    const body = await readBody(req);
    const slot = body && body.slot;
    if (!validSlot(slot)) return json(res, 400, { error: 'bad_slot' });
    // The page first asks "Put a cup under nozzle N"; a POST without that
    // answer does not run a pump.
    if (body.confirm !== true) return json(res, 400, { error: 'not_confirmed' });
    const refused = toolRefusal({ primeOk: true });
    if (refused) return json(res, ...refused);
    // Marked before sending: the controller broadcasts the busy STATUS right
    // after PRIME_ACK, often in the same TCP read, so a mark set after the
    // await would let one update show the kiosk a "pour".
    priming.set(slot, { until: Date.now() + primeSeconds * 1000 + 3000, notBusySince: null });
    const result = await ctrl.request(`PRIME,${slot}`);
    if (result !== 'started') priming.delete(slot);
    push();
    staffEvent('prime', { staff: name, slot, result });
    log(`[kiosk] prime slot ${slot} by ${name}: ${result}`);
    json(res, ackCode(result, ['started']), { result });
  }

  // Paid presses that were never poured. Give back re-arms exactly those
  // presses, so the kiosk opens the dispense screen for the customer; write
  // off closes the entry. Either way it is settled once, under a name.
  async function staffCredit(req, res, name, action) {
    if (!isJson(req)) return json(res, 415, { error: 'json_only' });
    const body = await readBody(req);
    const id = body && body.id;
    const c = openCredits(readJsonl(logs.unclaimed), readJsonl(staffLog), creditSince()).find((x) => x.id === id);
    if (!c) return json(res, 409, { error: 'not_open' });
    const fields = { staff: name, credit: c.id, slot: c.slot, qty: c.qty, amount: c.amount };
    if (action === 'write_off') {
      staffEvent('credit_write_off', fields);
      log(`[kiosk] credit ${c.id} written off by ${name}`);
      return json(res, 200, { ok: true });
    }
    const refused = toolRefusal();
    if (refused) return json(res, ...refused);
    if (ctrl.status.slots[c.slot - 1].empty) return json(res, 409, { error: 'slot_empty' });
    if (!Number.isInteger(ctrl.prices[c.slot])) return json(res, 503, { error: 'no_prices' });
    // The controller books a press at the price when it pours, not the price
    // at credit time: re-arming after a price change would book the cloud a
    // different amount than the cash that was actually taken.
    if (c.amount !== c.qty * ctrl.prices[c.slot]) return json(res, 409, { error: 'price_changed' });
    if (!ctrl.send(`ARM,${c.slot},${c.qty}`)) return json(res, 503, { error: 'offline' });
    armingUntil = Date.now() + 3000;
    dispenseOrder = { reference: `credit ${c.id}`, staff: name, items: [{ slot: c.slot, qty: c.qty }] };
    staffEvent('credit_give_back', fields);
    log(`[kiosk] credit ${c.id} given back by ${name}: ARM,${c.slot},${c.qty}`);
    push();
    json(res, 200, { ok: true });
  }

  async function staffLogin(req, res) {
    if (!isJson(req)) return json(res, 415, { error: 'json_only' });
    const body = await readBody(req);
    const who = tabletPad.check(body && body.pin);
    if (!who.ok) return json(res, ...pinRefusal(who));
    const token = sessions.create(who.name);
    staffEvent('sign_in', { staff: who.name });
    res.setHeader('Set-Cookie', cookieFor(token, SESSION_MS));
    json(res, 200, { name: who.name });
  }

  function staffLogout(req, res) {
    const token = tokenFrom(req);
    const s = sessions.get(token);
    if (s) staffEvent('sign_out', { staff: s.name });
    sessions.destroy(token);
    res.setHeader('Set-Cookie', clearCookie());
    json(res, 200, { ok: true });
  }

  async function staffOrderAction(req, res, name, action) {
    if (!isJson(req)) return json(res, 415, { error: 'json_only' });
    const body = await readBody(req);
    const number = body && body.number;
    const o = orders.current();
    if (!o || o.number !== number) {
      return json(res, 409, { error: 'not_waiting', order: publicOrder(orders.find(number)) });
    }
    if (action === 'cancel') {
      orders.cancel(o, 'staff', name);
      return json(res, 200, { ok: true, order: publicOrder(o) });
    }
    if (o.method === 'qr') return json(res, 409, { error: 'qr_order' });
    json(res, ...confirmPaid(o, name, 'tablet'));
  }

  // ---- QR payment demo: the phone that "pays" ---------------------------------
  // Only a waiting QR order can be paid here, through the same five checks as
  // cash. Nothing at all answers when QR_DEMO is off.
  async function payConfirm(req, res) {
    if (!isJson(req)) return json(res, 415, { error: 'json_only' });
    const body = await readBody(req);
    const number = body && body.number;
    const o = orders.current();
    if (!o || o.number !== number) {
      const known = orders.find(number);
      return json(res, 409, { error: 'not_waiting', order: known && known.method === 'qr' ? publicOrder(known) : null });
    }
    if (o.method !== 'qr') return json(res, 409, { error: 'not_qr' });
    json(res, ...confirmPaid(o, 'QR demo', 'phone'));
  }

  function payRoutes(req, res, url) {
    if (!qrDemo) { res.writeHead(404); return res.end('Not found'); }
    if (req.method === 'GET' && /^\/pay\/[A-Z]-\d+$/.test(url)) {
      return servePage(res, path.join(publicDir, 'pay', 'index.html'));
    }
    if (req.method === 'GET' && url === '/pay/api/order') {
      const o = orders.find(new URL(req.url, 'http://kiosk').searchParams.get('number'));
      return o && o.method === 'qr' ? json(res, 200, { order: publicOrder(o) }) : json(res, 404, { error: 'unknown_order' });
    }
    if (req.method === 'POST' && url === '/pay/api/confirm') return payConfirm(req, res);
    if (req.method === 'GET') return serveStatic(req, res);   // /pay/pay.css, /pay/pay.js
    res.writeHead(405); res.end();
  }

  function servePage(res, file) {
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
      res.end(data);
    });
  }

  function staffRoutes(req, res, url) {
    if (req.method === 'GET' && (url === '/staff' || url === '/staff/' || /^\/staff\/order\/[A-Z]-\d+$/.test(url))) {
      return servePage(res, path.join(publicDir, 'staff', 'index.html'));
    }
    if (req.method === 'POST' && url === '/staff/api/login') return staffLogin(req, res);
    if (req.method === 'POST' && url === '/staff/api/logout') return staffLogout(req, res);
    if (url.startsWith('/staff/api/')) {
      const name = staffName(req);
      if (!name) return json(res, 401, { error: 'signed_out' });
      if (req.method === 'GET' && url === '/staff/api/me') return json(res, 200, { name });
      if (req.method === 'GET' && url === '/staff/api/state') return json(res, 200, staffState());
      if (req.method === 'GET' && url === '/staff/api/tools') return json(res, 200, staffTools());
      if (req.method === 'POST' && url === '/staff/api/price') return staffSetPrice(req, res, name);
      if (req.method === 'POST' && url === '/staff/api/prime') return staffPrime(req, res, name);
      if (req.method === 'POST' && url === '/staff/api/credits/give-back') return staffCredit(req, res, name, 'give_back');
      if (req.method === 'POST' && url === '/staff/api/credits/write-off') return staffCredit(req, res, name, 'write_off');
      if (req.method === 'GET' && url === '/staff/api/order') {
        const number = new URL(req.url, 'http://kiosk').searchParams.get('number');
        const o = orders.find(number);
        return o ? json(res, 200, { order: publicOrder(o) }) : json(res, 404, { error: 'unknown_order' });
      }
      if (req.method === 'POST' && url === '/staff/api/orders/paid') return staffOrderAction(req, res, name, 'paid');
      if (req.method === 'POST' && url === '/staff/api/orders/cancel') return staffOrderAction(req, res, name, 'cancel');
      return json(res, 404, { error: 'unknown' });
    }
    if (req.method === 'GET') return serveStatic(req, res);   // /staff/staff.css, /staff/staff.js
    res.writeHead(405); res.end();
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
    // From the shop Wi-Fi, the staff page and its pictures only. Everything
    // that orders, unlocks or pours answers the Pi itself and nobody else.
    if (!isLocal(req) && !lanAllowed(url, { pay: qrDemo })) { res.writeHead(403); return res.end('Forbidden'); }
    if (url === '/pay' || url.startsWith('/pay/')) return payRoutes(req, res, url);
    if (url === '/staff' || url.startsWith('/staff/')) return staffRoutes(req, res, url);
    if (req.method === 'GET' && url === '/api/state') {
      return json(res, 200, {
        products, idleSeconds, cashReady: staff.length > 0, staffTablet, qrDemo, ...snapshot(),
      });
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
    port,
    // The shop Wi-Fi only when the tablet or the QR demo is on.
    host: staffTablet || qrDemo ? '0.0.0.0' : '127.0.0.1',
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
  k.server.listen(k.port, k.host, () =>
    console.log(`[kiosk] listening on http://localhost:${k.port}/`
      + (k.host === '0.0.0.0' ? '  (also on the shop Wi-Fi: /staff, /pay)' : '')));
}
