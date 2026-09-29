#!/bin/bash
# =============================================================================
# install_dependencies.sh
# Sabon Express Dispenser — WiringPi, FLTK, Node.js & PM2 Prerequisite Installer
#
# Run this ONCE before setup_and_run.sh, on a fresh Raspberry Pi.
#
# Usage:
#   chmod +x install_dependencies.sh
#   ./install_dependencies.sh
#
# To capture full output for debugging:
#   ./install_dependencies.sh 2>&1 | tee install_dependencies.log
# =============================================================================

set -euo pipefail

# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_PREFIX="[install_dependencies]"

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

for cmd in git sudo apt dpkg g++; do
  if ! command -v "$cmd" &>/dev/null; then
    err "'$cmd' not found — cannot continue."
    exit 1
  else
    log "'$cmd' found: $(command -v "$cmd")"
  fi
done

# --------------------------------------------------------------------------- #
# 1. System update
# --------------------------------------------------------------------------- #
section "1. System update"

log "Running apt update..."
sudo apt update
log "apt update — OK"

# --------------------------------------------------------------------------- #
# 2. Install WiringPi (from source)
# --------------------------------------------------------------------------- #
# The apt package for WiringPi is outdated / removed from Raspbian repos.
# We build the .deb from the official GitHub source and install it locally.
# Reference: controller/basic_command.txt
# --------------------------------------------------------------------------- #
section "2. Installing WiringPi (from source)"

# Check if already installed
if command -v gpio &>/dev/null; then
  log "WiringPi is already installed (gpio version: $(gpio -v 2>/dev/null | head -1 || echo 'unknown'))"
  log "Skipping WiringPi build."
else
  WIRINGPI_BUILD_DIR="$(mktemp -d)"
  log "Build directory: $WIRINGPI_BUILD_DIR"

  # Install build dependencies
  log "Installing build dependencies (git, make, gcc)..."
  sudo apt install -y git make gcc
  log "Build dependencies installed — OK"

  log "Cloning WiringPi repository..."
  git clone https://github.com/WiringPi/WiringPi.git "$WIRINGPI_BUILD_DIR/WiringPi"
  log "Clone — OK"

  pushd "$WIRINGPI_BUILD_DIR/WiringPi" > /dev/null

  log "Building WiringPi debian package..."
  ./build debian
  log "Build — OK"

  # The .deb is generated inside debian-template/
  DEB_FILE=$(ls debian-template/wiringpi*.deb 2>/dev/null | head -1 || true)

  if [ -z "$DEB_FILE" ]; then
    err "No .deb file found in debian-template/ — build may have failed."
    popd > /dev/null
    exit 1
  fi

  log "Found .deb: $DEB_FILE"

  # Move it to the build root for a clean install path
  mv "$DEB_FILE" .
  DEB_FILE=$(ls wiringpi*.deb | head -1)

  log "Installing $DEB_FILE..."
  sudo apt install -y "./$DEB_FILE"
  log "WiringPi installed — OK"

  popd > /dev/null

  # Cleanup temp directory
  rm -rf "$WIRINGPI_BUILD_DIR"
  log "Build directory cleaned up"

  # Verify
  if command -v gpio &>/dev/null; then
    log "gpio found: $(gpio -v 2>/dev/null | head -1 || echo 'installed')"
  else
    warn "gpio command not found after install — verify the .deb installed correctly."
  fi
fi

# --------------------------------------------------------------------------- #
# 4. Install Node.js v20.x (LTS) via NodeSource
# --------------------------------------------------------------------------- #
# Minimum required: v20.19.5+
# We use the official NodeSource setup script which pins the major version.
# --------------------------------------------------------------------------- #
section "3. Installing Node.js v20.x"

NODE_MAJOR=20
NODE_MIN_VERSION="20.19.5"

# Helper: compare semver strings (returns 0 if $1 >= $2)
version_gte() {
  printf '%s\n%s\n' "$2" "$1" | sort -V -C
}

INSTALLED_NODE=""
if command -v node &>/dev/null; then
  INSTALLED_NODE="$(node --version | sed 's/^v//')"
  log "Node.js already installed: v${INSTALLED_NODE}"
fi

if [ -n "$INSTALLED_NODE" ] && version_gte "$INSTALLED_NODE" "$NODE_MIN_VERSION"; then
  log "Node.js v${INSTALLED_NODE} satisfies >= v${NODE_MIN_VERSION} — skipping install"
else
  if [ -n "$INSTALLED_NODE" ]; then
    warn "Node.js v${INSTALLED_NODE} is below the required v${NODE_MIN_VERSION} — reinstalling via NodeSource"
  else
    log "Node.js not found — installing via NodeSource (v${NODE_MAJOR}.x)"
  fi

  # Install curl if missing (needed for the NodeSource setup script)
  if ! command -v curl &>/dev/null; then
    log "Installing curl..."
    sudo apt install -y curl
  fi

  log "Downloading NodeSource setup script for Node.js ${NODE_MAJOR}.x..."
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | sudo -E bash -
  log "NodeSource repo configured — OK"

  sudo apt install -y nodejs
  log "Node.js installed — OK"

  INSTALLED_NODE="$(node --version | sed 's/^v//')"
  if version_gte "$INSTALLED_NODE" "$NODE_MIN_VERSION"; then
    log "Node.js v${INSTALLED_NODE} — version check PASSED"
  else
    err "Node.js v${INSTALLED_NODE} still below required v${NODE_MIN_VERSION} — check NodeSource setup."
    exit 1
  fi
fi

log "npm version: $(npm --version)"

# --------------------------------------------------------------------------- #
# 5. Install PM2 v6.x globally via npm
# --------------------------------------------------------------------------- #
# Minimum required: 6.0.13+
# --------------------------------------------------------------------------- #
section "4. Installing PM2 v6.x"

PM2_MIN_VERSION="6.0.13"

INSTALLED_PM2=""
if command -v pm2 &>/dev/null; then
  INSTALLED_PM2="$(pm2 --version 2>/dev/null | head -1 || true)"
  log "PM2 already installed: v${INSTALLED_PM2}"
fi

if [ -n "$INSTALLED_PM2" ] && version_gte "$INSTALLED_PM2" "$PM2_MIN_VERSION"; then
  log "PM2 v${INSTALLED_PM2} satisfies >= v${PM2_MIN_VERSION} — skipping install"
else
  if [ -n "$INSTALLED_PM2" ]; then
    warn "PM2 v${INSTALLED_PM2} is below the required v${PM2_MIN_VERSION} — upgrading"
    sudo npm install -g pm2@latest
  else
    log "PM2 not found — installing latest PM2 v6.x..."
    sudo npm install -g pm2@latest
  fi
  log "PM2 installed — OK"

  # Refresh shell hash so the newly installed pm2 binary is found immediately
  hash -r 2>/dev/null || true

  INSTALLED_PM2="$(pm2 --version 2>/dev/null | head -1 || true)"
  if version_gte "$INSTALLED_PM2" "$PM2_MIN_VERSION"; then
    log "PM2 v${INSTALLED_PM2} — version check PASSED"
  else
    warn "Could not confirm PM2 version (got: '${INSTALLED_PM2}'). Run 'pm2 --version' to verify manually."
  fi
fi

# Configure PM2 to auto-start on boot via systemd.
# All PM2 processes in this project are launched via 'sudo pm2', so they belong
# to root. The startup hook must therefore be configured for root (no -u flag),
# matching the 'sudo pm2 startup systemd' call in setup_and_run.sh.
DISPLAY_USER="$(_detect_display_user)"
log "Detected display user: $DISPLAY_USER"
log "Configuring PM2 startup (systemd) for root (processes are owned by root via sudo pm2)..."
sudo pm2 startup systemd || \
  warn "pm2 startup configuration skipped — run manually if needed: sudo pm2 startup"

# --------------------------------------------------------------------------- #
# 6. Install systemd-journal (journalctl)
# --------------------------------------------------------------------------- #
# journalctl is used to inspect logs for vendo_gui.service and other units.
# It is bundled in the 'systemd' package. On minimal Raspberry Pi OS images it
# may be absent, and 'sudo journalctl' can fail because sudo uses a restricted
# PATH that does not include /usr/bin. We install the package and create a
# symlink in /usr/local/bin so sudo always finds it.
# --------------------------------------------------------------------------- #
# --------------------------------------------------------------------------- #
# 4b. PM2 log rotation
# --------------------------------------------------------------------------- #
# Without this PM2 log files grow without bound on the SD card. Five processes
# writing continuously will eventually fill it, and the write churn is the most
# common way a Pi dies in the field. Caps each file at 10MB and keeps 7.
# --------------------------------------------------------------------------- #
section "4b. Configuring PM2 log rotation"

if sudo pm2 list 2>/dev/null | grep -q "pm2-logrotate"; then
  log "pm2-logrotate already installed"
else
  log "Installing pm2-logrotate..."
  sudo pm2 install pm2-logrotate || warn "pm2-logrotate install failed — logs will grow unbounded"
fi

sudo pm2 set pm2-logrotate:max_size 10M        || warn "could not set max_size"
sudo pm2 set pm2-logrotate:retain 7            || warn "could not set retain"
sudo pm2 set pm2-logrotate:compress true       || warn "could not set compress"
sudo pm2 set pm2-logrotate:rotateInterval '0 0 * * *' || warn "could not set rotateInterval"
log "PM2 log rotation: 10MB per file, 7 kept, compressed"

section "5. Installing journalctl (systemd journal)"

if command -v journalctl &>/dev/null; then
  log "journalctl already available: $(command -v journalctl)"
else
  log "journalctl not found — installing systemd package..."
  sudo apt install -y systemd
  log "systemd package installed — OK"
fi

# Ensure journalctl is reachable via sudo (sudo uses a restricted PATH).
# /usr/local/bin is in sudo's secure_path on Raspbian by default.
JOURNALCTL_BIN="$(command -v journalctl 2>/dev/null || true)"
if [ -n "$JOURNALCTL_BIN" ] && [ ! -e /usr/local/bin/journalctl ]; then
  log "Creating symlink: /usr/local/bin/journalctl -> $JOURNALCTL_BIN"
  sudo ln -sf "$JOURNALCTL_BIN" /usr/local/bin/journalctl
  log "Symlink created — 'sudo journalctl' will now work"
elif [ -e /usr/local/bin/journalctl ]; then
  log "Symlink /usr/local/bin/journalctl already exists — skipping"
else
  warn "journalctl binary not found even after install — check your systemd setup."
fi

# Enable persistent journal storage so logs survive reboots
JOURNAL_CONF="/etc/systemd/journald.conf"
if grep -q "^Storage=persistent" "$JOURNAL_CONF" 2>/dev/null; then
  log "Persistent journal storage already configured"
else
  log "Enabling persistent journal storage in $JOURNAL_CONF..."
  sudo sed -i 's/^#*Storage=.*/Storage=persistent/' "$JOURNAL_CONF"
  # If no Storage line existed at all, append it
  if ! grep -q "^Storage=" "$JOURNAL_CONF" 2>/dev/null; then
    echo "Storage=persistent" | sudo tee -a "$JOURNAL_CONF" > /dev/null
  fi
  sudo systemctl restart systemd-journald || warn "Could not restart systemd-journald — reboot may be required."
  log "Persistent journal storage enabled — OK"
fi

# --------------------------------------------------------------------------- #
# 7. Summary
# --------------------------------------------------------------------------- #
section "6. Summary"

log "================================================================"
log "  DEPENDENCY INSTALLATION COMPLETE"
log ""
log "  Installed:"
log "    - WiringPi   : $(gpio -v 2>/dev/null | head -1 || echo 'check manually')"
log "    - Node.js    : $(node --version 2>/dev/null || echo 'check manually')"
log "    - PM2        : $(pm2 --version 2>/dev/null | head -1 || echo 'check manually')"
log "    - journalctl : $(journalctl --version 2>/dev/null | head -1 || echo 'check manually')"
log ""
log "  You can now run:"
log "    chmod +x setup_and_run.sh"
log "    ./setup_and_run.sh"
log "================================================================"
