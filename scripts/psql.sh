#!/usr/bin/env bash
# Runs a SQL statement against the local Nhost postgres.
set -euo pipefail
docker exec -i ai-workflow-postgres-1 \
  psql -U postgres -d local -v ON_ERROR_STOP=1 -c "$1"
