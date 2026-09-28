'use strict';
// Local records: one JSON object per line, appended. Shared by the server and
// the order book so every log uses the same date format.

const fs = require('fs');
const path = require('path');

const pad = (n) => String(n).padStart(2, '0');

function stamp(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
       + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// The day part of an order reference, local time: 20260928.
function dayKey(d = new Date()) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

function appendJsonl(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(obj) + '\n', 'utf-8');
}

module.exports = { stamp, dayKey, appendJsonl };
