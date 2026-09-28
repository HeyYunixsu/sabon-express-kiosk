'use strict';
// Sabon Express Kiosk server.
//
// Serves the touchscreen UI and stands between it and the controller. The
// browser never talks to the controller directly: it sees parsed state over
// /api/stream and asks for actions over POST, and this process decides what
// is allowed -- above all, what a cash sale costs and whether a staff PIN
// really confirmed it.
//
// Node standard library only, so a Pi needs no npm install for it.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { createController, dispensePaid, SLOTS } = require('./lib/controller');
const { loadStaff, createPinPad } = require('./lib/staff');

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

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
       + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function appendJsonl(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(obj) + '\n', 'utf-8');
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
  log = console.log,
} = {}) {
  const config = loadEnv(configPath);
  const publicDir = path.join(__dirname, 'public');
  const paymentsLog = path.join(logsDir, 'payments.jsonl');
  const lockoutLog = path.join(logsDir, 'pin_lockouts.jsonl');

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

  const staff = loadStaff(config);
  const pinPad = createPinPad(staff, {
    onLock: () => {
      log('[kiosk] PIN pad locked after repeated wrong PINs');
      try { appendJsonl(lockoutLog, { event: 'pin_locked', date_created: stamp() }); }
      catch (e) { log(`[kiosk] could not log lockout: ${e.message}`); }
    },
  });

  const ctrl = createController({
    host: config.SOCKET_IP || '127.0.0.1',
    port: parseInt(config.SOCKET_PORT || '8080', 10),
    log,
    ...controller,
  });

  // ---- live state to the browser ----------------------------------------
  const streams = new Set();
  function snapshot() {
    return { online: ctrl.online, status: ctrl.status, prices: ctrl.prices };
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

  // Between sending ARM and the STATUS that shows it, the machine still looks
  // free. Without this, a second confirm in that half second arms twice.
  let armingUntil = 0;
  const dispensing = new Set();

  // ---- routes ---------------------------------------------------------------
  async function cash(req, res) {
    const body = await readBody(req);
    if (!body) return json(res, 400, { error: 'bad_request' });
    if (!ctrl.online) return json(res, 503, { error: 'offline' });
    if (Date.now() < armingUntil || machineInUse()) return json(res, 409, { error: 'machine_busy' });

    const items = Array.isArray(body.items) ? body.items : [];
    const seen = new Set();
    for (const it of items) {
      if (!validSlot(it.slot) || seen.has(it.slot)) return json(res, 400, { error: 'bad_items' });
      if (!Number.isInteger(it.qty) || it.qty < 1 || it.qty > MAX_QTY) return json(res, 400, { error: 'bad_items' });
      seen.add(it.slot);
    }
    if (items.length === 0) return json(res, 400, { error: 'bad_items' });

    // The price is the controller's, never the page's. The customer is asked
    // for what the page showed, so if the two differ the sale stops here
    // rather than charging one figure and recording another.
    let amount = 0;
    for (const it of items) {
      if (ctrl.status.slots[it.slot - 1].empty) return json(res, 409, { error: 'empty', slot: it.slot });
      const price = ctrl.prices[it.slot];
      if (!Number.isInteger(price)) return json(res, 503, { error: 'no_prices' });
      amount += price * it.qty;
    }
    if (body.amount !== amount) return json(res, 409, { error: 'price_changed', amount });

    const who = pinPad.check(body.pin);
    if (!who.ok) {
      const code = who.reason === 'locked' ? 423 : who.reason === 'no_staff' ? 503 : 401;
      return json(res, code, { error: who.reason, retryInMs: who.retryInMs });
    }

    const batch = items.map((it) => `${it.slot}:${it.qty}`).join(',');
    if (!ctrl.send(`ARM_BATCH,${batch}`)) return json(res, 503, { error: 'offline' });
    armingUntil = Date.now() + 3000;

    const record = {
      reference: 'K-' + Date.now().toString(36).toUpperCase(),
      method: 'cash',
      amount,
      staff: who.name,
      items: batch,
      date_created: stamp(),
    };
    // The presses are already granted, so a log failure must not undo the
    // sale in front of the customer -- but it must be loud.
    try { appendJsonl(paymentsLog, record); }
    catch (e) { log(`[kiosk] PAYMENT NOT LOGGED ${JSON.stringify(record)}: ${e.message}`); }
    log(`[kiosk] cash ${record.reference} P${amount} by ${who.name}: ARM_BATCH,${batch}`);
    json(res, 200, { ok: true, reference: record.reference, staff: who.name, amount });
  }

  async function slotCommand(req, res, verb) {
    const body = await readBody(req);
    const slot = body && body.slot;
    if (!validSlot(slot)) return json(res, 400, { error: 'bad_slot' });
    if (!ctrl.online) return json(res, 503, { error: 'offline' });

    if (verb === 'DISPENSE') {
      if (dispensing.has(slot)) return json(res, 409, { error: 'already_dispensing' });
      dispensing.add(slot);
      try {
        return json(res, 200, await dispensePaid(ctrl, slot));
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
    if (req.method === 'GET' && url === '/api/state')
      return json(res, 200, { products, idleSeconds, cashReady: staff.length > 0, ...snapshot() });
    if (req.method === 'GET' && url === '/api/stream') return stream(req, res);
    if (req.method === 'POST' && url === '/api/cash') return cash(req, res);
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
