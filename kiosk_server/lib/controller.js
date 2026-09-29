'use strict';
// The kiosk server's line to the controller on TCP 8080.
//
// Liveness comes from STATUS lines, never from the socket. A socket can sit
// open to a hung controller, and the controller broadcasts STATUS about twice
// a second, so silence for offlineMs is what "offline" means here.

const net = require('net');
const { EventEmitter } = require('events');

const SLOTS = 6;
const STATUS_FIELDS = 5 * SLOTS + 4;

// "STATUS", armed1-6, remainingMs1-6, empty1-6, busy1-6, queued1-6,
// paused, phase, bundleComplete. Returns null for anything else, so a torn or
// future-format line is dropped rather than read as zeros.
function parseStatus(line) {
  const f = line.trim().split(',');
  if (f[0] !== 'STATUS' || f.length !== STATUS_FIELDS) return null;
  const n = f.map(Number);
  if (n.some((v, i) => i > 0 && !Number.isFinite(v))) return null;
  const slots = [];
  for (let i = 0; i < SLOTS; i++) {
    slots.push({
      slot: i + 1,
      armed: n[1 + i],
      remainingMs: n[1 + SLOTS + i],
      empty: n[1 + 2 * SLOTS + i] === 1,
      busy: n[1 + 3 * SLOTS + i] === 1,
      queued: n[1 + 4 * SLOTS + i],
    });
  }
  return { slots, paused: n[31] === 1, phase: n[32], bundleComplete: n[33] === 1 };
}

function parsePrices(line) {
  const p = line.trim().split(',');
  const prices = {};
  for (let i = 1; i < p.length; i++) {
    const v = parseInt(p[i], 10);
    if (Number.isFinite(v)) prices[i] = v;
  }
  return prices;
}

function createController({ host = '127.0.0.1', port = 8080, offlineMs = 6000,
                            reconnectMs = 3000, ackTimeoutMs = 2000,
                            log = console.log } = {}) {
  const ev = new EventEmitter();
  let socket = null;
  let connected = false;
  let buffer = '';
  let lastStatusAt = 0;
  let online = false;
  let closed = false;
  let status = null;
  let prices = {};
  const waiting = [];          // { verb, slot, resolve, timer }
  let chain = Promise.resolve();

  function setOnline(next) {
    if (next === online) return;
    online = next;
    log(`[kiosk] controller ${online ? 'online' : 'OFFLINE'}`);
    ev.emit('online', online);
  }

  function onLine(line) {
    if (line.startsWith('STATUS')) {
      const s = parseStatus(line);
      if (!s) return;
      status = s;
      lastStatusAt = Date.now();
      setOnline(true);
      ev.emit('status', s);
    } else if (line.startsWith('PRICES,')) {
      prices = parsePrices(line);
      ev.emit('prices', prices);
    } else if (/^[A-Z]+_ACK,/.test(line)) {
      const [verbAck, slot, result] = line.trim().split(',');
      const verb = verbAck.slice(0, -4);
      const i = waiting.findIndex((w) => w.verb === verb && w.slot === Number(slot));
      if (i === -1) return;
      const [w] = waiting.splice(i, 1);
      clearTimeout(w.timer);
      w.resolve(result);
    }
  }

  function connect() {
    if (closed) return;
    socket = new net.Socket();
    socket.connect(port, host, () => {
      connected = true;
      log(`[kiosk] connected to controller ${host}:${port}`);
      send('GETPRICES');
    });
    socket.on('data', (d) => {
      buffer += d.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();
      lines.forEach(onLine);
      if (buffer.length > 64 * 1024) buffer = '';
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      connected = false;
      buffer = '';
      socket = null;
      setOnline(false);
      for (const w of waiting.splice(0)) { clearTimeout(w.timer); w.resolve('offline'); }
      if (!closed) setTimeout(connect, reconnectMs);
    });
  }

  // Never queued. A command held for a reconnect could arm or pour hours
  // later with nobody at the machine; the caller refuses instead.
  function send(cmd) {
    if (!connected || !socket) return false;
    socket.write(cmd + '\n');
    return true;
  }

  // The controller answers most VERB with VERB_ACK; SETPRICE is the exception.
  const ACK_VERB = { SETPRICE: 'PRICE' };

  // Sends VERB,<slot>[,…] and resolves with the result field of VERB_ACK for
  // that slot, or 'offline' / 'timeout'. One request at a time, so an ACK can
  // never be matched to the wrong command.
  function request(cmd) {
    const [cmdVerb, slotStr] = cmd.split(',');
    const verb = ACK_VERB[cmdVerb] || cmdVerb;
    const slot = Number(slotStr);
    const run = () => new Promise((resolve) => {
      if (!online || !send(cmd)) return resolve('offline');
      const w = { verb, slot, resolve };
      w.timer = setTimeout(() => {
        waiting.splice(waiting.indexOf(w), 1);
        resolve('timeout');
      }, ackTimeoutMs);
      waiting.push(w);
    });
    const p = chain.then(run);
    chain = p.catch(() => {});
    return p;
  }

  const ticker = setInterval(() => {
    if (online && Date.now() - lastStatusAt > offlineMs) setOnline(false);
  }, Math.min(1000, offlineMs / 2));

  connect();

  // defineProperties, not Object.assign: assign copies a getter's value once,
  // which would freeze online/status/prices at their starting values.
  Object.defineProperties(ev, {
    online: { get: () => online },
    status: { get: () => status },
    prices: { get: () => prices },
  });
  ev.send = send;
  ev.request = request;
  ev.close = () => {
    closed = true;
    clearInterval(ticker);
    if (socket) socket.destroy();
  };
  return ev;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Starts every paid press on a slot as one continuous pour.
//
// A DISPENSE on a pump that is already running extends it by one press, so
// sending one per paid press pours the whole measure. The controller refuses
// a second pump start inside its cooldown (200 ms by default), so each press
// waits a little longer than that and a 'cooldown' reply is simply retried.
// 'no_credit' after at least one accepted press means every paid press has
// started, which is success.
async function dispensePaid(ctrl, slot, { gapMs = 250, maxPresses = 50, maxRetries = 20 } = {}) {
  let poured = 0;
  let retries = 0;
  while (poured < maxPresses) {
    const r = await ctrl.request(`DISPENSE,${slot}`);
    if (r === 'ok') { poured++; retries = 0; await sleep(gapMs); continue; }
    if (r === 'cooldown' && retries < maxRetries) { retries++; await sleep(gapMs); continue; }
    if (poured > 0 && (r === 'no_credit' || r === 'slot_paused')) return { result: 'ok', poured };
    return { result: r, poured };
  }
  return { result: 'ok', poured };
}

module.exports = { createController, dispensePaid, parseStatus, parsePrices, SLOTS };
