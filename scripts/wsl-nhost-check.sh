#!/usr/bin/env bash
export NVM_DIR="$HOME/.nvm"
# shellcheck disable=SC1091
. "$NVM_DIR/nvm.sh"
nvm use default >/dev/null

echo "=== which nhost ==="
command -v nhost

echo "=== nhost --version ==="
nhost --version 2>&1 | head -5

echo "=== nhost --help ==="
nhost --help 2>&1 | head -60
