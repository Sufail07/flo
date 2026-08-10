#!/usr/bin/env bash
# Exports live Hasura metadata into nhost/metadata/ as the versioned YAML tree
# the Nhost CLI reloads on startup. Run this after any console/script change,
# otherwise `nhost up` restores the on-disk (stale) metadata and silently drops
# tracked tables and permissions.
set -euo pipefail

cd "$(dirname "$0")/.."
ADMIN=$(grep '^HASURA_GRAPHQL_ADMIN_SECRET' .secrets | cut -d= -f2 | tr -d " '")

docker exec ai-workflow-console-1 bash -c \
  "cd /app && hasura-cli metadata export --endpoint http://graphql:8080 --admin-secret '$ADMIN'"

echo "--- tracked application tables now on disk ---"
ls nhost/metadata/databases/default/tables/ | grep -vE '^(auth_|storage_)' || true
