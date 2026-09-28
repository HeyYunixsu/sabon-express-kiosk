'use strict';
// Staff sign-in sessions for the tablet page.
//
// Held in memory, so a server restart signs everyone out -- which is the
// intended behaviour, not a limitation. The token is 32 random bytes; the
// cookie cannot be read by scripts or sent by another site.

const crypto = require('crypto');

const COOKIE = 'sabon_staff';
const SESSION_MS = 12 * 3600 * 1000;

function createSessions({ ttlMs = SESSION_MS, now = Date.now } = {}) {
  const byToken = new Map();
  return {
    create(name) {
      const token = crypto.randomBytes(32).toString('hex');
      byToken.set(token, { name, expiresAt: now() + ttlMs });
      return token;
    },
    get(token) {
      if (!token) return null;
      const s = byToken.get(token);
      if (!s) return null;
      if (now() >= s.expiresAt) { byToken.delete(token); return null; }
      return s;
    },
    destroy(token) { byToken.delete(token); },
  };
}

function tokenFrom(req) {
  const header = (req.headers && req.headers.cookie) || '';
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq !== -1 && part.slice(0, eq).trim() === COOKIE) return part.slice(eq + 1).trim();
  }
  return null;
}

const cookieFor = (token, ttlMs) =>
  `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/staff; Max-Age=${Math.floor(ttlMs / 1000)}`;
const clearCookie = () => `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/staff; Max-Age=0`;

module.exports = { createSessions, tokenFrom, cookieFor, clearCookie, SESSION_MS, COOKIE };
