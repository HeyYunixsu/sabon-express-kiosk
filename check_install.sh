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
  bad "CONFIG/config.env is missing" "cp CONFIG/config.env.sample CONFIG/config.env, then fill it in (docs/QUICK_INSTALL.md step 5)"
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
    if ! PM2_JSON="$(sudo -n timeout 20 pm2 jlist 2>/dev/null)"; then
      skip "pm2 needs sudo: processes not checked (run: sudo ./check_install.sh)"
    else
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

      # Anything PM2 knows about that is not one of ours: an old install
      # (V1, the cashier) that setup_and_run.sh never touched, left running
      # and saved. PM2's own modules (e.g. pm2-logrotate) are not processes
      # of ours or anyone else's install, so they are not flagged.
      extra_names="$(node -e '
        const s = require("fs").readFileSync(0, "utf8");
        let list = [];
        try { list = JSON.parse(s.slice(s.indexOf("["))); } catch (_) { /* no list */ }
        for (const x of list) {
          if (x.pm2_env && x.pm2_env.pmx_module) continue;
          console.log(x.name);
        }
      ' <<<"$PM2_JSON")"
      while IFS= read -r name; do
        [ -z "$name" ] && continue
        case " $PM2_NAMES " in
          *" $name "*) ;;
          *) bad "Unexpected PM2 process: $name" "sudo pm2 delete $name && sudo pm2 save   (left by an old install?)" ;;
        esac
      done <<<"$extra_names"
    fi
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
