'use strict';
// The order book: at most one order waiting for payment at a time.
//
// An order is created when the customer chooses Cash, priced by the caller
// from the controller, and frozen. It then ends exactly once -- paid, expired
// or cancelled -- and onClose is told, so the server can log it and update
// the screens. Nothing here talks to the controller or the disk, so the whole
// lifecycle is tested with a fake clock.

const { dayKey } = require('./records');

function createOrderBook({ letter = 'A', timeoutMs = 180000, now = Date.now, onClose = () => {} } = {}) {
  let day = '';
  let count = 0;
  let waiting = null;
  const closed = [];           // today's closed orders, newest first

  function nextNumber() {
    const d = dayKey(new Date(now()));
    if (d !== day) { day = d; count = 0; closed.length = 0; }
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
    create(items) {
      expireIfDue();
      if (waiting) return null;
      const { number, reference } = nextNumber();
      const frozen = items.map(({ slot, qty, price }) => ({ slot, qty, price }));
      const t = now();
      waiting = {
        number, reference, items: frozen,
        amount: frozen.reduce((a, i) => a + i.price * i.qty, 0),
        status: 'waiting', reason: null, by: null,
        createdAt: t, expiresAt: t + timeoutMs, closedAt: null,
      };
      return waiting;
    },
    current() { expireIfDue(); return waiting; },
    find(number) {
      expireIfDue();
      if (waiting && waiting.number === number) return waiting;
      return closed.find((o) => o.number === number) || null;
    },
    paid(o, by) { if (o.status === 'waiting') close(o, 'paid', null, by); },
    cancel(o, reason, by = null) { if (o.status === 'waiting') close(o, 'cancelled', reason, by); },
    expireIfDue,
    closed() { expireIfDue(); return closed.slice(); },
  };
}

module.exports = { createOrderBook };
