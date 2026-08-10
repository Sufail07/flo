#!/usr/bin/env bash
export NVM_DIR="$HOME/.nvm"
# shellcheck disable=SC1091
. "$NVM_DIR/nvm.sh"
nvm use default >/dev/null

echo "=== dist-tags ==="
npm view @nhost/cli dist-tags --json

echo "=== last 15 versions ==="
npm view @nhost/cli versions --json | tail -20
