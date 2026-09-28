'use strict';
// Who may reach what. The customer screens and every action that orders,
// unlocks or pours answer only the Pi itself; a phone on the shop Wi-Fi may
// reach the staff page and the pictures and fonts it draws with.

const os = require('os');

const LOCAL = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function isLocal(req) {
  return LOCAL.has(req.socket && req.socket.remoteAddress);
}

// Matched on the raw URL, before any decoding: a dot-dot or an escape is
// refused outright rather than trusted to normalise somewhere safe.
function lanAllowed(url) {
  if (url.includes('..') || url.includes('%')) return false;
  return url === '/staff' || url.startsWith('/staff/')
      || url.startsWith('/img/') || url.startsWith('/fonts/');
}

// The address a tablet on the shop Wi-Fi uses to reach this Pi.
function lanAddress(ifaces = os.networkInterfaces()) {
  for (const list of Object.values(ifaces)) {
    for (const a of list || []) {
      if ((a.family === 'IPv4' || a.family === 4) && !a.internal) return a.address;
    }
  }
  return null;
}

module.exports = { isLocal, lanAllowed, lanAddress };
