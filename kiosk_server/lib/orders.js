'use strict';
// The order book: at most one order waiting for payment at a time.
//
// An order is created when the customer chooses Cash or (in the QR demo) QR
// Ph, priced by the caller from the controller, and frozen. It then ends
// exactly once -- paid, expired or cancelled -- and onClose is told, so the
// server can log it and update the screens. Nothing here talks to the
// controller or the disk, so the whole lifecycle is tested with a fake clock.

const { dayKey } = require('./records');

function createOrderBook({ letter = 'A', timeoutMs = 180000, now = Date.now, onClose = () => {}, lastNumber = () => 0 } = {}) {
  let day = '';
  let count = 0;
  let waiting = null;
  const closed = [];           // today's closed orders, newest first

  // A new day starts a new count and a new list, whether or not anyone has
  // ordered yet -- the staff tablet asks for "today" all night.
  function rollDay() {
    const d = dayKey(new Date(now()));
    // The highest number already used on day d (0 if none), so a restart
    // carries on the day's numbering.
    if (d !== day) { day = d; count = lastNumber(d); closed.length = 0; }
    return d;
  }

  function nextNumber() {
    const d = rollDay();
    count++;
    return { number: `${letter}-${count}`, reference: `${d}-${letter}-${count}` };
  }

  function close(o, status, reason, by) {
    o.status = status;
    o.reason = reason;
    o.by = by;
    o.closedAt = now();
    if (waiting === o) waiting = null;
    closed.unshift(o);
    if (closed.length > 50) closed.pop();
    onClose(o);
  }

  // Expiry is decided by the clock at the moment anyone asks, not by a timer
  // firing: at exactly timeoutMs the order is over.
  function expireIfDue() {
    if (waiting && now() >= waiting.expiresAt) close(waiting, 'expired', 'timeout', null);
  }

  return {
    create(items, method = 'cash') {
      expireIfDue();
      if (waiting) return null;
      const { number, reference } = nextNumber();
      const frozen = items.map(({ slot, qty, price }) => ({ slot, qty, price }));
      const t = now();
      waiting = {
        number, reference, items: frozen, method,
        amount: frozen.reduce((a, i) => a + i.price * i.qty, 0),
        status: 'waiting', reason: null, by: null,
        createdAt: t, expiresAt: t + timeoutMs, closedAt: null,
      };
      return waiting;
    },
    current() { expireIfDue(); return waiting; },
    find(number) {
      rollDay();
      expireIfDue();
      if (waiting && waiting.number === number) return waiting;
      return closed.find((o) => o.number === number) || null;
    },
    paid(o, by) { if (o.status === 'waiting') close(o, 'paid', null, by); },
    cancel(o, reason, by = null) { if (o.status === 'waiting') close(o, 'cancelled', reason, by); },
    expireIfDue,
    closed() { rollDay(); expireIfDue(); return closed.slice(); },
  };
}

module.exports = { createOrderBook };
