#!/bin/bash
# =============================================================================
# setup_and_run.sh
# Sabon Express Dispenser — Full Setup & PM2 Launch Script
#
# Usage:
#   chmod +x setup_and_run.sh
#   ./setup_and_run.sh
#
# Logs are printed with timestamps. Copy/paste the full terminal output for
# debugging. You can also redirect:
#   ./setup_and_run.sh 2>&1 | tee setup_run.log
# =============================================================================

set -euo pipefail

# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_PREFIX="[setup_and_run]"

log()  { echo "${LOG_PREFIX} [$(date '+%Y-%m-%d %H:%M:%S')] INFO  | $*"; }
warn() { echo "${LOG_PREFIX} [$(date '+%Y-%m-%d %H:%M:%S')] WARN  | $*" >&2; }
err()  { echo "${LOG_PREFIX} [$(date '+%Y-%m-%d %H:%M:%S')] ERROR | $*" >&2; }

# Detects the human user running this session — works for any Pi username.
# Priority: SUDO_USER → logname → first human user in /etc/passwd → pi
_detect_display_user() {
    # 1. SUDO_USER is set when the script is invoked via sudo
    if [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != "root" ]; then
        echo "$SUDO_USER"; return
    fi
    # 2. logname returns the login name of the current session
    local u
    u="$(logname 2>/dev/null || true)"
    if [ -n "$u" ] && [ "$u" != "root" ]; then
        echo "$u"; return
    fi
    # 3. First human user (UID 1000–65533) in /etc/passwd — covers any Pi username
    u="$(awk -F: '$3 >= 1000 && $3 < 65534 { print $1; exit }' /etc/passwd 2>/dev/null || true)"
    if [ -n "$u" ]; then echo "$u"; return; fi
    # 4. Last resort: standard Raspberry Pi OS default
    echo "pi"
}

section() {
  echo ""
  echo "============================================================"
  echo "  $*"
  echo "============================================================"
}

# --------------------------------------------------------------------------- #
# 0. Sanity checks
# --------------------------------------------------------------------------- #
section "0. Sanity checks"

for cmd in make g++ python3 pm2 sudo systemctl; do
  if ! command -v "$cmd" &>/dev/null; then
    warn "'$cmd' not found in PATH — some steps may fail."
  else
    log "'$cmd' found: $(command -v "$cmd")"
  fi
done

# --------------------------------------------------------------------------- #
# 1. Build C++ projects with make
# --------------------------------------------------------------------------- #
section "1. Building C++ projects"

build_cpp() {
  local name="$1"
  local dir="$SCRIPT_DIR/$name"

  log "[$name] Starting make in $dir"
  pushd "$dir" > /dev/null

  # Clean previous artefacts so we always get a fresh build
  if make clean 2>/dev/null; then
    log "[$name] make clean — OK"
  else
    warn "[$name] make clean skipped (no clean target or already clean)"
  fi

  if make; then
    log "[$name] make — BUILD SUCCESSFUL"
  else
    err "[$name] make — BUILD FAILED (check output above)"
    popd > /dev/null
    return 1
  fi

  popd > /dev/null
}

build_cpp "controller"

# --------------------------------------------------------------------------- #
# 2. Create virtual-envs and install requirements
# --------------------------------------------------------------------------- #
section "2. Setting up Python virtual environments"

setup_venv() {
  local name="$1"
  local dir="$SCRIPT_DIR/$name"
  local venv_dir="$dir/venv"

  log "[$name] Setting up venv at $venv_dir"

  if [ ! -d "$venv_dir" ]; then
    python3 -m venv "$venv_dir"
    log "[$name] venv created"
  else
    log "[$name] venv already exists — skipping creation"
  fi

  # Upgrade pip silently
  "$venv_dir/bin/pip" install --upgrade pip --quiet
  log "[$name] pip upgraded"

  # Find requirements file (requirement.txt or requirements.txt)
  local req=""
  for fname in requirements.txt requirement.txt; do
    if [ -f "$dir/$fname" ]; then
      req="$dir/$fname"
      break
    fi
  done

  if [ -n "$req" ]; then
    log "[$name] Installing from $req"
    "$venv_dir/bin/pip" install -r "$req"
    log "[$name] Requirements installed"
  else
    warn "[$name] No requirements file found — skipping pip install"
  fi
}

setup_venv "uploaders"

# Git cannot store an empty directory, so a fresh clone has no transaction/ and
# the uploader has nothing to watch. The controller creates it on its first
# sale, but that is too late: the uploader starts first and would sit restarting
# until somebody made one. Honour TRANSACTION_DIR so this matches wherever the
# controller and the uploader are actually pointed.
TXN_DIR="$(sed -n 's/^[[:space:]]*TRANSACTION_DIR[[:space:]]*=[[:space:]]*//p' \
           "$SCRIPT_DIR/CONFIG/config.env" 2>/dev/null | tail -1 | tr -d '\r')"
TXN_DIR="${TXN_DIR:-$SCRIPT_DIR/transaction}"
mkdir -p "$TXN_DIR"
log "Transaction directory ready: $TXN_DIR"

# --------------------------------------------------------------------------- #
# 3. Register processes with PM2
# --------------------------------------------------------------------------- #
section "3. Registering processes with PM2"

# Detect the display user — works for any Pi username (pi, dgsi, etc.)
DISPLAY_USER="$(_detect_display_user)"
DISPLAY_USER_HOME="/home/${DISPLAY_USER}"
log "Display user: $DISPLAY_USER  (home: $DISPLAY_USER_HOME)"

# On Linux the Makefile produces 'main' (no .exe extension)
CONTROLLER_BIN="$SCRIPT_DIR/controller/main"

pm2_process_exists() {
  # Returns 0 (true) if a PM2 process with this name is already registered
  sudo pm2 describe "$1" &>/dev/null
}

# pm2_start_binary <pm2_name> <binary> <cwd> [KEY=VAL ...]
# Extra KEY=VAL args after position 3 are injected into the process environment
# via `sudo env KEY=VAL pm2 start` — this is the only reliable way to pass
# env vars to PM2 from the CLI without an ecosystem file.
pm2_start_binary() {
  local pm2_name="$1"
  local binary="$2"
  local cwd="$3"
  shift 3
  local extra_env=("$@")   # remaining args are KEY=VAL pairs

  log "[$pm2_name] Registering binary: $binary"
  [ ${#extra_env[@]} -gt 0 ] && log "[$pm2_name] Extra env: ${extra_env[*]}"

  if [ ! -f "$binary" ]; then
    err "[$pm2_name] Binary not found: $binary  — did make succeed?"
    return 1
  fi

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

  log "[$pm2_name] PM2 entry registered/restarted"
}

# pm2_start_python <pm2_name> <script> <venv_root> <cwd> [KEY=VAL ...]
# Extra KEY=VAL args after position 4 are injected via `sudo env KEY=VAL pm2 start`.
# NOTE: PM2's --env flag selects a named block from an ecosystem file — it does
# NOT set individual environment variables. Use `sudo env` instead.
pm2_start_python() {
  local pm2_name="$1"
  local script="$2"
  local venv_root="$3"   # directory that contains /venv
  local cwd="$4"
  shift 4
  local extra_env=("$@")  # remaining args are KEY=VAL pairs

  local interpreter="$venv_root/venv/bin/python3"
  log "[$pm2_name] Registering Python script: $script"
  log "[$pm2_name] Interpreter: $interpreter"
  [ ${#extra_env[@]} -gt 0 ] && log "[$pm2_name] Extra env: ${extra_env[*]}"

  if [ ! -f "$interpreter" ]; then
    err "[$pm2_name] Interpreter not found: $interpreter"
    return 1
  fi

  if [ ! -f "$script" ]; then
    err "[$pm2_name] Script not found: $script"
    return 1
  fi

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

  log "[$pm2_name] PM2 entry registered/restarted"
}

# 01_Dispenser_Controller — controller C++ binary
pm2_start_binary \
  "01_Dispenser_Controller" \
  "$CONTROLLER_BIN" \
  "$SCRIPT_DIR/controller"

# 02_Water_Sensors — uploaders/water_level_monitoring.py
pm2_start_python \
  "02_Water_Sensors" \
  "$SCRIPT_DIR/uploaders/water_level_monitoring.py" \
  "$SCRIPT_DIR/uploaders" \
  "$SCRIPT_DIR/uploaders"

# 03_Transaction_Uploader — uploaders/transaction_uploader.py
pm2_start_python \
  "03_Transaction_Uploader" \
  "$SCRIPT_DIR/uploaders/transaction_uploader.py" \
  "$SCRIPT_DIR/uploaders" \
  "$SCRIPT_DIR/uploaders"

# 04_Status_Uploader — uploaders/status_uploader.py
pm2_start_python \
  "04_Status_Uploader" \
  "$SCRIPT_DIR/uploaders/status_uploader.py" \
  "$SCRIPT_DIR/uploaders" \
  "$SCRIPT_DIR/uploaders"

# 05_Kiosk_Server -- not built yet (build order piece 2). Its pm2 start goes here.

# Register PM2 as a systemd service so it auto-starts on every reboot.
# This must run BEFORE pm2 save — the save writes the process list that the
# generated pm2-root.service will resurrect on boot.
log "Registering PM2 systemd startup hook..."
sudo pm2 startup systemd
log "PM2 startup hook registered — OK"

# Persist PM2 process list so it survives reboot
log "Saving PM2 process list (sudo pm2 save)..."
sudo pm2 save
log "PM2 list saved"

# --------------------------------------------------------------------------- #
# 4. Final status summary
# --------------------------------------------------------------------------- #
section "4. Final status summary"

log "PM2 process list:"
sudo pm2 list

log ""
log "================================================================"
log "  SETUP COMPLETE"
log "  Useful debugging commands:"
log "    sudo pm2 logs                          # tail all PM2 logs"
log "    sudo pm2 logs <name>                   # tail one process"
log "    sudo pm2 monit                         # live dashboard"
log "================================================================"
