#!/usr/bin/env bash
# Nhost local stack default ports: 1337 (proxy/dashboard), 5432 (postgres),
# 8080 (hasura), 9695 (hasura console), 1025/8025 (mailhog)
echo "=== listening ports on WSL side ==="
ss -ltnp 2>/dev/null | awk 'NR==1 || /:(1337|5432|8080|9695|1025|8025|3000)\s/'

echo "=== existing docker containers ==="
docker ps -a --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}' | head -20

echo "=== git available in wsl (nhost uses branch for volume names) ==="
command -v git && git --version || echo "git missing in WSL"
