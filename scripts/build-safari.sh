#!/bin/zsh
# Rebuilds the Safari extension and reinstalls ~/Applications/Load.app.
set -e
cd "$(dirname "$0")/.."
node extension/build.mjs
cd extension/xcode/Load
xcodebuild -scheme Load -configuration Release -derivedDataPath ../dd \
  CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM=B4T5J95WG7 CODE_SIGN_IDENTITY="Apple Development" build | grep -E '^error|BUILD'
mkdir -p ~/Applications
ditto ../dd/Build/Products/Release/Load.app ~/Applications/Load.app
open ~/Applications/Load.app
echo "Installed. Safari › Settings › Extensions › Load."
