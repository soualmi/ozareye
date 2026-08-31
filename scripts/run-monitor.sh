#!/bin/bash
# Cron entry point for POST /api/monitor. Reads MONITOR_SECRET from .env.local
# at call time — never hardcoded here, never echoed.
set -euo pipefail
cd /root/algerie-feux
SECRET=$(grep '^MONITOR_SECRET=' .env.local | cut -d= -f2-)
curl -s -X POST http://127.0.0.1:8423/api/monitor -H "x-monitor-secret: $SECRET" >> /root/algerie-feux/cron.log 2>&1
echo "" >> /root/algerie-feux/cron.log
