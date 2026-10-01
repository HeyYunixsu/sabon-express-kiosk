# Install Runbook (Piece 5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A kiosk Pi can be installed and updated by pasting commands, and one command says whether it is set up right.

**Architecture:** Two new bash scripts at the repo root — `check_install.sh` (read-only ✓/✗ checklist) and `update.sh` (pull, safe rebuild, restart, check) — plus two fixes to `setup_and_run.sh`, and the install docs rewritten for the kiosk. The check's config part is tested from Node's test runner by running the script against temp folders; the Pi-only parts are switched off there.

**Tech Stack:** bash (Raspberry Pi OS; Git Bash on the dev PC), PM2, Node's built-in `node:test`.

**Spec:** `docs/superpowers/specs/2026-09-30-install-runbook-design.md`

## Global Constraints

- Scripts are bash, `#!/bin/bash`, LF line endings (`.gitattributes`: `*.sh text eol=lf`), executable bit set in git (`git update-index --chmod=+x`).
- `check_install.sh` never changes anything. Output: `  ✓ text`, `  ✗ text` + `      → fix`, `  – text` (not checked here). Ends with `All good` (exit 0) or `N problem(s)` (exit 1).
- ID rules, same as `idsProblem` in `kiosk_server/server.js`: `machineId` all digits; `vendorId` hex `8-4-4-4-12`; swapped = `machineId` is that code and `vendorId` digits. `machineId=1` alone is not a problem.
- Never print `machineId`/`vendorId` values, and never put real values in docs or commits (`CONFIG/config.env` is per-machine, untracked).
- PM2 names: `01_Dispenser_Controller 02_Water_Sensors 03_Transaction_Uploader 04_Status_Uploader 05_Kiosk_Server`.
- Repo: `https://github.com/HeyYunixsu/sabon-express-kiosk`, cloned to `~/Desktop/sabon-express-kiosk`.
- Staff PINs are exactly 4 digits.
- A sale waiting 15 min or more is stuck (same as the dashboard's `STUCK_MIN`).

---

### Task 1: `check_install.sh` and its test

**Files:**
- Create: `check_install.sh`
- Create: `.gitattributes`
- Create: `kiosk_server/tests/check_install.test.js`

**Interfaces:**
- Produces: `./check_install.sh` — env `KIOSK_ROOT` (default: the script's folder), `CHECK_INSTALL_PI=0` skips the Pi-only checks. Exit 0 = no ✗, 1 = some ✗. Used by Task 2 (`update.sh`, `setup_and_run.sh`) and Task 3 (docs).

- [ ] **Step 1: Write the failing test**

`kiosk_server/tests/check_install.test.js`:

```js
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
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd kiosk_server && node --test tests/check_install.test.js`
Expected: FAIL — every test, because `check_install.sh` does not exist (bash exits 127).

- [ ] **Step 3: Write `.gitattributes`**

```
# The Pi runs these with bash: a CRLF checkout on Windows breaks them.
*.sh text eol=lf
```

- [ ] **Step 4: Write `check_install.sh`**

```bash
#!/bin/bash
# check_install.sh — is this kiosk Pi set up right? Read-only, safe any time.
#
#   ./check_install.sh
#
# One line per check: ✓ fine, ✗ wrong (how to fix it on the line below),
# – not checked here (not a Pi, or the tool is missing). Exit 0 when nothing
# is ✗, 1 otherwise. update.sh and setup_and_run.sh run it at the end.
#
# Env: KIOSK_ROOT (default: this script's folder); CHECK_INSTALL_PI=0 skips
# the Pi-only checks (the tests use it).

set -uo pipefail

ROOT="${KIOSK_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
CONFIG="$ROOT/CONFIG/config.env"
BOOT_CONFIG="/boot/firmware/config.txt"
STUCK_MIN=15   # same as the staff dashboard's Stuck
PM2_NAMES="01_Dispenser_Controller 02_Water_Sensors 03_Transaction_Uploader 04_Status_Uploader 05_Kiosk_Server"

problems=0
ok()      { echo "  ✓ $1"; }
bad()     { echo "  ✗ $1"; echo "      → $2"; problems=$((problems + 1)); }
skip()    { echo "  – $1"; }
section() { echo ""; echo "$1"; }

# A config.env value read the way the kiosk server reads it: KEY = VALUE,
# spaces around = allowed, one matching pair of quotes stripped, # lines
# skipped, the last one wins.
cfg() {
  [ -f "$CONFIG" ] || return 0
  sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" "$CONFIG" | tail -1 | tr -d '\r' \
    | sed -E "s/[[:space:]]+\$//; s/^([\"'])(.*)\\1\$/\\2/"
}

if [ "${CHECK_INSTALL_PI:-}" = 0 ]; then ON_PI=0
elif [ -f "$BOOT_CONFIG" ]; then ON_PI=1
else ON_PI=0
fi

echo "Sabon Express kiosk — install check ($ROOT)"

# ---- config -----------------------------------------------------------------
# The cloud refuses every sale under the sample IDs (vendorId empty) or with
# the two swapped; the staff dashboard warns about the same thing.
section "Config"
if [ ! -f "$CONFIG" ]; then
  bad "CONFIG/config.env is missing" "cp CONFIG/config.env.sample CONFIG/config.env, then fill it in (docs/QUICK_INSTALL.md step 4)"
else
  ok "CONFIG/config.env exists"
  mid="$(cfg machineId)"
  vid="$(cfg vendorId)"
  uuid='^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$'
  if [[ "$mid" =~ $uuid ]] && [[ "$vid" =~ ^[0-9]+$ ]]; then
    bad "machineId and vendorId are swapped" "in CONFIG/config.env machineId is the machine NUMBER, vendorId the long code with dashes"
  else
    if [[ "$mid" =~ ^[0-9]+$ ]]; then ok "machineId is set"
    else bad "machineId is empty or not a number" "set machineId= to this machine's number in CONFIG/config.env"; fi
    if [[ "$vid" =~ $uuid ]]; then ok "vendorId is set"
    else bad "vendorId is empty or not the long code with dashes" "set vendorId= to the vendor's code (like 1a2b3c4d-1111-2222-3333-444455556666) in CONFIG/config.env"; fi
  fi
  if [ -n "$(cfg API_BASE_URL)" ]; then ok "API_BASE_URL is set"
  else bad "API_BASE_URL is empty" "set API_BASE_URL= in CONFIG/config.env (copy it from a working kiosk)"; fi
  staff=0
  for i in 1 2 3 4 5 6; do
    if [ -n "$(cfg "STAFF${i}_NAME")" ] && [ -n "$(cfg "STAFF${i}_PIN_HASH")" ]; then staff=$((staff + 1)); fi
  done
  if [ "$staff" -gt 0 ]; then ok "$staff staff PIN(s) set"
  else bad "No staff PIN set" "node kiosk_server/tools/hash_pin.js <4 digits>, then STAFF1_NAME= and STAFF1_PIN_HASH= in CONFIG/config.env"; fi
  if [ "$(cfg QR_DEMO)" = 1 ]; then bad "QR_DEMO is on: QR payments are pretend" "set QR_DEMO = 0 in CONFIG/config.env before a real shop uses this kiosk"
  else ok "QR_DEMO is off"; fi
fi

# ---- sales ------------------------------------------------------------------
# A sale file is named <unix seconds>_transaction_<slot>_<n>.json and stays
# in TRANSACTION_DIR until the cloud accepts it.
section "Sales"
TXN="$(cfg TRANSACTION_DIR)"
TXN="${TXN:-$ROOT/transaction}"
shopt -s nullglob
files=("$TXN"/*_transaction_*.json)
shopt -u nullglob
oldest=""
for f in "${files[@]}"; do
  b="${f##*/}"; t="${b%%_*}"
  if [[ "$t" =~ ^[0-9]+$ ]] && { [ -z "$oldest" ] || [ "$t" -lt "$oldest" ]; }; then oldest="$t"; fi
done
if [ ${#files[@]} -eq 0 ]; then
  ok "No sales waiting to upload"
else
  age=0
  [ -n "$oldest" ] && age=$(( ($(date +%s) - oldest) / 60 ))
  if [ "$age" -ge "$STUCK_MIN" ]; then
    bad "${#files[@]} sale(s) waiting, the oldest for $age min" "sudo pm2 logs 03_Transaction_Uploader --lines 40 --nostream   (\"failed\" = the IDs; errors = the internet)"
  else
    ok "${#files[@]} sale(s) uploading (oldest $age min)"
  fi
fi

# ---- the Pi itself ------------------------------------------------------------
if [ "$ON_PI" != 1 ]; then
  section "Pi"
  skip "Not on a kiosk Pi: controller, processes, kiosk, boot and screen not checked"
else
  KPORT="$(cfg KIOSK_PORT)"; KPORT="${KPORT:-3000}"
  SPORT="$(cfg SOCKET_PORT)"; SPORT="${SPORT:-8080}"

  section "Controller"
  if [ -x "$ROOT/controller/main" ]; then ok "controller/main is built"
  else bad "controller/main is missing" "cd controller && make   (paste any error)"; fi
  if command -v ss >/dev/null; then
    if ss -ltn "sport = :$SPORT" | grep -q LISTEN; then ok "Something is listening on port $SPORT"
    else bad "Nothing is listening on port $SPORT" "the controller is not running: sudo pm2 logs 01_Dispenser_Controller --lines 40 --nostream"; fi
  else
    skip "ss not found: port $SPORT not checked"
  fi

  section "Processes"
  if command -v pm2 >/dev/null; then
    PM2_JSON="$(sudo pm2 jlist 2>/dev/null)"
    # "<status> <pid> <script path>" for one PM2 name, or nothing.
    pm2_info() {
      node -e '
        const s = require("fs").readFileSync(0, "utf8");
        let list = [];
        try { list = JSON.parse(s.slice(s.indexOf("["))); } catch (_) { /* no list */ }
        const p = list.find((x) => x.name === process.argv[1]);
        if (p) console.log([p.pm2_env.status, p.pid || 0, p.pm2_env.pm_exec_path].join(" "));
      ' "$1" <<<"$PM2_JSON"
    }
    for n in $PM2_NAMES; do
      read -r st pid script <<<"$(pm2_info "$n")"
      if [ -z "${st:-}" ]; then bad "$n is not registered in PM2" "./setup_and_run.sh"
      elif [ "$st" != online ] || [ "${pid:-0}" = 0 ]; then bad "$n is not running (status $st, no pid)" "sudo pm2 logs $n --lines 40 --nostream"
      elif [[ "${script:-}" != "$ROOT"/* ]]; then bad "$n runs from another folder: $script" "./setup_and_run.sh   (re-registers it from this folder)"
      else ok "$n is running"; fi
    done
  else
    skip "pm2 not found: processes not checked"
  fi

  section "Kiosk"
  state="$(curl -s -m 5 "http://localhost:$KPORT/api/state" || true)"
  if [ -z "$state" ]; then bad "The kiosk server does not answer on port $KPORT" "sudo pm2 logs 05_Kiosk_Server --lines 40 --nostream"
  elif grep -q '"online":true' <<<"$state"; then ok "The kiosk server answers and sees the controller"
  else bad "The kiosk server answers but the controller is offline" "sudo pm2 logs 01_Dispenser_Controller --lines 40 --nostream"; fi

  section "Boot"
  missing=()
  for line in 'gpio=6,12,15,16,17,18=op,dh' 'gpio=10,13,14,23,24,25=ip,pu' 'dtparam=spi=off' 'dtparam=audio=off' 'enable_uart=0'; do
    grep -qE "^[[:space:]]*${line}[[:space:]]*\$" "$BOOT_CONFIG" || missing+=("$line")
  done
  if [ ${#missing[@]} -eq 0 ]; then ok "Pumps held off at boot, pull-ups on, serial/SPI/audio off"
  else bad "$BOOT_CONFIG lacks: ${missing[*]}" "add the block from docs/QUICK_INSTALL.md step 2, then reboot"; fi

  section "Screen"
  if command -v chromium >/dev/null || command -v chromium-browser >/dev/null; then ok "Chromium is installed"
  else bad "Chromium is not installed" "sudo apt install -y chromium"; fi
  user_name="${SUDO_USER:-$(id -un)}"
  user_home="$(getent passwd "$user_name" | cut -d: -f6)"
  autostart="${user_home:-$HOME}/.config/autostart/sabon-kiosk.desktop"
  if [ ! -f "$autostart" ]; then bad "The touchscreen does not open the kiosk at login" "./setup_and_run.sh   (installs $autostart)"
  elif grep -q "^Exec=$ROOT/kiosk_server/launch_browser.sh" "$autostart"; then ok "The touchscreen opens the kiosk at login"
  else bad "The touchscreen autostart points at another folder" "./setup_and_run.sh   (rewrites $autostart)"; fi
  if command -v systemctl >/dev/null; then
    if systemctl is-enabled pm2-root >/dev/null 2>&1; then ok "PM2 starts everything after a reboot"
    else bad "PM2 will not start after a reboot" "sudo pm2 startup systemd && sudo pm2 save"; fi

    section "Old installs"
    if systemctl is-active vendo_gui.service >/dev/null 2>&1; then bad "The old V1 screen (vendo_gui.service) is running" "sudo systemctl disable --now vendo_gui.service"
    else ok "No old V1 screen running"; fi
  else
    skip "systemctl not found: reboot start-up and old installs not checked"
  fi
fi

echo ""
if [ "$problems" -eq 0 ]; then echo "All good"; exit 0; fi
echo "$problems problem(s)"
exit 1
```

- [ ] **Step 5: Run the test to make sure it passes**

Run: `cd kiosk_server && node --test tests/check_install.test.js`
Expected: 7 pass, 0 fail.

Then the whole suite: `npm test` → all pass (123).

- [ ] **Step 6: Run it by hand on the dev PC**

Run: `bash check_install.sh` from the repo root (Git Bash).
Expected: the Config and Sales sections, then `– Not on a kiosk Pi: …` (no `/boot/firmware` on a PC). The PC's own `config.env` may show ✗ lines — that is the check working, not a failure of this step. Never paste its values anywhere.

- [ ] **Step 7: Commit**

```bash
git add .gitattributes check_install.sh kiosk_server/tests/check_install.test.js
git update-index --chmod=+x check_install.sh
git commit -m "feat: check_install.sh, a read-only checklist for a kiosk Pi"
```

---

### Task 2: `update.sh` and the `setup_and_run.sh` fixes

**Files:**
- Create: `update.sh`
- Modify: `setup_and_run.sh` (the `build_cpp` function ~lines 72-95; `pm2_start_binary` ~175-203; `pm2_start_python` ~209-246; the `05_Kiosk_Server` block ~275-287; the end ~331-343)

**Interfaces:**
- Consumes: `./check_install.sh` from Task 1 (exit 0/1).
- Produces: `./update.sh` (exit = the check's exit code, or 1 when the pull or build fails). Task 3's docs name both scripts.

- [ ] **Step 1: Write `update.sh`**

```bash
#!/bin/bash
# update.sh — bring this kiosk Pi up to date.
#
#   ./update.sh
#
# Pulls the code, rebuilds the controller only when its code changed (never
# deleting the running one first), restarts the five processes, then runs
# check_install.sh. Exit code: the check's, or 1 when the pull or build fails.

set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")" || exit 1

PM2_NAMES="01_Dispenser_Controller 02_Water_Sensors 03_Transaction_Uploader 04_Status_Uploader 05_Kiosk_Server"

# config.env, prices.conf, logs/ and transaction/ are ignored by git, so only
# edits to tracked files can block the pull.
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "These files were changed on this Pi, so the update would overwrite them:"
  git status --short --untracked-files=no
  echo "Undo any you did not mean with:  git checkout -- <file>   then run ./update.sh again."
  exit 1
fi

before="$(git rev-parse HEAD)"
if ! git pull --ff-only; then
  echo "git pull failed: nothing was changed. Check the internet and try again."
  exit 1
fi
after="$(git rev-parse HEAD)"
[ "$before" = "$after" ] && echo "Already up to date."

# make, not make clean + make: if the build fails, the controller that was
# running is still on disk and keeps running.
if { [ "$before" != "$after" ] && ! git diff --quiet "$before" "$after" -- controller/; } || [ ! -x controller/main ]; then
  echo "Building the controller..."
  if ! (cd controller && make); then
    echo "Controller build FAILED: the running controller was not touched."
    echo "Paste the error above to whoever maintains the kiosk."
    exit 1
  fi
fi

for n in $PM2_NAMES; do sudo pm2 restart "$n" >/dev/null && echo "Restarted $n"; done
sudo pm2 save >/dev/null

echo "Waiting for the kiosk to come up..."
sleep 8
./check_install.sh
```

- [ ] **Step 2: `setup_and_run.sh` — build without `make clean`**

Replace, inside `build_cpp`:

```bash
  # Clean previous artefacts so we always get a fresh build
  if make clean 2>/dev/null; then
    log "[$name] make clean — OK"
  else
    warn "[$name] make clean skipped (no clean target or already clean)"
  fi

  if make; then
```

with:

```bash
  # No make clean first: if this build fails, the controller that was built
  # before stays on disk and PM2 can still run it. make rebuilds whatever
  # changed (the .d files track headers); run make clean by hand for a full
  # rebuild.
  if make; then
```

- [ ] **Step 3: `setup_and_run.sh` — re-register instead of restart**

In `pm2_start_binary`, replace:

```bash
  if pm2_process_exists "$pm2_name"; then
    log "[$pm2_name] Already registered — restarting"
    sudo pm2 restart "$pm2_name"
  else
    log "[$pm2_name] New process — starting for the first time"
    sudo env "${extra_env[@]}" pm2 start "$binary" \
      --name "$pm2_name" \
      --cwd  "$cwd" \
      --log  "$cwd/pm2_${pm2_name}.log" \
      --time
  fi
```

with:

```bash
  # Delete and start, never restart: an entry left by V1 or the cashier on
  # this Pi would otherwise keep running that folder's program.
  if pm2_process_exists "$pm2_name"; then
    log "[$pm2_name] Already registered — re-registering from this folder"
    sudo pm2 delete "$pm2_name"
  fi
  sudo env "${extra_env[@]}" pm2 start "$binary" \
    --name "$pm2_name" \
    --cwd  "$cwd" \
    --log  "$cwd/pm2_${pm2_name}.log" \
    --time
```

In `pm2_start_python`, replace:

```bash
  if pm2_process_exists "$pm2_name"; then
    log "[$pm2_name] Already registered — restarting"
    sudo pm2 restart "$pm2_name"
  else
    log "[$pm2_name] New process — starting for the first time"
    sudo env "${extra_env[@]}" pm2 start "$script" \
      --name        "$pm2_name" \
      --interpreter "$interpreter" \
      --cwd         "$cwd" \
      --log         "$cwd/pm2_${pm2_name}.log" \
      --time
  fi
```

with:

```bash
  # Delete and start, never restart (see pm2_start_binary).
  if pm2_process_exists "$pm2_name"; then
    log "[$pm2_name] Already registered — re-registering from this folder"
    sudo pm2 delete "$pm2_name"
  fi
  sudo env "${extra_env[@]}" pm2 start "$script" \
    --name        "$pm2_name" \
    --interpreter "$interpreter" \
    --cwd         "$cwd" \
    --log         "$cwd/pm2_${pm2_name}.log" \
    --time
```

Replace the `05_Kiosk_Server` block:

```bash
if pm2_process_exists "05_Kiosk_Server"; then
  log "[05_Kiosk_Server] Already registered — restarting"
  sudo pm2 restart "05_Kiosk_Server"
else
  log "[05_Kiosk_Server] Starting server.js"
  sudo env NODE_ENV=production pm2 start "$SCRIPT_DIR/kiosk_server/server.js" \
    --name "05_Kiosk_Server" \
    --cwd  "$SCRIPT_DIR/kiosk_server" \
    --log  "$SCRIPT_DIR/kiosk_server/pm2_05_Kiosk_Server.log" \
    --time
fi
```

with:

```bash
if pm2_process_exists "05_Kiosk_Server"; then
  log "[05_Kiosk_Server] Already registered — re-registering from this folder"
  sudo pm2 delete "05_Kiosk_Server"
fi
sudo env NODE_ENV=production pm2 start "$SCRIPT_DIR/kiosk_server/server.js" \
  --name "05_Kiosk_Server" \
  --cwd  "$SCRIPT_DIR/kiosk_server" \
  --log  "$SCRIPT_DIR/kiosk_server/pm2_05_Kiosk_Server.log" \
  --time
```

- [ ] **Step 4: `setup_and_run.sh` — run the check at the end**

After the last `log "================================================================"` line, append:

```bash

# --------------------------------------------------------------------------- #
# 5. Install check
# --------------------------------------------------------------------------- #
section "5. Install check"
sleep 8   # let the controller start and the kiosk server see it
"$SCRIPT_DIR/check_install.sh" || warn "check_install.sh found problems — fix the ✗ lines above"
```

- [ ] **Step 5: Syntax-check all three scripts**

Run: `bash -n update.sh && bash -n setup_and_run.sh && bash -n check_install.sh && echo OK`
Expected: `OK`.

Run: `grep -n "make clean\|pm2 restart" setup_and_run.sh`
Expected: only the comment line mentioning `make clean` by hand; no `pm2 restart`.

- [ ] **Step 6: Commit**

```bash
git add update.sh setup_and_run.sh
git update-index --chmod=+x update.sh
git commit -m "feat: update.sh; setup_and_run.sh keeps the old controller on a failed build and re-registers PM2 from this folder"
```

---

### Task 3: The kiosk install guide

**Files:**
- Modify (full rewrite): `docs/QUICK_INSTALL.md`
- Modify: `docs/INSTALLATION.md` (lines named below)
- Modify: `CLAUDE.md` (Status table, Commands, Where things live)

**Interfaces:**
- Consumes: `check_install.sh` (Task 1), `update.sh` and the `setup_and_run.sh` behaviour (Task 2).

- [ ] **Step 1: Rewrite `docs/QUICK_INSTALL.md`** with exactly this content:

````markdown
# Quick Install — Kiosk Raspberry Pi

Paste each block in order. Replace anything in `<angle brackets>`.
The reasons behind every step are in [INSTALLATION.md](INSTALLATION.md).

```
0. Before you start  ->  1. Base packages  ->  2. Boot config (REBOOT)
3. Get the code      ->  4. config.env     ->  5. Dependencies
6. Build & launch    ->  7. Check          ->  8. Test the hardware
9. Calibrate         ->  10. Staff tablet
```

---

## 0. Before you start

Flash **Raspberry Pi OS (64-bit), with desktop** using Raspberry Pi Imager. In
Imager set the username, the Wi-Fi and SSH, then boot and log in. A network
cable is safer than Wi-Fi for the install.

Have these ready: this machine's **number** (`machineId`), the vendor's
**long code with dashes** (`vendorId`), the backend address (`API_BASE_URL`),
and a 4-digit PIN for each staff member.

---

## 1. Base packages

```bash
sudo apt update
sudo apt install -y git build-essential python3-venv python3-dev curl gnupg tmux raspi-utils
```

Optional, but it keeps the install running if SSH drops:

```bash
tmux new -s setup
```

(Reconnect later with `tmux attach -t setup`.)

---

## 2. Boot config — then reboot

Sets the button pull-ups, keeps the pumps OFF during boot, and frees the pins
this machine uses from the Pi's built-in serial port, SPI and audio.

```bash
sudo cp /boot/firmware/config.txt  /boot/firmware/config.txt.bak
sudo cp /boot/firmware/cmdline.txt /boot/firmware/cmdline.txt.bak

sudo tee -a /boot/firmware/config.txt >/dev/null <<'EOF'

# --- Sabon dispenser ---
# [all] so these apply on every Pi model, not just the last filter above
[all]
# Buttons are wired GPIO -> GND, so they need pull-ups
gpio=10,13,14,23,24,25=ip,pu
# Pump relays are active-low: hold them OFF from power-on
gpio=6,12,15,16,17,18=op,dh
# Free our pins: SPI (7-11), audio (18-19), serial port (14-15)
dtparam=spi=off
dtparam=audio=off
enable_uart=0
EOF

sudo sed -i -E 's/console=(serial0|ttyAMA0|ttyS0),[0-9]+ ?//g' /boot/firmware/cmdline.txt
sudo reboot
```

After the reboot, check it took:

```bash
pinctrl get 10,13,14,23,24,25              # each: ip    pu | hi   (nothing plugged in)
pinctrl get 6,12,15,16,17,18               # each: op    dh | hi   (pumps off)
tr ' ' '\n' < /proc/cmdline | grep console  # only: console=tty1
```

If the Pi does not boot, put the SD card in a PC and copy the two `.bak`
files back over `config.txt` and `cmdline.txt`.

---

## 3. Get the code

```bash
cd ~/Desktop
git clone https://github.com/HeyYunixsu/sabon-express-kiosk.git
cd sabon-express-kiosk
git log --oneline -1
```

---

## 4. Create `config.env`

`config.env` is not in git. Every machine needs its own.

> **Replacing an old kiosk Pi?** Copy its settings and saved prices instead
> (the old Pi must be on the same network), then go straight to the check
> below:
>
> ```bash
> cd ~/Desktop/sabon-express-kiosk
> scp <user>@<old-pi-ip>:~/Desktop/sabon-express-kiosk/CONFIG/config.env  CONFIG/config.env
> scp <user>@<old-pi-ip>:~/Desktop/sabon-express-kiosk/CONFIG/prices.conf CONFIG/prices.conf
> ```

**New machine:**

```bash
cd ~/Desktop/sabon-express-kiosk
cp CONFIG/config.env.sample CONFIG/config.env
node kiosk_server/tools/hash_pin.js <4-digit PIN>     # once per staff member
nano CONFIG/config.env
```

Set these (save with `Ctrl+O`, `Enter`, exit with `Ctrl+X`):

| Key | Set it to |
|-----|-----------|
| `machineId` | This machine's **number**. Must match the backend and be unique per Pi. |
| `vendorId` | The vendor's **long code with dashes**. Not the number: swapping these two makes the backend refuse every sale. |
| `API_BASE_URL` | The backend address, including the port it answers on |
| `KIOSK_LETTER` | `A`, `B`, … — the order numbers start with it (`A-12`) |
| `KIOSK_NAME`, `KIOSK_LOCATION` | Optional: what the staff page shows |
| `STAFF1_NAME`, `STAFF1_PIN_HASH` … up to `STAFF6_…` | Each staff member's name and the line `hash_pin.js` printed |
| `STAFF_TABLET` | `1` to take cash at the counter and mark it paid from the staff tablet; `0` to have staff type their PIN on the kiosk |
| `QR_DEMO` | `0`. `1` is the pretend QR payment for demos only |
| `PRODUCT1_NAME`–`PRODUCT6_NAME`, `PRODUCT1_ML`–`PRODUCT6_ML` | What is in each tank, and millilitres per press |
| `PRICE1`–`PRICE6` | Price per press, whole pesos (also editable later from the staff page) |
| `calibrateProduct1`–`6` | Leave for now — set in step 9 |

Check the backend is reachable on that port (any number back means it is up;
`Connection refused` means wrong port or the backend is down):

```bash
curl -sS -m 5 -o /dev/null -w '%{http_code}\n' "$(sed -n 's/^API_BASE_URL *= *"\{0,1\}\([^"]*\)"\{0,1\}/\1/p' CONFIG/config.env)/api/v1/auth/machine/transaction"
```

---

## 5. Install dependencies

Installs WiringPi, Node.js 20, PM2 and log rotation. Takes a while.

```bash
cd ~/Desktop/sabon-express-kiosk
./install_dependencies.sh 2>&1 | tee install_dependencies.log
```

If it stops on the Node.js version check, see
[Node.js is too old](INSTALLATION.md#nodejs-is-too-old-or-npm-is-missing).

---

## 6. Build and launch

Builds the controller, sets up Python, registers the five processes to start
on every boot, sets the touchscreen to open the kiosk at login, and ends with
the install check.

```bash
cd ~/Desktop/sabon-express-kiosk
./setup_and_run.sh 2>&1 | tee setup_run.log
```

Run the controller tests too (a few minutes — the press tests wait for real
pours). The last line must say `0 failed`:

```bash
cd ~/Desktop/sabon-express-kiosk/controller && make test; cd ..
```

---

## 7. Check

```bash
cd ~/Desktop/sabon-express-kiosk
./check_install.sh
```

Every line must be ✓ and the last line `All good`. Each ✗ says how to fix it
on the line under it; fix, then run the check again. Then reboot once and run
it again — the kiosk must come back by itself:

```bash
sudo reboot
# after logging back in:
cd ~/Desktop/sabon-express-kiosk && ./check_install.sh
```

The touchscreen should show the kiosk, full screen, on its own.

---

## 8. Test the hardware

### Buttons (only if buttons are wired)

```bash
cd ~/Desktop/sabon-express-kiosk/controller/tools
g++ -o test_buttons test_buttons.cpp -lwiringPi
sudo ./test_buttons
```

Press each button once. Every one must print `>>> PRESSED` then `<<< RELEASED`.
`Ctrl+C` to quit.

### Relays

Each pump runs for 2 seconds. **Put a cup under every nozzle first.**

```bash
sudo pm2 stop 01_Dispenser_Controller
for p in 15 16 6 17 18 12; do read -p "Enter = pump on GPIO$p for 2s... "; pinctrl set $p op dl; sleep 2; pinctrl set $p op dh; done
sudo pm2 start 01_Dispenser_Controller
```

The order is pump 1, 2, 3, 4, 5, 6. Every relay should click and its LED light.

### Water sensors

```bash
sudo pm2 logs 01_Dispenser_Controller --lines 0 | grep --line-buffered "Water level"
```

Lift and drop each float: up must read `ok`, down must read `E`. `Ctrl+C` to quit.
If **every** slot reads backwards, flip `WATER_SENSOR_EMPTY_HIGH` in
`config.env` (1 ↔ 0) and run `sudo pm2 restart 01_Dispenser_Controller`.

---

## 9. Calibrate the pumps

Do not skip this — without it every pour is the wrong size and nothing warns you.
Follow [INSTALLATION.md section 7b](INSTALLATION.md#7b-calibrate-the-pumps).

---

## 10. Staff tablet

With `STAFF_TABLET = 1`, staff mark cash paid from a tablet or laptop on the
shop Wi-Fi. Find the Pi's address and open the page there:

```bash
hostname -I          # the first address
```

`http://<pi-ip>:3000/staff` — sign in with a staff PIN.

---

## Updating this Pi later

```bash
cd ~/Desktop/sabon-express-kiosk
./update.sh
```

It pulls, rebuilds the controller only if its code changed, restarts
everything and runs the check. If it says files *were changed on this Pi*,
undo the ones you did not mean with `git checkout -- <file>` and run it again.
`config.env` and `prices.conf` are never touched.

---

## This Pi ran V1 or the cashier before

```bash
sudo systemctl disable --now vendo_gui.service     # the old V1 screen, if present
cd ~/Desktop/sabon-express-kiosk
./setup_and_run.sh 2>&1 | tee setup_run.log        # re-points every process here
./check_install.sh
```

Delete the old folder only when its `transaction/` folder is empty — anything
in it is a sale the backend has not received yet.

---

## Quick reference

```bash
./check_install.sh                             # is everything right?
./update.sh                                    # update and check
sudo pm2 list                                  # what is running
sudo pm2 logs 01_Dispenser_Controller          # live controller log
sudo pm2 logs 03_Transaction_Uploader          # are sales reaching the backend?
sudo pm2 restart 01_Dispenser_Controller       # after editing config.env
```
````

- [ ] **Step 2: Edit `docs/INSTALLATION.md`**

1. Delete line 3 (the `> **Copied from the cashier product, not yet adapted.** …` notice) and the blank line after it.
2. Everywhere: `sabon-vendo-cashier` → `sabon-express-kiosk` (lines 141, 142, 159, 206, 223, 374, 402). Line 141's URL becomes `https://github.com/HeyYunixsu/sabon-express-kiosk.git`.
3. Lines 146-149 (the `> master now carries the six-slot work …` note): delete.
4. Lines 164-177 (the three machine-specific values and the `TRANSACTION_DIR` block): replace with

```markdown
Two values are machine-specific and must be set:

| Key | What to put |
|-----|-------------|
| `machineId` | This machine's **number** — unique per Pi, and must match the backend |
| `vendorId` | The vendor's **long code with dashes**, from the backend |

Swapping them, or leaving the sample's empty `vendorId`, makes the backend
refuse every sale ([Sales refused by the backend](#sales-refused-by-the-backend)).
Leave `TRANSACTION_DIR` unset: it defaults to `<repo>/transaction`.
```

5. Line 185: `Also editable later from the dashboard's Settings, which keeps an audit log.` → `Also editable later from the staff page (Inventory), which keeps an audit log.`
6. Line 191: `controller and the dashboard` → `controller and the kiosk server`.
7. Line 227: `This builds the controller, creates the Python venv, installs npm dependencies,` → `This builds the controller, creates the Python venv,`; and line 228 → `registers all five processes with PM2, persists them for auto-start on boot, and runs ./check_install.sh.`
8. Line 236: `Expect **647 passed, 0 failed**.` → `Expect **0 failed** on the last line.`
9. Lines 240-277 (section `## 6. Verify`): replace the whole section body with

````markdown
```bash
./check_install.sh
```

Every line ✓ and `All good` at the end. It checks the config, the controller
program and port 8080, the five PM2 processes (online, with a pid, from this
folder), the kiosk server, waiting sales, the boot config, the touchscreen
autostart and PM2's start at boot. `online` in `pm2 list` alone is **not**
proof: a process can show `online` with pid `N/A` when its program is
missing.

The five processes:

| PM2 name | Runs |
|----------|------|
| `01_Dispenser_Controller` | `controller/main` |
| `02_Water_Sensors` | `uploaders/water_level_monitoring.py` |
| `03_Transaction_Uploader` | `uploaders/transaction_uploader.py` |
| `04_Status_Uploader` | `uploaders/status_uploader.py` |
| `05_Kiosk_Server` | `kiosk_server/server.js` (port 3000) |

Check the controller came up with the right pin map and sensor polarity:

```bash
sudo pm2 logs 01_Dispenser_Controller --lines 30 --nostream | grep -E "Slot |Water sensor"
```

The kiosk opens full screen on the touchscreen at login. The staff page is
`http://<pi-ip>:3000/staff` (`hostname -I` for the address) when
`STAFF_TABLET = 1`.
````

10. Line 319: `the dashboard looks right` → `the kiosk looks right`.
11. Line 332: `Use **Clear Air** in the dashboard's Settings, which runs one pump for` → `Use **Air clear** on the staff page (Kiosk Health), which runs one nozzle for`.
12. Line 337: `tap **Clear Air** once more` → `tap **Air clear** once more`.
13. Lines 368-386 (`## Upgrading an existing Pi`): replace with

````markdown
## Updating an existing Pi

```bash
cd ~/Desktop/sabon-express-kiosk
./update.sh
```

It refuses to run over local edits to tracked files (it lists them), pulls,
rebuilds the controller only when `controller/` changed or `controller/main`
is missing — with `make`, never `make clean` first, so a failed build leaves
the running controller in place — restarts the five processes and runs
`./check_install.sh`.
````

14. Lines 458-476 (`### Dashboard says online but the browser cannot reach it`): replace with

````markdown
### The kiosk says Offline, but `pm2 list` says online

```bash
./check_install.sh
ls -la controller/main
sudo ss -ltnp | grep 8080
```

- **`controller/main` is missing** — PM2 shows `01_Dispenser_Controller`
  `online` with pid `N/A` because it has nothing to start. Build it:
  `cd controller && make`, then `sudo pm2 restart 01_Dispenser_Controller`.
- **Nothing on 8080 but `main` exists** — read
  `sudo pm2 logs 01_Dispenser_Controller --lines 40 --nostream`. A
  `bind() failed on port 8080` line means another program holds the port;
  the controller retries every 5 s, so find and stop the other one.

### Sales refused by the backend

`sudo pm2 logs 03_Transaction_Uploader --lines 40 --nostream` shows the
sales under `"failed"`, echoing `machineId: 1, vendorId: null` (the sample
values) or the two swapped. Fix `machineId` (the number) and `vendorId` (the
long code with dashes) in `CONFIG/config.env`, then
`sudo pm2 restart 01_Dispenser_Controller`. Sales already waiting in
`transaction/` keep the IDs they were written with: back the folder up and
rewrite their `machine_id`/`vendor_id` before restarting
`03_Transaction_Uploader`. The staff page warns about this ("Sales are not
reaching the cloud").
````

15. In `### Useful commands` (lines 526-532), add as the first line inside the code block: `./check_install.sh                        # is everything right?`

After the edits: `grep -n -i "cashier\|vendo-cashier\|:80\b\|05_Cashier" docs/INSTALLATION.md` → expected: nothing.

- [ ] **Step 3: Edit `CLAUDE.md`**

1. Status table, row 5: `| 5 | Install runbook for a kiosk Pi | Last |` → `| 5 | Install runbook for a kiosk Pi | **Done** — \`docs/QUICK_INSTALL.md\`, \`check_install.sh\`, \`update.sh\` |`
2. In `## Commands`, after the `# Staff dashboard layout audit …` block's line, inside the same code block, add:

```bash
# On a Pi: is the install right? / update and check
./check_install.sh
./update.sh
```

3. In `## Where things live`, change the row `| \`docs/INSTALLATION.md\`, \`docs/QUICK_INSTALL.md\` | Pi setup. Copied from the cashier product, adapted in piece 5 |` to `| \`docs/QUICK_INSTALL.md\`, \`docs/INSTALLATION.md\` | Kiosk Pi install: the steps, and the reasons and troubleshooting |` and add the row `| \`check_install.sh\`, \`update.sh\` | The install check (read-only) and the one-command update |`.

- [ ] **Step 4: Check the docs**

Run: `grep -n -i "vendo-cashier\|cashier dashboard\|05_Cashier\|not yet adapted" docs/QUICK_INSTALL.md docs/INSTALLATION.md CLAUDE.md`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add docs/QUICK_INSTALL.md docs/INSTALLATION.md CLAUDE.md
git commit -m "docs: the kiosk install runbook (piece 5)"
```
