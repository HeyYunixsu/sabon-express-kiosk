# Piece 5: Install Runbook for a Kiosk Pi

**Date:** 2026-09-30 · **Status:** design approved by the owner.
**Who installs:** us, a few kiosks — people comfortable pasting commands into a
Pi terminal over SSH. Not a field technician, not cloned SD cards.

## Why

The first kiosk Pi (2026-09-30) showed what the current install lets through:

1. `CONFIG/config.env` kept the sample IDs (`machineId=1`, `vendorId=` empty),
   then had them swapped. The backend refused every sale for days and nothing
   on the Pi said so.
2. `controller/main` went missing. `setup_and_run.sh` runs `make clean` before
   `make`, so a failed build leaves no controller at all. PM2 still showed
   `01_Dispenser_Controller` "online" (pid N/A); nothing listened on 8080; the
   kiosk said Offline.
3. The install docs are the cashier's: wrong repo (`sabon-vendo-cashier`),
   cashier dashboard, no kiosk screen, staff tablet or IDs.
4. A Pi that ran V1 or the cashier first keeps those PM2 entries:
   `setup_and_run.sh` only *restarts* an entry that exists, so it can keep
   running another folder's programs.

## What gets built

### 1. `check_install.sh` (repo root, new)

Read-only; safe any time. One line per check, `✓` or `✗`, each `✗` followed
by one line saying how to fix it. Ends with `All good` or `N problems`; exit
code 0 or 1.

| Area | Check | ✗ when |
|---|---|---|
| Config | `CONFIG/config.env` exists | missing |
| | `machineId` | empty, or not all digits |
| | `vendorId` | empty, or not a dashed code `8-4-4-4-12` hex |
| | swapped | `machineId` is a dashed code and `vendorId` digits (its own message) |
| | `API_BASE_URL` | empty |
| | staff | no `STAFFn_NAME` with a `STAFFn_PIN_HASH` |
| | `QR_DEMO` | `= 1` (pretend payments; never in a real shop) |
| Controller | `controller/main` | missing |
| | PM2 `01_Dispenser_Controller` | not online, or pid missing/0 |
| | port `SOCKET_PORT` (8080) | nothing listening (`ss -ltn`) |
| Processes | all five PM2 entries `01`–`05` | missing, not online, no pid, or script path outside this folder |
| Kiosk | `http://localhost:KIOSK_PORT/api/state` | no answer, or `"online": false` |
| Sales | files waiting in `TRANSACTION_DIR` | oldest waiting 15 min or more (name prefix is unix seconds); fix line points at `pm2 logs 03_Transaction_Uploader` |
| Boot | `/boot/firmware/config.txt` | lacks `gpio=6,12,15,16,17,18=op,dh`, `gpio=10,13,14,23,24,25=ip,pu`, `dtparam=spi=off`, `dtparam=audio=off` or `enable_uart=0` |
| Screen | `chromium` or `chromium-browser` | not installed |
| | `~/.config/autostart/sabon-kiosk.desktop` | missing, or `Exec` not in this folder |
| | reboot | `pm2-root` service not enabled |
| Old installs | `vendo_gui.service` | active |

The ID rules match `idsProblem` in `kiosk_server/server.js` (the dashboard
warning). `machineId=1` alone is not flagged: it could be a real machine; an
empty `vendorId` is what marks the sample.

Config values are read the way the server reads them: `KEY = VALUE`, spaces
around `=` allowed, one matching pair of quotes stripped, `#` lines skipped.
Checks that need the Pi (PM2, `ss`, systemd, `/boot`) print `–` and are not
counted when their command is missing, so the config checks run anywhere.

### 2. `update.sh` (repo root, new)

1. `git pull --ff-only`. Local edits: stop, list them (`git status --short`),
   say `git checkout -- <file>` for ones not meant.
2. Rebuild the controller only if the pull changed `controller/` or
   `controller/main` is missing: `make` in `controller/`, no `make clean`.
   Build fails: stop, print the error, the old controller keeps running.
3. `sudo pm2 restart` the five processes, then `sudo pm2 save`.
4. Run `check_install.sh`; its exit code is `update.sh`'s.

### 3. `setup_and_run.sh` (changed)

- No `make clean` before `make`. The Makefile tracks header dependencies
  (`.d` files); a clean build stays one `make clean` away by hand.
- Each of the five PM2 entries is `pm2 delete`d (if present) and started
  fresh instead of restarted, so it always runs this folder's program.
- Runs `check_install.sh` at the end.

### 4. The guide

`docs/QUICK_INSTALL.md` becomes the kiosk runbook, paste in order:

0. Before you start: Raspberry Pi OS 64-bit (desktop) via Imager with user,
   Wi-Fi and SSH set; a cable for the install if possible.
1. Base packages.
2. Boot config, then reboot (today's block, unchanged).
3. Clone `https://github.com/HeyYunixsu/sabon-express-kiosk` into
   `~/Desktop/sabon-express-kiosk`.
4. `config.env` from the sample, with a table: `machineId` = the number,
   `vendorId` = the long dashed code, `API_BASE_URL`, `KIOSK_LETTER` /
   `KIOSK_NAME`, staff PINs via `node kiosk_server/tools/hash_pin.js <4
   digits>`, `STAFF_TABLET`, product names. Box: moving from an old Pi, copy
   `config.env` and `prices.conf`.
5. `./install_dependencies.sh`.
6. `./setup_and_run.sh` (ends with the check).
7. `./check_install.sh` — all ✓ before going on.
8. Hardware tests and pump calibration (unchanged).
9. Staff tablet: `http://<pi-ip>:3000/staff` on the shop Wi-Fi.

Plus **Updating later** (`./update.sh`) and **This Pi ran V1 or the cashier
before**: `sudo systemctl disable --now vendo_gui.service`, run
`setup_and_run.sh`, delete the old folder only once its `transaction/` is empty.

`docs/INSTALLATION.md` stays the reference ("why" and troubleshooting): fix the
cashier-only parts (repo name, the cashier dashboard) and add two entries —
*Offline while PM2 says online* (controller binary missing) and *Sales refused
by the cloud* (IDs). Both docs lose the "copied from the cashier" notices;
CLAUDE.md's status table marks piece 5 done and lists the two new scripts.

## Testing

- PC (Git Bash): `bash -n` on the three scripts; a test running
  `check_install.sh` against sample configs in a temp folder — empty IDs,
  swapped IDs, right IDs, no staff PIN, `QR_DEMO = 1` — checking the ✓/✗
  lines and the exit code.
- Pi: the owner runs `./update.sh` and pastes the output; every ✗ is a real
  finding or a bug in the check.

## Not in this piece

An interactive installer, SD-card imaging, and automatic fixes: the check says
what is wrong, a person fixes it.
