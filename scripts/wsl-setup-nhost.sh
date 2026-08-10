#!/usr/bin/env bash
set -euo pipefail

export NVM_DIR="$HOME/.nvm"
# shellcheck disable=SC1091
. "$NVM_DIR/nvm.sh"
nvm use default >/dev/null

echo "=== node in use ==="
command -v node
node --version

echo "=== installing @nhost/cli ==="
npm install -g @nhost/cli

echo "=== nhost location ==="
command -v nhost

echo "=== nhost version ==="
nhost version
