# Installing on a New Raspberry Pi

Copy-paste runbook for provisioning a fresh Pi from a blank OS image to a
running machine. Every command is meant to be pasted as-is except where a
`<placeholder>` appears.

Read section 0 before pasting anything — two of the steps need a reboot, and
doing them in the wrong order costs you a full rebuild.

**Order matters:**

```
0. Prep          -> 1. Boot config (REBOOT)  -> 2. Get the code
3. config.env    -> 4. Dependencies          -> 5. Build & launch
6. Verify        -> 7. Calibrate sensors    -> 7b. Calibrate pumps
```

---

## 0. Before you start

### Use a wired connection if you can

You are about to pull ~100 MB of packages, build WiringPi from source, and run
an npm install. On marginal WiFi these fail halfway and leave apt in a
part-finished state. Ethernet avoids an entire class of problem.

Check the link quality if you must use WiFi:

```bash
iwgetid
cat /proc/net/wireless      # link quality under ~40/70 is trouble
```

### Work inside tmux

If SSH drops mid-install, tmux keeps the install running.

```bash
sudo apt install -y tmux
tmux new -s setup
```

Reattach after a dropped connection with `tmux attach -t setup`.

### Wait out the background updater

Raspberry Pi OS runs `packagekitd` after boot and it holds the apt lock. If you
see `Could not get lock /var/lib/apt/lists/lock`, that is what has it.

```bash
while sudo fuser /var/lib/apt/lists/lock >/dev/null 2>&1; do
  echo "apt still locked, waiting..."; sleep 10
done; echo "lock free"
```

### Force apt to IPv4

Pi IPv6 is often half-configured, and apt burns minutes timing out on it.

```bash
echo 'Acquire::ForceIPv4 "true";' | sudo tee /etc/apt/apt.conf.d/99force-ipv4
sudo apt update
```

---

## 1. Boot configuration — GPIO pull-ups and safe pump states

**Do this first. It needs a reboot, and skipping it causes phantom button
presses and pumps that run dry during boot.**

Two separate problems this solves.

**Buttons** are wired GPIO to GND (active-low), so each input needs a pull-up to
have a defined level when the button is not pressed. WiringPi's pull control is
unreliable on current Debian, so it is set at firmware level instead.

**Pump relays are active-low** — a LOW input switches the pump ON. On the Pi,
GPIO 9–27 power up with a pull-DOWN, which means five of the six pump relays sit
**energized from power-on until the controller starts**. That is 30+ seconds of
a pump running dry on every boot. Driving them HIGH at firmware init fixes it.

**Serial, SPI and audio** claim pins this machine's slot map also uses — serial
is GPIO 14/15, SPI0 is GPIO 7–11 (LED6, water 5, water 6, BTN4, water 4), audio
is GPIO 18/19 — so all three are disabled below, unconditionally, rather than
only when found already on.

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

If the Pi does not boot, put the SD card in a PC and copy the two `.bak`
files back over `config.txt` and `cmdline.txt`.

Verify after the reboot:

```bash
pinctrl get 10,13,14,23,24,25              # each: ip    pu | hi   (nothing plugged in)
pinctrl get 6,12,15,16,17,18               # each: op    dh | hi   (pumps off)
tr ' ' '\n' < /proc/cmdline | grep console  # only: console=tty1
```

> **`raspi-gpio: command not found`** — on Debian trixie (kernel 6.18+) the tool
> was replaced by `pinctrl`, shipped in `raspi-utils`. Use the commands above.
> On an older Pi OS the equivalents are `raspi-gpio get ...`, reporting
> `func=INPUT pull=UP` and `func=OUTPUT level=1`. If neither is present,
> `sudo apt install -y raspi-utils`.
>
> This check is worth doing rather than assuming. If the relay pins are not
> driven high, five of the six pumps run dry for the first 30 seconds of every
> boot, and nothing in the software will tell you. You can also confirm the
> lines were appended at all with `tail -6 /boot/firmware/config.txt`.

> **Water sensor pins are deliberately absent from this list.** They are pulled
> up in Python instead. `RPi.GPIO` defaults to `PUD_OFF` and *actively writes*
> it, so `GPIO.setup()` would undo a boot-time pull seconds after startup.
> `water_level_monitoring.py` sets `PUD_UP` itself.

---

## 2. Get the code

```bash
cd ~/Desktop
git clone https://github.com/HeyYunixsu/sabon-express-kiosk.git
cd sabon-express-kiosk
git log --oneline -1
```

---

## 3. Create `config.env`

`CONFIG/config.env` is **gitignored** — it will not arrive with the clone, and
it is the one file you must create by hand on every machine.

```bash
cd ~/Desktop/sabon-express-kiosk
cp CONFIG/config.env.sample CONFIG/config.env
nano CONFIG/config.env
```

Two values are machine-specific and must be set:

| Key | What to put |
|-----|-------------|
| `machineId` | This machine's **number** — unique per Pi, and must match the backend |
| `vendorId` | The vendor's **long code with dashes**, from the backend |

Swapping them, or leaving the sample's empty `vendorId`, makes the backend
refuse every sale ([Sales refused by the backend](#sales-refused-by-the-backend)).
Leave `TRANSACTION_DIR` unset: it defaults to `<repo>/transaction`.

Everything else has a working default, but three groups are worth setting now
rather than discovering later:

| Key | Why |
|-----|-----|
| `PRODUCT1_NAME`–`PRODUCT6_NAME`, `PRODUCT1_ML`–`PRODUCT6_ML` | What is actually in each tank. The kiosk screen, the staff page and the sales report all label themselves from these. Left unset, every machine claims to sell "Product 1". |
| `PRICE1`–`PRICE6` | What a press costs, in whole pesos. **Unset means ₱5 for everything**, so takings will be wrong until these match the shop's real prices. Also editable later from the staff page (Inventory), which keeps an audit log. |
| `ARM_TIMEOUT_SECONDS` | How long paid presses stay on the machine before they expire to the unclaimed log, default 300. Anyone standing at the machine can dispense them in that window, so keep it no longer than customers actually need. |

Log paths (`PRIME_LOG`, `INTERRUPTED_LOG`, `UNCLAIMED_LOG`, `SETTLEMENT_LOG`,
`SALES_ARCHIVE_DIR`) all default sensibly under `<repo>/logs/`. If you do set
them, **use absolute paths** — a relative value is resolved differently by the
controller and the kiosk server, and they will silently read and write different
files. And never point one inside `TRANSACTION_DIR`: the uploader POSTs every
file in there to the cloud as a sale.

See [CONFIG/README.md](../CONFIG/README.md) for every key.

If you are replacing a machine, copy `calibrateProduct1`–`calibrateProduct6`
from the old Pi — those are physically measured per-pump flow rates and cannot
be guessed.

---

## 4. Install system dependencies

```bash
cd ~/Desktop/sabon-express-kiosk
./install_dependencies.sh 2>&1 | tee install_dependencies.log
```

Installs WiringPi (built from source), Node.js 20.x, PM2 and journalctl. Safe to
re-run; it skips anything already present.

> **If it fails on the Node.js version check**, see
> [Node.js is too old](#nodejs-is-too-old-or-npm-is-missing) in troubleshooting.
> Debian trixie ships 20.19.2, which is below the script's 20.19.5 minimum, and
> its `nodejs` package does not include `npm`.

---

## 5. Build and launch

```bash
cd ~/Desktop/sabon-express-kiosk
./setup_and_run.sh 2>&1 | tee setup_run.log
```

This builds the controller, creates the Python venv,
registers all five processes with PM2, persists them for auto-start on boot, and runs ./check_install.sh.

Run the test suite too — it catches a bad build before the hardware does:

```bash
cd controller && make test
```

Expect **0 failed** on the last line.

---

## 6. Verify

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

---

## 7. Calibrate the water sensors

The sensors report a raw GPIO level; which level means "empty" depends on how
they are wired. Watch the decoded state:

```bash
sudo pm2 logs 01_Dispenser_Controller --lines 0 | grep --line-buffered "Water level"
```

One line per second: `Water level: s1=ok s2=ok s3=ok s4=ok s5=ok s6=ok`
(`ok` = has liquid, `E` = empty).

Move a float by hand. **Float up should read `ok`, float down should read `E`.**

If every slot reads backwards, flip the polarity — no rebuild needed:

```bash
nano CONFIG/config.env      # set WATER_SENSOR_EMPTY_HIGH to 0 (or back to 1)
sudo pm2 restart 01_Dispenser_Controller
```

If only *some* slots are backwards, that is wiring, not software — those sensors
are wired opposite to the others. All six must be wired the same way.

> **Fail-safe note:** the default of `1` means a disconnected sensor reads HIGH,
> which reads as empty and blocks the pump. If you set it to `0`, a broken
> sensor wire looks like "has liquid" and the pump can run dry. If your floats
> close on falling, consider flipping the float physically instead.

---

## 7b. Calibrate the pumps

Separate from the water sensors, and easy to skip because nothing complains.
`calibrateProductN` sets how many **seconds** the pump runs per press, which is
what decides how much liquid the customer gets for their money.

**If the key is absent the controller uses compiled-in defaults measured on a
different machine.** It boots clean, the kiosk looks right, the logs look
right, and every pour is the wrong size. Check what is actually loaded:

```bash
sudo pm2 logs 01_Dispenser_Controller --lines 30 --nostream | grep "Slot "
```

`RUN_MS` is the duration in milliseconds. The compiled defaults are
`2777, 1363, 1250, 2000, 2000, 2000` — if you see exactly those, nothing has
been calibrated on this machine.

### Measuring

Use **Air clear** on the staff page (Kiosk Health), which runs one nozzle for
`PRIME_SECONDS` (default 3) without recording a sale.

1. Put a measuring cup under the nozzle for the slot you are calibrating.
2. Prime once first, to fill the tube — air in the line ruins the measurement.
3. Empty the cup, tap **Air clear** once more, and measure what comes out.
4. Work out the seconds for the volume you sell:

```
seconds = PRODUCTn_ML / (measured_ml / PRIME_SECONDS)
```

Worked example: slot 3 sells 60 ml (`PRODUCT3_ML = 60`), a 3-second prime
yields 45 ml. Flow is 45 / 3 = 15 ml/s, so `seconds = 60 / 15 = 4.0`:

```
calibrateProduct3 = (5, 4.0)
```

The first number is ignored when `PRICE3` is set — leave it at 5.

5. Repeat per slot. They genuinely differ: pump, tube length and how thick the
   liquid is all change the flow rate, which is why these cannot be copied
   between machines.
6. Restart and confirm the new values took:

```bash
sudo pm2 restart 01_Dispenser_Controller
sudo pm2 logs 01_Dispenser_Controller --lines 30 --nostream | grep "Slot "
```

7. Verify by selling one press and measuring it. It should land within a few
   millilitres of `PRODUCTn_ML`.

---

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

---

## Troubleshooting

### `git pull` aborts: "local changes would be overwritten"

Usually `setup_and_run.sh` or `install_dependencies.sh`. Older revisions of this
guide told you to `chmod +x` them; git tracks the executable bit, so that chmod
registered as a modification and blocked every later pull. Both files now carry
the executable bit in the repo and the chmod step is gone.

Nothing of yours is at risk here -- the change is a file mode, not content:

```bash
cd ~/Desktop/sabon-express-kiosk
git status --short          # confirm only these scripts are listed
git checkout -- setup_and_run.sh install_dependencies.sh
git pull
```

If `git status` lists anything else, look before discarding it. `CONFIG/config.env`
is gitignored and will never appear or be touched by a pull.

### apt: "Could not get lock"

`packagekitd` holds it after boot. Wait it out with the loop in section 0, or:

```bash
sudo systemctl mask --now packagekit
# ... run your install ...
sudo systemctl unmask packagekit          # do not forget this
```

Never `rm` the lock file while an apt process is running.

### Downloads fail with "Network is unreachable"

The Pi lost its route, not a mirror problem.

```bash
ip -br a
ip route                # no "default via ..." line = no gateway
ping -c3 1.1.1.1        # works but DNS fails = DNS issue
```

If a previous install was killed mid-transaction:

```bash
sudo dpkg --configure -a
```

### Node.js is too old, or npm is missing

Debian trixie's `nodejs` is 20.19.2 (below the 20.19.5 the script wants) and
does **not** include npm. If NodeSource failed to install — usually because it
could not fetch `curl` and `gnupg` — install those first, then retry:

```bash
sudo apt install -y curl gnupg
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node --version && npm --version
```

Confirm you got the NodeSource build, not Debian's:

```bash
apt-cache policy nodejs      # should show deb.nodesource.com
```

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
`sudo pm2 restart 01_Dispenser_Controller 05_Kiosk_Server`. Sales already
waiting in `transaction/` keep the IDs they were written with:

```bash
cd ~/Desktop/sabon-express-kiosk
sudo pm2 stop 03_Transaction_Uploader
sudo cp -r transaction ~/transaction_backup_$(date +%F_%H%M)
sudo python3 - <<'EOF'
import json, glob, re
env = {}
for line in open('CONFIG/config.env'):
    if '=' in line and not line.lstrip().startswith('#'):
        k, v = line.split('=', 1); env[k.strip()] = v.strip().strip('"\'')
m, v = env.get('machineId', ''), env.get('vendorId', '')
assert m.isdigit(), 'machineId must be the machine NUMBER'
assert re.fullmatch(r'[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}', v), 'vendorId must be the long code with dashes'
n = 0
for p in glob.glob('transaction/*_transaction_*.json'):
    d = json.load(open(p))
    if d.get('machine_id') == m and d.get('vendor_id') == v: continue
    d['machine_id'], d['vendor_id'] = m, v
    json.dump(d, open(p, 'w'), indent=2); n += 1
print('fixed', n, 'files')
EOF
sudo pm2 start 03_Transaction_Uploader
```

The staff page warns about this ("Sales are not reaching the cloud").

### A button fires by itself

Its pull-up is missing. Confirm section 1 was applied and that you rebooted:

```bash
raspi-gpio get 10,13,14,23,24,25    # each must show pull=UP
```

### One water sensor never changes

```bash
raspi-gpio get 26,20,21,11,8,9      # compare the dead one against a working one
```

- **`func=ALT0`** — SPI has claimed the pin. See the SPI note in section 1.
- **`func=INPUT pull=UP` but the level never moves** — hardware. Swap that
  sensor's connector with a working slot's. If the fault follows the sensor it
  is the sensor or its wire; if it stays on the slot, move that channel to a
  free plain GPIO and update `WATER_GPIO_PIN_n` in `config.env`.

### A relay behaves opposite to the others

`PUMP_TRIGGER_HIGH`/`PUMP_TRIGGER_LOW` are **global** — every relay must use the
same polarity. Test a channel with the software stopped:

```bash
sudo pm2 stop 01_Dispenser_Controller
pinctrl set 6 op dh     # relay OFF   (use raspi-gpio set if pinctrl is absent)
pinctrl set 6 op dl    # relay ON
sudo pm2 start 01_Dispenser_Controller
```

### Nothing works after a reboot

```bash
sudo pm2 list
sudo systemctl status pm2-root
```

If PM2 is empty, the process list was never saved:

```bash
sudo pm2 startup systemd
sudo pm2 save
```

### Useful commands

```bash
./check_install.sh                        # is everything right?
sudo pm2 logs                             # all processes
sudo pm2 logs 01_Dispenser_Controller     # one process
sudo pm2 monit                            # live CPU/memory
sudo pm2 restart 01_Dispenser_Controller
nc -zv <pi-ip> 8080                       # is the controller reachable
```

---

## Related documentation

| Document | Covers |
|----------|--------|
| [SYSTEM_REFERENCE.md](SYSTEM_REFERENCE.md) | Protocol, wire formats, every component |
| [BUTTON_WIRING_DEBUG.md](BUTTON_WIRING_DEBUG.md) | Pin map, active-low wiring, debug history |
| [../CONFIG/README.md](../CONFIG/README.md) | Every `config.env` key |
| [../controller/README.md](../controller/README.md) | Controller architecture and socket protocol |
