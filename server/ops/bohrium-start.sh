#!/usr/bin/env bash
# This instance-specific bootstrap never changes the platform's SSH process.
set -euo pipefail
umask 077
test "$(id -u)" = 0 || { echo 'Run this bootstrap as root.' >&2; exit 1; }
test -f /personal/PCTime/server/index.mjs
service=/personal/PCTime-service
archive=$service/downloads/node-v24.21.0-linux-x64.tar.xz
checksum=fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6
id pctime >/dev/null 2>&1 || useradd --system --no-create-home --home-dir /var/lib/pctime --shell /usr/sbin/nologin pctime
install -d -m 710 -o root -g pctime "$service"
install -d -m 700 "$service/downloads"
install -d -m 700 -o pctime -g pctime /var/lib/pctime "$service/backups" "$service/logs"
# A recreated container can assign a different UID to the same dedicated account.
chown -R -h pctime:pctime /var/lib/pctime "$service/backups" "$service/logs"
if test ! -x /opt/pctime/node-v24.21.0-linux-x64/bin/node; then
  if test ! -f "$archive"; then
    curl -fsSL --connect-timeout 15 --max-time 180 \
      https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-x64.tar.xz -o "$archive.download"
    echo "$checksum  $archive.download" | sha256sum -c -
    mv "$archive.download" "$archive"
  fi
  echo "$checksum  $archive" | sha256sum -c -
  install -d /opt/pctime
  tar -xJf "$archive" -C /opt/pctime
fi
# Archives extracted under a restrictive root umask must still be executable by the service user.
chmod 755 /opt/pctime /opt/pctime/node-v24.21.0-linux-x64 /opt/pctime/node-v24.21.0-linux-x64/bin
chmod 755 /opt/pctime/node-v24.21.0-linux-x64/bin/node
cat > "$service/supervisord.conf" <<'CONF'
[unix_http_server]
file=/var/run/pctime-supervisor.sock
chmod=0700
[supervisord]
user=root
nodaemon=true
logfile=/personal/PCTime-service/logs/supervisord.log
logfile_maxbytes=2MB
logfile_backups=3
pidfile=/var/run/pctime-supervisor.pid
childlogdir=/personal/PCTime-service/logs
[rpcinterface:supervisor]
supervisor.rpcinterface_factory=supervisor.rpcinterface:make_main_rpcinterface
[supervisorctl]
serverurl=unix:///var/run/pctime-supervisor.sock
[program:pctime]
command=/bin/bash /personal/PCTime/server/ops/bohrium-node.sh
directory=/personal/PCTime
user=pctime
autostart=true
autorestart=true
startsecs=3
startretries=5
stopasgroup=true
killasgroup=true
stopwaitsecs=30
priority=20
environment=PYTHONDONTWRITEBYTECODE="1"
stdout_logfile=/personal/PCTime-service/logs/server.log
stderr_logfile=/personal/PCTime-service/logs/server-error.log
stdout_logfile_maxbytes=2MB
stderr_logfile_maxbytes=2MB
stdout_logfile_backups=3
stderr_logfile_backups=3
[program:pctime-backup]
command=/usr/bin/python3 /personal/PCTime/server/ops/snapshots.py watch --database /var/lib/pctime/pctime.sqlite --backups /personal/PCTime-service/backups
user=pctime
autostart=true
autorestart=true
startsecs=3
stopasgroup=true
killasgroup=true
stopwaitsecs=40
priority=10
environment=PYTHONDONTWRITEBYTECODE="1"
stdout_logfile=/personal/PCTime-service/logs/backup.log
stderr_logfile=/personal/PCTime-service/logs/backup-error.log
stdout_logfile_maxbytes=2MB
stderr_logfile_maxbytes=2MB
stdout_logfile_backups=3
stderr_logfile_backups=3
CONF
if supervisorctl -c "$service/supervisord.conf" pid >/dev/null 2>&1; then
  echo 'PCTime supervisor is already running.'
  exit 0
fi
exec /usr/bin/supervisord -c "$service/supervisord.conf"
