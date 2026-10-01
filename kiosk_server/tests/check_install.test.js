'use strict';
// check_install.sh's config and sales checks, run with bash against a
// config.env in a temp folder. The Pi-only checks are off (CHECK_INSTALL_PI=0).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', '..', 'check_install.sh');
// On Windows, `bash` on the PATH can be WSL's; Git's bash runs the script.
const GIT_BASH = 'C:/Program Files/Git/bin/bash.exe';
const BASH = process.platform === 'win32' && fs.existsSync(GIT_BASH) ? GIT_BASH : 'bash';
const UUID = '0a1b2c3d-1111-2222-3333-444455556666';
const GOOD = [
  'machineId=24', `vendorId=${UUID}`, 'API_BASE_URL = https://api.example.test',
  'STAFF1_NAME = Ana', 'STAFF1_PIN_HASH = scrypt$aa$bb', 'QR_DEMO = 0',
];

// lines: config.env lines, or null for no config.env. sales: minutes ago, one
// waiting sale file each.
function run(lines, sales = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'check-install-'));
  fs.mkdirSync(path.join(root, 'CONFIG'));
  if (lines) fs.writeFileSync(path.join(root, 'CONFIG', 'config.env'), lines.join('\n') + '\n');
  if (sales.length) {
    fs.mkdirSync(path.join(root, 'transaction'));
    sales.forEach((min, i) => {
      const at = Math.floor(Date.now() / 1000) - min * 60;
      fs.writeFileSync(path.join(root, 'transaction', `${at}_transaction_1_${i}.json`), '{}');
    });
  }
  const r = spawnSync(BASH, [SCRIPT], {
    env: { ...process.env, KIOSK_ROOT: root.replace(/\\/g, '/'), CHECK_INSTALL_PI: '0' },
    encoding: 'utf8',
  });
  fs.rmSync(root, { recursive: true, force: true });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

test('a good config: all good, exit 0, Pi checks skipped', () => {
  const { code, out } = run(GOOD);
  assert.strictEqual(code, 0, out);
  assert.match(out, /✓ machineId is set/);
  assert.match(out, /✓ vendorId is set/);
  assert.match(out, /✓ 1 staff PIN\(s\) set/);
  assert.match(out, /– Not on a kiosk Pi/);
  assert.match(out, /All good/);
});

test('no config.env', () => {
  const { code, out } = run(null);
  assert.strictEqual(code, 1);
  assert.match(out, /✗ CONFIG\/config\.env is missing/);
  assert.match(out, /1 problem\(s\)/);
});

test('the sample IDs: empty vendorId is a problem, machineId=1 is not', () => {
  const lines = GOOD.filter((l) => !/^(machineId|vendorId)/.test(l)).concat(['machineId=1', 'vendorId=']);
  const { code, out } = run(lines);
  assert.strictEqual(code, 1);
  assert.match(out, /✓ machineId is set/);
  assert.match(out, /✗ vendorId is empty or not the long code with dashes/);
});

test('swapped IDs get their own message', () => {
  const lines = GOOD.filter((l) => !/^(machineId|vendorId)/.test(l)).concat([`machineId=${UUID}`, 'vendorId=24']);
  const { code, out } = run(lines);
  assert.strictEqual(code, 1);
  assert.match(out, /✗ machineId and vendorId are swapped/);
  assert.doesNotMatch(out, /vendorId is empty/);
});

test('values read like the server: spaces around =, quotes stripped, # lines skipped', () => {
  const lines = GOOD.filter((l) => !/^vendorId/.test(l)).concat(['#vendorId = nope', `vendorId = "${UUID}"`]);
  const { code, out } = run(lines);
  assert.strictEqual(code, 0, out);
});

test('no staff PIN, empty API_BASE_URL, QR_DEMO on: one ✗ each', () => {
  const lines = GOOD.filter((l) => !/^(STAFF1_PIN_HASH|API_BASE_URL|QR_DEMO)/.test(l))
    .concat(['API_BASE_URL =', 'QR_DEMO = 1']);
  const { code, out } = run(lines);
  assert.strictEqual(code, 1);
  assert.match(out, /✗ No staff PIN set/);
  assert.match(out, /✗ API_BASE_URL is empty/);
  assert.match(out, /✗ QR_DEMO is on/);
  assert.match(out, /3 problem\(s\)/);
});

test('sales: recent ones are uploading, one waiting 15+ min is stuck', () => {
  assert.match(run(GOOD).out, /✓ No sales waiting to upload/);
  const fresh = run(GOOD, [1, 2]);
  assert.strictEqual(fresh.code, 0, fresh.out);
  assert.match(fresh.out, /✓ 2 sale\(s\) uploading/);
  const stuck = run(GOOD, [95, 2]);
  assert.strictEqual(stuck.code, 1);
  assert.match(stuck.out, /✗ 2 sale\(s\) waiting, the oldest for 95 min/);
});
