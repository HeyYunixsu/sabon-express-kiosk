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
// refused outright rather than trusted to normalise somewhere safe. /staff
// is added only when the staff tablet is on, /pay only when the QR demo is
// on; /img and /fonts always, since both pages draw from them.
function lanAllowed(url, { staff = false, pay = false } = {}) {
  if (url.includes('..') || url.includes('%')) return false;
  return url.startsWith('/img/') || url.startsWith('/fonts/')
      || (staff && (url === '/staff' || url.startsWith('/staff/')))
      || (pay && url.startsWith('/pay/'));
}

// The address a tablet on the shop Wi-Fi uses to reach this Pi. Link-local
// addresses (169.254.x.x, assigned when DHCP has not answered yet) are
// skipped: no phone on the shop Wi-Fi can reach one.
function lanAddress(ifaces = os.networkInterfaces()) {
  for (const list of Object.values(ifaces)) {
    for (const a of list || []) {
      if ((a.family === 'IPv4' || a.family === 4) && !a.internal && !a.address.startsWith('169.254.')) {
        return a.address;
      }
    }
  }
  return null;
}

module.exports = { isLocal, lanAllowed, lanAddress };
