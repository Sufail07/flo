#!/usr/bin/env bash
echo "=== user ==="
whoami
echo "HOME=$HOME"
echo "PWD=$PWD"
echo "SHELL=$SHELL"
echo "=== home contents ==="
ls -A "$HOME" 2>&1 | head -30
echo "=== login shell ==="
getent passwd "$(whoami)" | cut -d: -f7
echo "=== PATH ==="
echo "$PATH" | tr ':' '\n'
