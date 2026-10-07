"""Register for the next container start without reloading its SSH supervisor."""
import configparser
import os
from pathlib import Path
import shutil
import tempfile

configuration = Path("/etc/supervisord.conf")
original = configuration.read_text()
parser = configparser.ConfigParser(interpolation=None)
parser.read_string(original)
section = "program:pctime-bootstrap"
command = "/bin/bash /personal/PCTime/server/ops/bohrium-start.sh"
if parser.has_section(section):
    if parser.get(section, "command") != command:
        raise SystemExit("Existing PCTime boot configuration differs; no changes made.")
    print("Boot configuration already registered.")
else:
    backup = Path("/personal/PCTime-service/platform-supervisord.before-pctime.conf")
    if not backup.exists():
        shutil.copy2(configuration, backup)
        backup.chmod(0o600)
    addition = "\n\n[" + section + "]\ncommand=" + command + "\nautostart=true\nautorestart=unexpected\nstartsecs=5\nstopasgroup=true\nkillasgroup=true\nstopwaitsecs=80\nstdout_logfile=/tmp/pctime-bootstrap.log\nstderr_logfile=/tmp/pctime-bootstrap-error.log\nstdout_logfile_maxbytes=2MB\nstderr_logfile_maxbytes=2MB\n"
    fd, temporary = tempfile.mkstemp(prefix=".pctime-supervisor-", dir=configuration.parent)
    try:
        with os.fdopen(fd, "w") as output:
            output.write(original + addition)
            output.flush()
            os.fsync(output.fileno())
        os.chmod(temporary, configuration.stat().st_mode & 0o777)
        os.replace(temporary, configuration)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    print("Boot entry added. Existing SSH supervisor was NOT restarted; boot behavior still needs validation.")
