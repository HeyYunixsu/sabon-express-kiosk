#!/bin/bash
set -e

echo "=== Installing xbindkeys ==="
sudo apt update
sudo apt install xbindkeys -y

echo "=== Installing exit script ==="
cp exit_kiosk.sh ~/exit_kiosk.sh
chmod +x ~/exit_kiosk.sh

echo "=== Installing hotkey config ==="
cp .xbindkeysrc ~/.xbindkeysrc

echo "=== Installing autostart entry ==="
mkdir -p ~/.config/autostart
cp xbindkeys.desktop ~/.config/autostart/xbindkeys.desktop

echo "=== Adding sudoers rule ==="
echo "$USER ALL=(ALL) NOPASSWD: /bin/systemctl stop vendo_gui.service" | sudo tee /etc/sudoers.d/vendo_exit > /dev/null
sudo chmod 440 /etc/sudoers.d/vendo_exit

echo "=== Done! Rebooting in 5 seconds... ==="
sleep 5
sudo reboot
