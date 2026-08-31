#!/bin/bash
# Algérie Feux Alerte
# Copyright (C) 2026 H. Soualmi
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU Affero General Public License as published
# by the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
# GNU Affero General Public License for more details.
#
# You should have received a copy of the GNU Affero General Public License
# along with this program. If not, see <https://www.gnu.org/licenses/>.

# Cron entry point for POST /api/monitor. Reads MONITOR_SECRET from .env.local
# at call time — never hardcoded here, never echoed.
set -euo pipefail
cd /root/algerie-feux
SECRET=$(grep '^MONITOR_SECRET=' .env.local | cut -d= -f2-)
curl -s -X POST http://127.0.0.1:8423/api/monitor -H "x-monitor-secret: $SECRET" >> /root/algerie-feux/cron.log 2>&1
echo "" >> /root/algerie-feux/cron.log
