#!/bin/zsh
set -euo pipefail
LOG_FILE="/Users/ghazialayyan/quantbot/data/public_tunnel.log"
: > "$LOG_FILE"
exec ssh -o StrictHostKeyChecking=no -o ServerAliveInterval=30 -R 80:localhost:8787 nokey@localhost.run >> "$LOG_FILE" 2>&1
