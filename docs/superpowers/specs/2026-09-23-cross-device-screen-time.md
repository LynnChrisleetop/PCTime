# Cross-device screen time — first runnable release

## Product decisions

- Windows and Android, with the existing PCTime name/icon until a later naming session.
- Retain the approved light-blue / yellow / coral palette and purposeful, reduced-motion-aware animation.
- Email/password account; a self-hosted service is the default until hosting is supplied.
- **Sum device durations**. Ten simultaneous minutes on each of two devices means twenty minutes. This is not elapsed human attention time.
- All-device, device-specific, and canonical application totals, including WeChat and Bilibili across platforms.
- Each uploaded date is the device's local calendar date; preserve its IANA time zone. Devices in different time zones can contribute different local days.
- Upload daily application durations only, never Windows window titles, passwords, or browsing history.
- Windows keeps a separate device-only journal from this version onward. Old WebDAV-imported history remains in local views and is not mislabeled as this device's history.
- Offline collection remains available. Logout stops uploading; local statistics stay on the device.
- Android uses Usage Access with an explicit permission flow. Background uploads are best effort; opening the app/manual sync refreshes the day. No accessibility service.

## REST contract, version 1

Base URL is the origin, with no path/query/credentials. HTTPS is required except HTTP loopback or private LAN addresses for local development. JSON; `Authorization: Bearer <opaque token>` on protected endpoints. Failures: `{error: string}` with appropriate 4xx/5xx status. Requests have a bounded body and timeouts.

`POST /v1/auth/register`, `POST /v1/auth/login`: `{email,password}` => `{token,expiresAt,user:{id,email}}`. Password length 10–128, no client trimming. Registration creates a session. `GET /v1/auth/me` => `{user:{id,email}}`; `POST /v1/auth/logout` => `{ok:true}`. Tokens expire after 30 days; store only token hashes server-side.

`POST /v1/devices`: `{clientId,name,platform:"windows"|"android",timeZone}` => `{device: Device}`. Idempotent by account/clientId. `GET /v1/devices` => `{devices:Device[]}`.

`PUT /v1/devices/:deviceId/days/:date`: `{revision,timeZone,apps:[{sourceId,sourceName,totalMs}]}` => `{accepted:boolean,revision:number}`. Date is YYYY-MM-DD. Integer monotonic positive revision, persisted before sending. Complete daily snapshot replaces old data transactionally. Equal/older revision is ignored. Device ownership required. Durations are nonnegative integer milliseconds, each day's sum <= 90,000,000 (25 hours), at most 2,000 unique source IDs. Empty apps clears that day.

`GET /v1/summary?date=YYYY-MM-DD&deviceId=<optional>` => `Summary`. The server maps known source IDs to canonical apps; unknown apps stay platform-specific. Known Windows IDs: `wechat`, `weixin`, `wechat.exe`, `weixin.exe`, `微信`; `bilibili`, `bilibili.exe`, `哔哩哔哩`, `site:bilibili`; `qq`, `qq.exe`. Known Android IDs: `com.tencent.mm`, `tv.danmaku.bili`, `com.tencent.mobileqq`. Source IDs are lowercased for matching. Clients must never send titles as source names.

```ts
type Device = { id:string; clientId:string; name:string; platform:'windows'|'android'; timeZone:string; lastSyncedAt:string|null }
type DeviceTotal = Device & { totalMs:number }
type AppTotal = { canonicalId:string; name:string; totalMs:number; devices:Array<{deviceId:string; name:string; platform:'windows'|'android'; totalMs:number}> }
type Summary = { date:string; metric:'sumDevices'; totalMs:number; devices:DeviceTotal[]; apps:AppTotal[]; updatedAt:string|null }
```

## Windows renderer bridge

```ts
window.cloud.getState(): Promise<CloudState>
window.cloud.authenticate({serverUrl,email,password,mode:'login'|'register',deviceName}): Promise<CloudState>
window.cloud.logout(): Promise<CloudState>
window.cloud.syncNow(): Promise<CloudState>
window.cloud.getSummary(date:string,deviceId?:string): Promise<Summary>
type CloudState = { serverUrl:string; user:{id:string;email:string}|null; device:Device|null; syncing:boolean; lastSyncedAt:string|null; error:string|null }
```

The bridge exposes no token. Main-process storage uses Electron safeStorage. Serial requests prevent overlapping sync and account-switch races. Failed daily uploads retry without adding duplicate time. A browser preview may view the service using an in-memory session, but cannot register itself as a collecting PC.

## Acceptance

Account isolation, hashed credentials, device ownership, invalid requests, idempotent/reordered snapshots, same-app merging, sum-of-devices arithmetic, restart persistence, collector midnight/lock behavior, and offline retry must have automated coverage. Build Windows ZIP and Android debug APK. Real-phone permission/background reliability must be labeled unverified without an attached phone. Document server setup, HTTPS deployment, backup, installation, and first sync.
