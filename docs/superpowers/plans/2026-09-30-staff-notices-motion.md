# Staff Dashboard: V2-style Notifications and Smooth Transitions

**Date:** 2026-09-30 · **Status:** approved by the owner ("yes go").
**Branch:** `piece-8/notices-motion` from `main`.
**Files:** `kiosk_server/public/staff/index.html`, `staff.css`, `staff.js` only. No server change.
**Reference:** the cashier V2 notice — `../sabon_express_dispenser-main/cashier_dashboard/public/v2.html` (`#notice`, ~line 384), `css/v2.css` (`#notice`, ~line 1275), `js/v2.js` (`notice()` / `hideNotice()`, ~line 390).

## Notifications (top-right, like V2)

One notification stack fixed to the viewport's top-right (`top: 24px; right: 24px`, width `min(420px, 100vw - 48px)`). It sits above the page but below the confirm dialog, so an open dialog stays on top. Each notification is a card in the dashboard's palette:

- a 30 px round icon: ✓ on green (`ok`), ✕ on red (`bad`), ⚠ on amber (`warn`), ● on blue (`info`);
- a 4 px coloured strip down the left edge in the same colour;
- a bold title (one line, ellipsis) and an optional grey detail line;
- an × dismiss button (≥ 44 px tap target);
- optional: the whole card runs an action when clicked (used for the new-order notice).

Behaviour:

- Slides in from 10 px above with a fade (≈ 220 ms); leaves with the reverse, then is removed.
- Auto-dismiss: `ok`/`info` after 5 s, `bad`/`warn` after 8 s; `sticky` ones stay until cleared by code or the ×.
- Newest on top; at most 3 visible — a 4th pushes the oldest out.
- `role="status"` / `aria-live="polite"` on the stack.

What goes there (and no longer anywhere else):

| Today | Becomes |
|---|---|
| Tools toast `#x-msg` (price saved, air clear, give back, write off, refusals) — bottom centre | a notification (`ok` or `bad`), same texts |
| Mark as paid result in `#w-msg` ("A-7 paid. The kiosk is unlocked." / PAID_MSG refusals) | `ok`: title "A-7 paid", detail "The kiosk is unlocked." · refusals `bad` with the PAID_MSG text |
| Cancel result in `#w-msg` | `ok` "A-7 cancelled" · refusals `bad` |
| Wi-Fi warning in `#w-msg` ("Cannot reach the kiosk. Check the Wi-Fi.") | one **sticky** `bad` notification, shown once while the poll fails, removed automatically on the next good poll |
| (new) a customer's order arrives — today only the chime | `info` "New order A-7 · ₱15" detail "Waiting for payment" (for a QR order: "Waiting for QR payment"); clicking it shows Overview. Same moment as the chime, never on first load |

Stays where it is: the scanned-order focus note in the hero (`#w-msg`, persistent, "do not take payment") and the sign-in errors in `#l-msg`.

Keep a single helper, e.g. `notify({ kind, title, sub, sticky, onClick }) → handle` with `handle.close()`, and make the existing `toast(ok, text)` call it so every tools call site keeps working. Remove the old bottom toast styles. Keep the `#x-msg` id on the stack container if it fits (older browser checks look for it); otherwise say so in the report.

## Smooth transitions

All motion 150–250 ms, `ease` or `cubic-bezier(.2,.8,.2,1)`; never delays input; everything off under `@media (prefers-reduced-motion: reduce)`.

- **Sections:** the section being shown fades in and rises 8 px (≈ 200 ms) each time the sidebar switches.
- **Hero:** switching idle ↔ waiting cross-fades (≈ 200 ms) — the incoming side fades in; no layout jump.
- **Confirm dialog `#dlg`:** backdrop fades in; the card scales from .96 and fades in; closing reverses before hiding (keep the existing Yes/Back logic and its `hidden` semantics).
- **Interactive elements:** buttons, nav items, quick-action rows, air-clear tiles, table rows, the Today/7 Days switch — `transition` on background, border-color, color, box-shadow, transform; a small `:active` press (scale .98) on buttons and tiles.
- **Active nav marker:** the blue bar and text colour ease in instead of jumping.
- **Stat values:** a brief fade when a number changes (optional; skip if it needs more than a few lines).
- Nothing animates on the 1-second poll re-render itself: `put()` must not re-trigger entrance animations for lists that did not change, and nothing may flicker every second.

## Acceptance

- `cd kiosk_server && node --check public/staff/staff.js && npm test` — all pass (113).
- `node kiosk_server/tools/layout_audit.js <dir>` and `AUDIT_ORDER=1 …` — every rule passes (the stack is `position: fixed`, so it must not affect rules N or L).
- Screenshots: a stack of three notifications (ok, bad, info) at 1440 and 1180; the new-order notice; the Wi-Fi sticky notice (drive it with CDP `Network.emulateNetworkConditions { offline: true }`, then back online and see it clear).
- Behaviour unchanged otherwise: sign-in, Mark as paid / Cancel with the confirm dialog, the focus note, every tool.
