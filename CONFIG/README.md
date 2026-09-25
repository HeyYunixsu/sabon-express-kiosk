# CONFIG — Centralized Configuration

`config.env` is the single configuration file shared by all components in this project. It is **gitignored** — copy `config.env.sample` to create it before running anything.

```bash
cp config.env.sample config.env
# Edit config.env with the correct values for this machine
```

---

## All Available Keys

### Identity

| Key | Example | Description |
|-----|---------|-------------|
| `vendorId` | `abc123` | Vendor identifier, sent with every transaction and API call |
| `machineId` | `5` | Machine identifier, sent with every transaction and API call |

### API

| Key | Default | Description |
|-----|---------|-------------|
| `API_BASE_URL` | `https://office.dynamicglobalsoft.com:1232` | Base URL for all cloud API calls |

### Socket server (`controller`)

| Key | Default | Description |
|-----|---------|-------------|
| `SOCKET_IP` | `127.0.0.1` | IP address that clients use to reach `controller` |
| `SOCKET_PORT` | `8080` | TCP port for the `controller` server |

### controller runtime

| Key | Default | Description |
|-----|---------|-------------|
| `SERVER_PORT` | `8080` | Port `controller` binds to (should match `SOCKET_PORT`) |
| `TRANSACTION_DIR` | `../transaction` | Directory where `controller` writes JSON transaction files |

### Cashier dashboard

| Key | Default | Description |
|-----|---------|-------------|
| `DASHBOARD_PORT` | `80` | HTTP port for the dashboard. 80 needs root, which is why PM2 runs it via sudo |

### Slot hardware (BCM pin numbers)

One button, one LED and one pump relay per slot, all independent.

| Key | Default | Description |
|-----|---------|-------------|
| `BTN1`-`BTN6` | `14 24 25 10 13 23` | Button input per slot. Wired to GND, so each needs `gpio=N=ip,pu` in `/boot/firmware/config.txt` |
| `PUMP1`-`PUMP6` | `15 16 6 17 18 12` | Pump relay output per slot |
| `LED1`-`LED6` | `5 27 4 22 19 7` | Slot LED output |
| `PUMP_TRIGGER_HIGH` | `0` | Level that switches a pump ON (the relays are active-low) |
| `PUMP_TRIGGER_LOW` | `1` | Level that switches a pump OFF |

### Product calibration

| Key | Example | Description |
|-----|---------|-------------|
| `calibrateProduct1`-`calibrateProduct6` | `(5, 2.777778)` | `(price, seconds)` - legacy pairing. The seconds are the pour calibration and are still read from here; the price is only used when `PRICEn` is absent |

### Products

| Key | Example | Description |
|-----|---------|-------------|
| `PRODUCT1_NAME`-`PRODUCT6_NAME` | `Fabcon 1` | What is loaded in that slot. Shown on the dashboard and used to label the local sales report |
| `PRODUCT1_ML`-`PRODUCT6_ML` | `60` | Millilitres per press, for display only. The pump is timed by `calibrateProductN` |

These were hardcoded in `index.html`, so every machine claimed to sell the same
six things regardless of what was actually in the tanks. They are per client
now. **The cloud receives only the slot number**, so keep a record of which
product each slot holds on each machine - otherwise a report built elsewhere
can only say "slot 3".

### Local sales archive

| Key | Default | Description |
|-----|---------|-------------|
| `SALES_ARCHIVE_DIR` | `<repo>/logs/sales` | Where `transaction_uploader.py` appends each confirmed sale, one JSON object per line, one file per month |

The uploader deletes every transaction file the moment the cloud accepts it, so
without this the machine remembers nothing of its own trading. The archive is
written from the record the cloud acknowledged, so the two cannot drift, and
the dashboard reads it plus anything still queued - a day stays complete even
if the link has been down since morning.

### Interrupted sales

| Key | Default | Description |
|-----|---------|-------------|
| `INTERRUPTED_LOG` | `<repo>/logs/interrupted_sales.jsonl` | Dispenses cut short by an empty tank: slot, amount charged, reason, time |

When a tank runs dry part-way through a pour the controller closes the
dispense immediately - records the sale at full price, frees the slot, and
appends here. The dashboard shows today's entries under **Needs Attention** so
staff can settle the partial pour with the customer.

Full price is deliberate: it is what the customer was charged. Recording less
would under-report revenue, and recording nothing - the old behaviour - left
the drawer short with nothing to explain it.

### Unclaimed credits

| Key | Default | Description |
|-----|---------|-------------|
| `UNCLAIMED_LOG` | `<repo>/logs/unclaimed_credits.jsonl` | Credits paid for but never dispensed - expired at the timeout, or cancelled by the cashier: slot, qty, amount, reason, time |

An armed slot's credits are written off here if the customer never presses the
button before `ARM_TIMEOUT_SECONDS` runs out (`reason: "timeout"`), or if the
cashier cancels the sale first (`reason: "cancelled"`). Neither is a sale, so
this file must stay outside `TRANSACTION_DIR` - the uploader treats every file
in there as a sale to POST to the cloud.

### Prices

| Key | Default | Description |
|-----|---------|-------------|
| `PRICE1`-`PRICE6` | first value of `calibrateProductN` | Price per press, whole pesos. Becomes the transaction `amount` sent to the cloud |
| `PRICES_FILE` | `<repo>/CONFIG/prices.conf` | Prices saved from the dashboard. **Overrides `PRICEn`** at startup |
| `PRICE_LOG` | `<repo>/logs/price_changes.jsonl` | Append-only audit of every price change: slot, old value, new value, timestamp |

Resolution order, last one wins:

1. compiled defaults
2. the first value of `calibrateProductN` (legacy layout)
3. `PRICEn`
4. `PRICES_FILE`

Price and pour duration are deliberately separate keys. Price is commercial and
changes with the market; duration is physical and set once at install. Keeping
them in one tuple meant a price edit could fat-finger how much liquid comes out.

Prices are editable from the dashboard (Settings -> Prices) so a client can set
their own without a site visit. That is also a way to make sales look smaller
than they were, so the controller refuses a change while any sale is armed, and
writes every change to `PRICE_LOG` with the value it replaced. The log is the
control: it cannot stop a price being lowered, only stop it being lowered
quietly.

### Prime / purge

| Key | Default | Description |
|-----|---------|-------------|
| `PRIME_SECONDS` | `3` | Length of one prime burst, in seconds. Clamped to `0.5`-`15` by the controller, because an over-long burst empties a gallon onto the floor with nobody at the machine |
| `PRIME_LOG` | `<repo>/logs/prime_events.jsonl` | Where prime events are appended, one JSON object per line. **Must stay outside `TRANSACTION_DIR`** - the uploader treats every file in there as a sale to POST to the cloud |
| `ARM_TIMEOUT_SECONDS` | `300` | How long an armed slot's button stays live before its credits are written off. Clamped to `30`-`1800` seconds by the controller - the button is physically live for the whole window, so raise it only as far as the counter actually needs |

Priming clears air from a hose after a gallon change, so the next customer is
not charged for a press that dispenses air. A prime moves product and records
**no sale**, which is also what someone stealing from the till would want, so
every prime is written to `PRIME_LOG` and counted back to staff on the
dashboard's Maintenance panel. Nothing is ever written to the transaction
directory by a prime - not even a zero-peso record.

### Water level sensors (`uploaders`)

| Key | Default | Description |
|-----|---------|-------------|
| `WATER_GPIO_PIN_1` | `26` | BCM GPIO pin for slot 1 water sensor |
| `WATER_GPIO_PIN_2` | `20` | BCM GPIO pin for slot 2 water sensor |
| `WATER_GPIO_PIN_3` | `21` | BCM GPIO pin for slot 3 water sensor |
| `WATER_GPIO_PIN_4` | `11` | BCM GPIO pin for slot 4 water sensor |
| `WATER_GPIO_PIN_5` | `8` | BCM GPIO pin for slot 5 water sensor |
| `WATER_GPIO_PIN_6` | `9` | BCM GPIO pin for slot 6 water sensor |
| `WATER_SENSOR_EMPTY_HIGH` | `1` | Which level means empty. `1` = empty reads HIGH, `0` = empty reads LOW. Sensors are wired to GND with a pull-up, so a disconnected one reads HIGH; the default therefore treats a dead sensor as empty and blocks the pump rather than letting it run dry |

Sensor pins are read only by `water_level_monitoring.py`, which pulls them
up internally and forwards the raw levels. `WATER_SENSOR_EMPTY_HIGH` is what
`controller` uses to interpret those levels.

---

## File location

All Python scripts load config using:
```python
from pathlib import Path
from dotenv import load_dotenv
load_dotenv(Path(__file__).parent / ".." / "CONFIG" / "config.env")
```

The `controller` C++ binary loads it via `utils::loadEnv("../CONFIG/config.env")` at startup.
