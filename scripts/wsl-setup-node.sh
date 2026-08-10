#!/usr/bin/env bash
set -euo pipefail

export NVM_DIR="$HOME/.nvm"

if [ ! -s "$NVM_DIR/nvm.sh" ]; then
  echo "nvm.sh missing at $NVM_DIR/nvm.sh -- reinstalling nvm"
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
fi

# shellcheck disable=SC1091
. "$NVM_DIR/nvm.sh"

echo "=== nvm version ==="
nvm --version

echo "=== installing Node 22 LTS ==="
nvm install 22
nvm alias default 22
nvm use default

echo "=== resulting versions ==="
echo "node: $(node --version)  -> $(command -v node)"
echo "npm:  $(npm --version)   -> $(command -v npm)"
