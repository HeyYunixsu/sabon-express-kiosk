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
