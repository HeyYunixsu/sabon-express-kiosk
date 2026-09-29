# Reuse Map

What this repo took from the cashier product, what it deliberately left, and
what has to be written. Read this before adding anything that already exists
in the other product.

**Source:** `sabon_express_dispenser` (the cashier product) at commit
`41ae642`, copied 2026-09-25. Only files tracked by git were copied, so no
machine settings, saved prices or build artefacts came across.

## Copied

| Path | Change on the way in |
|---|---|
| `controller/` | None, then piece 1 added `DISPENSE`, `PAUSE`, `RESUME`. A kiosk is just a different client on the controller's socket. |
| `uploaders/` | None. A kiosk sale is a sale: same API, same six fields. |
| `CONFIG/config.env.sample`, `CONFIG/README.md` | Cashier install paths removed (every path defaults inside the checkout), `DASHBOARD_PORT` replaced by `KIOSK_PORT`, `SETTLEMENT_LOG` dropped. |
| `install_dependencies.sh` | None. |
| `setup_and_run.sh` | `05_Cashier_Dashboard` removed. `05_Kiosk_Server` is added in piece 2. |
| `kiosk_exit_tool/` | None. |
| `docs/INSTALLATION.md`, `docs/QUICK_INSTALL.md` | None yet, beyond a note at the top. Boot config, wiring and calibration apply as written; the dashboard and tablet steps are rewritten in piece 5. |
| `.gitignore` | Cashier dashboard and design-source entries removed. |

## Taken in piece 2

From `cashier_dashboard/public/`, into `kiosk_server/public/`:

| Path | Change |
|---|---|
| `img/products/1-6.webp`, `img/sabon-express-logo.png` | None. |
| `fonts/helvetica-neue-400/700`, `fonts/inter-v20-latin-regular/700` | Only the four faces the kiosk uses; Poppins and the Inter 500/600 cuts were left. |
| `css/v2.css` | Not copied. Its light-theme colour tokens were carried into `css/kiosk.css`; the rest is tablet layout and cashier components. |

`cashier_dashboard/server.js` was read, not copied: the controller socket and
the state stream were rewritten in `kiosk_server/lib/controller.js` with the
Node standard library, so the kiosk needs no Express and no `npm install`.

The staff panels (prices, prime list, today's sales, air clears, waiting
credits) live in `js/v2.js` alongside the cashier flow. Read them there and
rebuild what piece 3 needs; the file is not copied whole.

## Deliberately not copied

| Left behind | Reason |
|---|---|
| `cashier_dashboard/server.js`, `public/v2.html`, `public/js/v2.js` | The sale flow is the cashier. A kiosk is driven by the customer, so this is rewritten, not adapted. Read them for worked examples. |
| `public/index.html`, `public/js/app.js` | The dead v1 dashboard, about 1,600 lines, reachable only at `/v1`. |
| `public/js/tour.js` | The cashier's first-run tutorial. |
| `cashier_dashboard/lib/`, `tests/` | They belong to the dashboard being replaced. `lib/prime_log.js` (air-clear log reader) is worth copying when piece 3 needs it. |
| `docs/KIOSK.md` | Locks an iPad or Android tablet to the dashboard. The kiosk's screen is the Pi's own; piece 2 launches Chromium in kiosk mode instead. |
| `docs/SYSTEM_REFERENCE.md` | Mostly the cashier dashboard. A kiosk version is written once the kiosk server exists. |
| `docs/BUTTON_WIRING_DEBUG.md`, `docs/DASHBOARD_DESIGN.md`, `docs/archive/`, `docs/superpowers/` (except the kiosk spec) | About the cashier screen, or history. |
| `Sabon UI resources/`, `drive-download-*`, `sabon-express-ui-v2-handoff.md`, `main_exe.log` | Development leftovers. |
| `CONFIG/config.env`, `CONFIG/prices.conf` | Per-machine and untracked. Every machine gets its own. |
| The other repo's git history | A fresh start. The provenance is this file. |

## Has to be written

| Piece | What | Depends on |
|---|---|---|
| 1 | `DISPENSE`, `PAUSE`, `RESUME` in the controller | **Done** |
| 2 | Kiosk server, customer screens (attract, pick, pay cash, pour, thank you), Chromium kiosk launch | **Done** |
| 3 | Staff PIN menu: cash confirmation, prices, priming, sales, air clears, credits | Piece 2 |
| 4 | QR payment: backend creates it, kiosk polls it | Backend endpoints existing |
| 5 | Install runbook for a kiosk Pi | Pieces 2 and 3 |

## Carrying a fix across

The two products share no code, by choice: a change here can never break a
deployed cashier machine. The cost is that a controller or uploader fix has to
be applied twice. When that happens, copy the change rather than the file, and
say in the commit message which repo it came from and which commit.
