#!/usr/bin/env bash
PKG="$HOME/.nvm/versions/node/v22.23.2/lib/node_modules/@nhost/cli"
echo "=== package.json ==="
cat "$PKG/package.json"
echo "=== bin dir ==="
ls -la "$PKG/bin"
echo "=== optional dep dirs ==="
ls -la "$PKG/node_modules" 2>/dev/null
echo "=== strings: cli image ref in binary ==="
BIN=$(find "$PKG/node_modules" -type f -name 'nhost*' -perm -u+x 2>/dev/null | head -1)
echo "binary: $BIN"
if [ -n "$BIN" ]; then
  strings "$BIN" 2>/dev/null | grep -E 'nhost/cli:|NHOST_CLI_VERSION|cli:%s' | head -20
fi
