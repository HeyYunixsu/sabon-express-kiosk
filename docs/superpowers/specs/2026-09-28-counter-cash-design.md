# Counter Cash — Design (draft)

**Date:** 2026-09-28
**Status:** Direction agreed, detailed design not yet written. Other options
still being weighed (see the end).

## Problem

Cash today means a staff member walks to the kiosk and types their PIN on its
screen for every sale. With a line, staff spend the day walking back and forth.

## Setting

Staff stand at a counter in the same shop, with a phone or tablet on the shop
Wi-Fi.

## Decisions so far

| Question | Decision |
|---|---|
| How the order reaches the counter | The kiosk shows a big **order number** (e.g. `A-27`) and a **QR code** on screen. The customer remembers the number or photographs the QR. |
| What the kiosk does meanwhile | **Holds** that order on a "Waiting for payment · A-27" screen, and **gives up after a timeout** if nobody pays, back to the start screen. One order at a time; no queue. |
| How staff identify themselves | **Sign in once per shift** on the tablet with their personal staff PIN (the existing `STAFFn_*` PINs). Every payment is logged with their name. |
| Where the staff page lives | **Approach A:** served by the kiosk server itself over the shop Wi-Fi at `/staff`. Works with no internet and no backend. |
| Fallback | The existing staff PIN pad on the kiosk stays, as a small "Staff at the machine?" option for when the tablet is not available. |

## Key technical point

Tablet browsers only allow the camera on HTTPS pages, and the kiosk serves
plain HTTP on the LAN. So the page does not scan anything itself: the QR holds
a **link** to the order (`http://<kiosk-ip>:<port>/staff/order/A-27`). The
tablet's own camera app reads it and opens the link; staff tap **Mark as
paid**.

## Security shape

Opening the server to the Wi-Fi must not open the customer actions to it:
`/api/cash`, `/api/dispense`, `/api/pause`, `/api/resume` stay answerable only
from the Pi itself. Only the signed-in staff page is reachable from the LAN.

## Approaches weighed

- **A. Staff page on the kiosk over the shop Wi-Fi** — chosen.
- **B. Through the cloud backend** — staff could confirm from anywhere, but it
  waits on the backend team and stops cash sales when the internet drops.
  Revisit alongside QR payment.
- **C. PIN at the kiosk plus an order number** — does not remove the walk.

## Still to design

Kiosk screens (order number + QR, waiting, timeout), the staff page (sign-in,
waiting orders, order view, mark paid), the timeout length, order numbering,
what is logged, and tests.
