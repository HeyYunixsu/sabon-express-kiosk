#!/bin/bash
# Opens the kiosk full screen on the Pi's own touchscreen.
#
# Started at desktop login by ~/.config/autostart/sabon-kiosk.desktop, which
# setup_and_run.sh installs. PM2 starts the kiosk server at boot, possibly
# after the desktop is up, so this waits for the server before opening the
# page rather than showing the customer a "can't reach this page" error.
#
# To get out of the kiosk on the Pi: kiosk_exit_tool/, or Alt+F4.

DIR="$(cd "$(dirname "$0")" && pwd)"
PORT="$(sed -n 's/^[[:space:]]*KIOSK_PORT[[:space:]]*=[[:space:]]*//p' \
        "$DIR/../CONFIG/config.env" 2>/dev/null | tail -1 | tr -d '\r"')"
URL="http://localhost:${PORT:-3000}/"

for _ in $(seq 1 90); do
  curl -s -o /dev/null "$URL" && break
  sleep 1
done

BROWSER="$(command -v chromium || command -v chromium-browser)"
if [ -z "$BROWSER" ]; then
  echo "launch_browser.sh: chromium not found" >&2
  exit 1
fi

# --kiosk: full screen, no address bar, no way to leave by touch.
# The rest stop the pop-ups a customer should never see: first-run pages,
# "restore pages?" after a power cut, translate offers, swipe-to-go-back and
# pinch zoom.
exec "$BROWSER" \
  --kiosk "$URL" \
  --noerrdialogs \
  --disable-infobars \
  --no-first-run \
  --disable-session-crashed-bubble \
  --disable-features=Translate \
  --overscroll-history-navigation=0 \
  --disable-pinch \
  --check-for-update-interval=31536000 \
  --password-store=basic
