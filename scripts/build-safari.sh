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
# Safari registers every copy of the app it finds; leave only the installed one, or two
# copies of the extension run side by side.
LSREG=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
BUILT="$PWD/../dd/Build/Products/Release/Load.app"
pluginkit -r "$BUILT/Contents/PlugIns/Load Extension.appex" 2>/dev/null || true
"$LSREG" -u "$BUILT" 2>/dev/null || true
rm -rf "${BUILT:?}"
pluginkit -a ~/Applications/Load.app/Contents/PlugIns/Load\ Extension.appex
open ~/Applications/Load.app
echo "Installed. Safari › Settings › Extensions › Load."
