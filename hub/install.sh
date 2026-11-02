#!/bin/zsh
# Installs the Load hub as a LaunchAgent: starts at login, restarts if it stops.
# Run once:  ./hub/install.sh        Remove:  ./hub/install.sh --remove
set -e
HERE=$(cd "$(dirname "$0")/.." && pwd)
LABEL=com.mxavier.load.hub
PLIST=~/Library/LaunchAgents/$LABEL.plist

launchctl bootout gui/$(id -u)/$LABEL 2>/dev/null || true
pkill -f "$HERE/hub/server.mjs" 2>/dev/null || true
if [[ "$1" == "--remove" ]]; then rm -f "$PLIST"; echo "Removed."; exit 0; fi

mkdir -p ~/Library/Logs/Load ~/Library/LaunchAgents
NODE=$(command -v node || echo /opt/homebrew/bin/node)
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$HERE/hub/server.mjs</string></array>
  <key>WorkingDirectory</key><string>$HERE</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/Load/hub.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/Load/hub.log</string>
</dict></plist>
PL
launchctl bootstrap gui/$(id -u) "$PLIST"
sleep 2
curl -s -H 'X-Load: 1' http://127.0.0.1:8766/api/ping >/dev/null && echo "Load is running: http://127.0.0.1:8766" || echo "Installed; check ~/Library/Logs/Load/hub.log"
