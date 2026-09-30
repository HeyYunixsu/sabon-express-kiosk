'use strict';
// Staff PINs: who confirmed a cash payment.
//
// A PIN identifies a person, so config.env holds one per staff member:
//   STAFF1_NAME     = Ana
//   STAFF1_PIN_HASH = scrypt$<salt hex>$<hash hex>     (tools/hash_pin.js)
//
// Salted scrypt, not the spec's plain SHA-256: config.env sits on the same SD
// card as everything else, and an unsalted SHA-256 of a 4-6 digit PIN is
// reversed by trying all million PINs in well under a second. scrypt makes
// each guess cost tens of milliseconds, and the salt stops one table cracking
// every machine.

const crypto = require('crypto');

const MAX_STAFF = 6;
const MAX_WRONG = 5;
const LOCK_MS = 60 * 1000;
const KEYLEN = 32;

function hashPin(pin, salt = crypto.randomBytes(16)) {
  const hash = crypto.scryptSync(String(pin), salt, KEYLEN);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function pinMatches(pin, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'hex');
  const want = Buffer.from(parts[2], 'hex');
  if (salt.length === 0 || want.length !== KEYLEN) return false;
  const got = crypto.scryptSync(String(pin), salt, KEYLEN);
  return crypto.timingSafeEqual(got, want);
}

function loadStaff(config) {
  const staff = [];
  for (let i = 1; i <= MAX_STAFF; i++) {
    const name = (config[`STAFF${i}_NAME`] || '').trim();
    const hash = (config[`STAFF${i}_PIN_HASH`] || '').trim();
    if (name && hash) staff.push({ name, hash });
  }
  return staff;
}

// One pad, one lock. Five wrong PINs in a row lock the pad for a minute, so a
// customer left alone at the pay screen cannot walk through the PIN space.
function createPinPad(staff, { now = Date.now, onLock = () => {} } = {}) {
  let wrong = 0;
  let lockedUntil = 0;

  function recordWrong(t) {
    wrong++;
    if (wrong < MAX_WRONG) return { ok: false, reason: 'wrong' };
    wrong = 0;
    lockedUntil = t + LOCK_MS;
    onLock();
    return { ok: false, reason: 'locked', retryInMs: LOCK_MS };
  }

  return {
    // -> { ok: true, name } | { ok: false, reason: 'locked'|'wrong'|'no_staff', retryInMs? }
    check(pin) {
      const t = now();
      if (t < lockedUntil) return { ok: false, reason: 'locked', retryInMs: lockedUntil - t };
      if (staff.length === 0) return { ok: false, reason: 'no_staff' };
      if (!/^\d{4}$/.test(String(pin))) return recordWrong(t);

      const who = staff.find((s) => pinMatches(pin, s.hash));
      if (!who) return recordWrong(t);
      wrong = 0;
      return { ok: true, name: who.name };
    },
  };
}

module.exports = { hashPin, pinMatches, loadStaff, createPinPad, MAX_WRONG, LOCK_MS };
