# uploaders — Data Sync & Sensor Bridge

## Overview

Three background Python scripts that keep the cloud API and the `controller` socket server in sync:

| PM2 Name | Script | Role |
|----------|--------|------|
| `02_Water_Sensors` | `water_level_monitoring.py` | Reads GPIO water sensors → sends `WTRLVL` to socket |
| `03_Transaction_Uploader` | `transaction_uploader.py` | Watches transaction folder → uploads JSON to cloud API |
| `04_Status_Uploader` | `status_uploader.py` | Polls socket STATUS → uploads machine status to cloud API |

---

## Scripts

### `water_level_monitoring.py`

Reads 4 Raspberry Pi GPIO pins connected to water level sensors (one per soap slot). Every second, sends `WTRLVL,<p1>,<p2>,<p3>,<p4>` to the `controller` socket server, where each value is `1` (slot empty) or `0` (OK).

This is the data source for the slot-empty protection feature in `controller`: when `slotEmpty[i]` is `true`, the pump will not activate even if the customer has credit.

**GPIO pin mapping (BCM numbering):**

| Slot | BCM Pin | Config key |
|------|---------|-----------|
| 1 | 26 | `WATER_GPIO_PIN_1` |
| 2 | 20 | `WATER_GPIO_PIN_2` |
| 3 | 21 | `WATER_GPIO_PIN_3` |
| 4 | 11 | `WATER_GPIO_PIN_4` |

Pins are overridable via `config.env`. Uses `RPi.GPIO` — requires running on a Raspberry Pi.

---

### `transaction_uploader.py`

Watches the `../transaction/` directory (relative to the repo root) for JSON files written by `controller` after each completed dispense. Batches up to 20 files per cycle and POSTs them to the cloud API. Files are deleted after the API confirms success; files that fail to parse are skipped for the rest of the session.

**API endpoint:** `POST /api/v1/auth/machine/transaction`

**Payload format:**
```json
{
  "operations": [
    {
      "machineId": "5",
      "vendorId": "abc",
      "slot": "2",
      "amount": "5.00",
      "dateCreated": "2026-05-21 14:30:00",
      "voucherId": "optional-uuid"
    }
  ]
}
```

**Response:** The API returns `data.success[]` and `data.failed[]` arrays. Files matching `success` entries are deleted; files matching `failed` entries are added to a skip list.

---

### `status_uploader.py`

Maintains a persistent TCP connection to the `controller` socket server. Parses every `STATUS:...` response and, when the water level state of any slot changes, POSTs an update to the cloud API.

**API endpoint:** `POST /api/v1/auth/machine/status`

**Payload format:**
```json
{
  "status": [
    {
      "machineId": 5,
      "status": "ACTIVE",
      "levels": "NORMAL",
      "slot": 1,
      "dateReported": "2026-05-21 14:30:00"
    }
  ]
}
```

`levels` is `"NORMAL"` when the water level reads `0` (slot has soap), `"CRITICAL"` when it reads `1` (empty). Only changed slots are reported per update cycle. Reconnects automatically after disconnection (30-second delay).

Logs errors to `uploaders/client_errors.log` and to stdout.

---

### `qr_gen.py` (utility)

A standalone utility script for generating QR code images. Not part of the production process list — used manually for testing or printing voucher QR codes.

---

## Dependencies

```bash
# Handled automatically by setup_and_run.sh
# Manual install:
cd uploaders
python3 -m venv venv
venv/bin/pip install -r requirement.txt
```

Key packages: `RPi.GPIO`, `requests`, `python-dotenv`

---

## Configuration (from `CONFIG/config.env`)

| Key | Default | Description |
|-----|---------|-------------|
| `API_BASE_URL` | `https://office.dynamicglobalsoft.com:1232` | Cloud API base URL |
| `machineId` | `1` | Machine identifier sent to the API |
| `SOCKET_IP` | `127.0.0.1` | IP of the `controller` server |
| `SOCKET_PORT` | `8080` | Port of the `controller` server |
| `WATER_GPIO_PIN_1`–`4` | `26,20,21,11` | BCM pin numbers for water level sensors |
| `TRANSACTION_DIR` | `../transaction` | Directory watched by `transaction_uploader.py` |

---

## Running

### Via PM2 (production)

```bash
sudo pm2 logs 02_Water_Sensors          # water sensor bridge
sudo pm2 logs 03_Transaction_Uploader   # transaction uploader
sudo pm2 logs 04_Status_Uploader        # status uploader
sudo pm2 restart 02_Water_Sensors       # restart individual process
```

### Manual run (for testing)

```bash
cd uploaders
venv/bin/python3 water_level_monitoring.py
venv/bin/python3 transaction_uploader.py
venv/bin/python3 status_uploader.py
```
