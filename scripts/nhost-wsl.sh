#!/usr/bin/env bash
# Loads nvm-managed node, then runs the Nhost CLI in the project directory.
# Arg 1 = project path (WSL form). Remaining args are passed to nhost.
set -euo pipefail

PROJECT_DIR="$1"
shift

export NVM_DIR="$HOME/.nvm"
# shellcheck disable=SC1091
. "$NVM_DIR/nvm.sh"
nvm use default >/dev/null

cd "$PROJECT_DIR"
exec nhost "$@"
