#!/bin/bash
# update.sh — bring this kiosk Pi up to date.
#
#   ./update.sh
#
# Pulls the code, rebuilds the controller only when its code changed (never
# deleting the running one first), restarts the five processes, then runs
# check_install.sh. Exit code: the check's, or 1 when the pull or build fails.

set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")" || exit 1

PM2_NAMES="01_Dispenser_Controller 02_Water_Sensors 03_Transaction_Uploader 04_Status_Uploader 05_Kiosk_Server"

# config.env, prices.conf, logs/ and transaction/ are ignored by git, so only
# edits to tracked files can block the pull.
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "These files were changed on this Pi, so the update would overwrite them:"
  git status --short --untracked-files=no
  echo "Undo any you did not mean with:  git checkout -- <file>   then run ./update.sh again."
  exit 1
fi

before="$(git rev-parse HEAD)"
if ! git pull --ff-only; then
  echo "git pull failed: nothing was changed. Check the internet and try again."
  exit 1
fi
after="$(git rev-parse HEAD)"
[ "$before" = "$after" ] && echo "Already up to date."

# make, not make clean + make: if the build fails, the controller that was
# running is still on disk and keeps running.
if { [ "$before" != "$after" ] && ! git diff --quiet "$before" "$after" -- controller/; } || [ ! -x controller/main ]; then
  echo "Building the controller..."
  if ! (cd controller && make); then
    echo "Controller build FAILED: the running controller was not touched."
    echo "Paste the error above to whoever maintains the kiosk."
    exit 1
  fi
fi

for n in $PM2_NAMES; do sudo pm2 restart "$n" >/dev/null && echo "Restarted $n"; done
sudo pm2 save >/dev/null

echo "Waiting for the kiosk to come up..."
sleep 8
./check_install.sh
