#!/usr/bin/env bash
set -euo pipefail
umask 077
exec 9>/var/lib/pctime/service.lock
flock -n 9 || { echo 'Another PCTime service is already running.' >&2; exit 73; }
case "$(stat -f -c %T /var/lib/pctime)" in
  nfs*|cifs*|smb*) echo 'The active SQLite database requires local storage.' >&2; exit 1 ;;
esac
/usr/bin/python3 /personal/PCTime/server/ops/snapshots.py restore \
  --database /var/lib/pctime/pctime.sqlite --backups /personal/PCTime-service/backups
export PCTIME_HOST=127.0.0.1 PCTIME_PORT=4318 PCTIME_DB_PATH=/var/lib/pctime/pctime.sqlite
export PCTIME_ALLOWED_ORIGINS=''
exec /opt/pctime/node-v24.21.0-linux-x64/bin/node /personal/PCTime/server/index.mjs
