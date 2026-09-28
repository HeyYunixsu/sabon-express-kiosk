# Quick Install — New Raspberry Pi

> **Copied from the cashier product, not yet adapted.** Boot config, wiring, hardware tests and calibration apply to a kiosk Pi as written. The repo name, the cashier dashboard and the tablet steps do not: they are rewritten in build piece 5 (install runbook).

Paste each block in order. Replace anything in `<angle brackets>`.
The reasons behind every step are in [INSTALLATION.md](INSTALLATION.md).

```
1. Base packages  ->  2. Boot config (REBOOT)  ->  3. Get the code
4. config.env     ->  5. Dependencies          ->  6. Build & launch
7. Verify         ->  8. Test the hardware     ->  9. Calibrate
```

Before you start: flash **Raspberry Pi OS (64-bit)** with Raspberry Pi Imager,
set the username, WiFi and SSH in Imager, then boot and log in.
Ethernet is safer than WiFi for the install.

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
git clone https://github.com/HeyYunixsu/sabon-vendo-cashier.git
cd sabon-vendo-cashier
git log --oneline -1
```

---

## 4. Create `config.env`

`config.env` is not in git. Every machine needs its own.

**Replacing an old Pi?** Copy its settings and saved prices across instead of
starting from the sample (the old Pi must be on the same network):

```bash
cd ~/Desktop/sabon-vendo-cashier
scp <user>@<old-pi-ip>:~/Desktop/sabon-vendo-cashier/CONFIG/config.env  CONFIG/config.env
scp <user>@<old-pi-ip>:~/Desktop/sabon-vendo-cashier/CONFIG/prices.conf CONFIG/prices.conf
```

If this Pi's username differs from the old one, fix the paths it copied:

```bash
sed -i "s|/home/[^/]*/Desktop/sabon-vendo-cashier|$HOME/Desktop/sabon-vendo-cashier|g" CONFIG/config.env
```

Then skip to the `nano` line below and only check `machineId`.

**Brand-new machine?** Start from the sample and fix its paths for this Pi:

```bash
cd ~/Desktop/sabon-vendo-cashier
cp CONFIG/config.env.sample CONFIG/config.env
sed -i "s|/home/dgsi/|$HOME/|g; s|sabon_vendo_cashier|sabon-vendo-cashier|g" CONFIG/config.env
grep -nE '^TRANSACTION_DIR|_LOG *=|ARCHIVE_DIR|PRICES_FILE' CONFIG/config.env
```

Every path printed should start with your own home folder.

Now edit it:

```bash
nano CONFIG/config.env
```

Set at least these (save with `Ctrl+O`, `Enter`, exit with `Ctrl+X`):

| Key | Set it to |
|-----|-----------|
| `machineId` | This machine's number. **Must match the backend exactly, and be unique per Pi.** |
| `vendorId` | The vendor UUID from the backend |
| `API_BASE_URL` | The backend address, including the port it actually answers on |
| `PRICE1`–`PRICE6` | Price per press, whole pesos |
| `PRODUCT1_NAME`–`PRODUCT6_NAME` | What is in each tank |
| `PRODUCT1_ML`–`PRODUCT6_ML` | Millilitres per press |
| `calibrateProduct1`–`6` | Leave for now — set in step 9 |

Check the backend is reachable on that port (any number back means it is up;
`Connection refused` means wrong port or the API is down):

```bash
curl -sS -m 5 -o /dev/null -w '%{http_code}\n' "$(sed -n 's/^API_BASE_URL *= *"\(.*\)"/\1/p' CONFIG/config.env)/api/v1/auth/machine/transaction"
```

---

## 5. Install dependencies

Installs WiringPi, Node.js 20, PM2 and log rotation. Takes a while.

```bash
cd ~/Desktop/sabon-vendo-cashier
./install_dependencies.sh 2>&1 | tee install_dependencies.log
```

If it stops on the Node.js version check, see
[Node.js is too old](INSTALLATION.md#nodejs-is-too-old-or-npm-is-missing).

---

## 6. Build and launch

Builds the controller, sets up Python, installs the dashboard, and registers
all five processes to start on every boot.

```bash
cd ~/Desktop/sabon-vendo-cashier
./setup_and_run.sh 2>&1 | tee setup_run.log
```

Run the tests (a few minutes — the press tests wait for real pours):

```bash
cd ~/Desktop/sabon-vendo-cashier/controller && make test; cd ..
```

The last line must say `0 failed`.

---

## 7. Verify

```bash
sudo pm2 list                                   # 5 processes, all online
sudo ss -tlnp | grep -E ':80 |:8080 '          # :8080 = main, :80 = node
sudo pm2 logs 01_Dispenser_Controller --lines 80 --nostream | grep -E "Slot [1-6]: BTN=|Buttons|reading LOW|Button hold|Water sensor"
hostname -I                                     # the Pi's address
```

In the controller lines, look for `Buttons: all 6 resting HIGH`.
If it says `reading LOW`, the named buttons are wired wrong or pulled down by
something — fix that before going on.

Open the dashboard in a browser: `http://<pi-ip>/` (no port number).

---

## 8. Test the hardware

### Buttons

```bash
cd ~/Desktop/sabon-vendo-cashier/controller/tools
g++ -o test_buttons test_buttons.cpp -lwiringPi
sudo ./test_buttons
```

Press each button once. Every one must print `>>> PRESSED` then `<<< RELEASED`.
`Ctrl+C` to quit.

> `test_buttons` uses the default pins (14, 24, 25, 10, 13, 23). If you changed
> any `BTNn` in `config.env`, check that pin with `watch -n 0.3 pinctrl get <gpio>`
> instead — it must read `hi` at rest and `lo` while pressed.

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

## Optional: cashier tablet as a kiosk

See [KIOSK.md](KIOSK.md).

---

## Updating this Pi later

```bash
cd ~/Desktop/sabon-vendo-cashier
git pull
./setup_and_run.sh 2>&1 | tee setup_run.log
```

If `git pull` says *local changes would be overwritten*, run `git status --short`,
then `git checkout -- <that file>` for anything listed that you did not mean to
change, and pull again. `config.env` is never touched by a pull.

---

## Quick reference

```bash
sudo pm2 list                                  # what is running
sudo pm2 logs 01_Dispenser_Controller          # live controller log
sudo pm2 restart 01_Dispenser_Controller       # after editing config.env
pinctrl get 10,13,14,23,24,25                  # button pins
```
