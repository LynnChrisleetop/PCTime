# PCTime account and synchronization service

Requires **Node.js 24**. No npm dependencies or Electron installation is needed:

```sh
node server/index.mjs
```

The default listener is `127.0.0.1:4318`, and the persistent database is `server/data/pctime.sqlite`. Native Windows and Android clients use the origin as their server URL. Registration immediately creates a session; there is no email verification, password reset, or email delivery in this first self-hosted release.

| Environment variable | Default | Meaning |
| --- | --- | --- |
| `PCTIME_HOST` | `127.0.0.1` | Bind address; use `0.0.0.0` explicitly for another device on your LAN |
| `PCTIME_PORT` | `4318` | Listening port |
| `PCTIME_DB_PATH` | `server/data/pctime.sqlite` | Persistent SQLite file, resolved relative to the working directory when supplied |
| `PCTIME_ALLOWED_ORIGINS` | Empty | Comma-separated exact browser origins, such as `http://127.0.0.1:5173`; no trailing slashes or wildcards |

For a phone on the same trusted LAN, bind to `0.0.0.0` and use the computer's private LAN IP in the phone. Allow only the intended private network through the firewall. Public hosting must terminate HTTPS at a reverse proxy; keep the upstream listener on loopback or an isolated container network. Do not expose the plain HTTP listener directly to the Internet. The service ignores `X-Forwarded-For`, so requests through a reverse proxy share the proxy IP's rate limit.

Browser CORS is disabled unless origins are explicitly configured. Native clients do not need a CORS setting. Sessions expire after 30 days; logout invalidates the current session. Passwords use salted asynchronous scrypt (`N=32768, r=8, p=2`, 64-byte keys). Only SHA-256 hashes of random 256-bit session tokens are stored. At most 20 sessions are retained per account.

The API accepts up to 4 MiB of JSON per daily upload, at most 2,000 apps per snapshot, and at most 25 hours of per-device daily durations. Authentication/device-registration bodies are capped at 16/8 KiB. It rejects unknown fields rather than retaining arbitrary metadata. Application IDs/names are capped at 256/200 characters; device client IDs/names at 128/120. Dates and IANA time zones are validated. Request/body timeouts and bounded rate counters limit malformed or repeated requests: 600 requests per minute per connection IP, 30 authentication attempts per 15 minutes per IP, and 10 per email. Authentication derivations have a four-request concurrency cap. Limit responses use status 429 and `Retry-After`; clients can retry later.

Each complete daily snapshot is replaced inside a SQLite transaction. Duplicate or older revisions are ignored. Summary durations sum device durations, including simultaneous use; they do not measure elapsed human attention. Known app IDs merge across platforms; unknown IDs remain platform-specific. A daily record keeps the uploading device's local date and supplied time zone without converting the date to server time. Non-owned and missing device IDs both return 404.

Device registration is idempotent for one account/client ID and updates its display name/time zone. The platform cannot change for an existing device ID. A summary includes account devices with zero duration when they have no data on the requested day; a `deviceId` filter includes only that device. `updatedAt` refers to the requested date's newest accepted snapshot. Application rows with zero duration are omitted. Duplicate registration, an unknown login email, and an incorrect password use the same generic credential error; the service does not promise to conceal successful registration as an event.

## Deployment and backup

For the inspected Bohrium development machine, see [deployment notes](../docs/bohrium-deployment.md). Its `/personal` directory is NFS, so the active WAL database runs on local storage and consistent snapshots are published to `/personal`. Instance-specific bootstrap and backup tools are in `server/ops/`.

Build from the **server directory**, so unrelated application files and local data are not included:

```sh
docker build -t pctime-cloud ./server
docker run --name pctime-cloud --restart unless-stopped -p 127.0.0.1:4318:4318 -v pctime-data:/data pctime-cloud
```

The container runs as the non-root `node` user. A named volume persists accounts, sessions, devices, and daily snapshots across container replacement. Set up an HTTPS reverse proxy in front of port 4318 for public use. `GET /healthz` returns `{"ok":true}` without account information. The image has not been remotely deployed by this repository.

For a consistent backup, stop the service, copy the **entire data directory** (including any SQLite WAL/SHM files), then start it again. Restore while the service is stopped. Protect backup permissions: files contain account emails, password hashes, and usage totals. Do not commit them. The database is not encrypted at rest; use operating-system disk encryption and appropriate filesystem permissions when needed.

For automated verification, run `node --test tests/cloud-server.test.mjs` from the repository root. Tests start real HTTP listeners on ephemeral loopback ports and isolated temporary SQLite databases; they do not contact a hosted service.
