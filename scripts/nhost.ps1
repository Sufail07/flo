# Runs the Nhost CLI inside WSL2 Ubuntu from Windows.
# The Nhost CLI has no Windows build, so it must execute in WSL.
# Usage:  .\scripts\nhost.ps1 init
#         .\scripts\nhost.ps1 up

$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot

# Translate D:\AI-Workflow -> /mnt/d/AI-Workflow
$drive   = $projectRoot.Substring(0, 1).ToLower()
$rest    = $projectRoot.Substring(2).Replace('\', '/')
$wslPath = "/mnt/$drive$rest"

wsl -d Ubuntu -- bash "$wslPath/scripts/nhost-wsl.sh" $wslPath @args
exit $LASTEXITCODE
