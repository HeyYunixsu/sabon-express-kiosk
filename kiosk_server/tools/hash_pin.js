#!/usr/bin/env node
// Prints the STAFFn_PIN_HASH value for a PIN, to paste into CONFIG/config.env.
//   node kiosk_server/tools/hash_pin.js 4821
'use strict';
const { hashPin } = require('../lib/staff');

const pin = process.argv[2];
if (!/^\d{4,8}$/.test(pin || '')) {
  console.error('Usage: node hash_pin.js <PIN>   (4 to 8 digits)');
  process.exit(1);
}
console.log(hashPin(pin));
