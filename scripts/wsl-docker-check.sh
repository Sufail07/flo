#!/usr/bin/env bash
echo "=== docker client ==="
docker --version

echo "=== docker daemon reachable? ==="
if docker info --format 'server={{.ServerVersion}} os={{.OperatingSystem}}' 2>&1; then
  echo "daemon OK"
else
  echo "DAEMON UNREACHABLE"
  exit 1
fi

echo "=== docker compose ==="
docker compose version 2>&1 | head -2

echo "=== run hello container ==="
docker run --rm alpine:3 echo "container-ran-ok" 2>&1 | tail -3
