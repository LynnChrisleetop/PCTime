import { DatabaseSync } from 'node:sqlite'
import { chmodSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { ApiError, canonicalApp } from './validation.mjs'

export function openStore(dbPath) {
  if (dbPath !== ':memory:') mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(dbPath, { timeout: 5000 })
  if (dbPath !== ':memory:') chmodSync(dbPath, 0o600)
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL, created_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id, created_at);
    CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      client_id TEXT NOT NULL, name TEXT NOT NULL, platform TEXT NOT NULL CHECK(platform IN ('windows', 'android')),
      time_zone TEXT NOT NULL, last_synced_at TEXT, UNIQUE(user_id, client_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS days (
      device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE, date TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK(revision > 0), time_zone TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(device_id, date)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS daily_apps (
      device_id TEXT NOT NULL, date TEXT NOT NULL, source_id TEXT NOT NULL, source_name TEXT NOT NULL,
      total_ms INTEGER NOT NULL CHECK(total_ms >= 0), PRIMARY KEY(device_id, date, source_id),
      FOREIGN KEY(device_id, date) REFERENCES days(device_id, date) ON DELETE CASCADE
    ) STRICT;
    PRAGMA user_version = 1;
  `)
  const statement = (sql) => db.prepare(sql)
  const transaction = (operation) => {
    db.exec('BEGIN IMMEDIATE')
    try {
      const result = operation()
      db.exec('COMMIT')
      return result
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  const deviceView = (row) => ({ id: row.id, clientId: row.client_id, name: row.name, platform: row.platform, timeZone: row.time_zone, lastSyncedAt: row.last_synced_at })
  const ownedDevice = (userId, deviceId) => {
    const row = statement('SELECT * FROM devices WHERE id = ? AND user_id = ?').get(deviceId, userId)
    if (!row) throw new ApiError(404, '设备不存在')
    return row
  }

  return {
    close() { db.close() },
    findUser(email) { return statement('SELECT * FROM users WHERE email = ?').get(email) },
    createUser(email, passwordHash, now) {
      const id = randomUUID()
      const result = statement('INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(email) DO NOTHING').run(id, email, passwordHash, now)
      return result.changes === 1 ? { id, email } : null
    },
    createSession(userId, session, now) {
      transaction(() => {
        statement('DELETE FROM sessions WHERE expires_at <= ?').run(now)
        // Bound active sessions without exposing or retaining raw tokens.
        statement('DELETE FROM sessions WHERE user_id = ? AND token_hash NOT IN (SELECT token_hash FROM sessions WHERE user_id = ? ORDER BY created_at DESC, token_hash LIMIT 19)').run(userId, userId)
        statement('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)').run(session.hash, userId, session.expiresAt, now)
      })
    },
    sessionUser(hash, now) {
      const row = statement('SELECT users.id, users.email FROM sessions JOIN users ON users.id = sessions.user_id WHERE token_hash = ? AND expires_at > ?').get(hash, now)
      return row ? { id: row.id, email: row.email } : null
    },
    removeSession(hash) { statement('DELETE FROM sessions WHERE token_hash = ?').run(hash) },
    upsertDevice(userId, input) {
      return transaction(() => {
        const existing = statement('SELECT * FROM devices WHERE user_id = ? AND client_id = ?').get(userId, input.clientId)
        if (existing && existing.platform !== input.platform) throw new ApiError(409, '设备平台与已注册设备不一致')
        if (existing) {
          statement('UPDATE devices SET name = ?, time_zone = ? WHERE id = ?').run(input.name, input.timeZone, existing.id)
          return deviceView(ownedDevice(userId, existing.id))
        }
        const id = randomUUID()
        statement('INSERT INTO devices (id, user_id, client_id, name, platform, time_zone) VALUES (?, ?, ?, ?, ?, ?)').run(id, userId, input.clientId, input.name, input.platform, input.timeZone)
        return deviceView(ownedDevice(userId, id))
      })
    },
    listDevices(userId) { return statement('SELECT * FROM devices WHERE user_id = ? ORDER BY name, id').all(userId).map(deviceView) },
    requireDevice: ownedDevice,
    putDay(userId, deviceId, date, snapshot, now) {
      return transaction(() => {
        ownedDevice(userId, deviceId)
        const previous = statement('SELECT revision FROM days WHERE device_id = ? AND date = ?').get(deviceId, date)
        if (previous && snapshot.revision <= previous.revision) return { accepted: false, revision: previous.revision }
        statement('INSERT INTO days (device_id, date, revision, time_zone, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(device_id, date) DO UPDATE SET revision = excluded.revision, time_zone = excluded.time_zone, updated_at = excluded.updated_at')
          .run(deviceId, date, snapshot.revision, snapshot.timeZone, now)
        statement('DELETE FROM daily_apps WHERE device_id = ? AND date = ?').run(deviceId, date)
        const insert = statement('INSERT INTO daily_apps (device_id, date, source_id, source_name, total_ms) VALUES (?, ?, ?, ?, ?)')
        for (const app of snapshot.apps) insert.run(deviceId, date, app.sourceId, app.sourceName, app.totalMs)
        statement('UPDATE devices SET last_synced_at = ? WHERE id = ?').run(now, deviceId)
        return { accepted: true, revision: snapshot.revision }
      })
    },
    summary(userId, date, deviceId) {
      if (deviceId) ownedDevice(userId, deviceId)
      const rows = statement('SELECT devices.*, daily_apps.source_id, daily_apps.source_name, daily_apps.total_ms, days.updated_at FROM devices LEFT JOIN days ON days.device_id = devices.id AND days.date = ? LEFT JOIN daily_apps ON daily_apps.device_id = days.device_id AND daily_apps.date = days.date WHERE devices.user_id = ? AND (? IS NULL OR devices.id = ?) ORDER BY devices.name, devices.id, daily_apps.source_id')
        .all(date, userId, deviceId ?? null, deviceId ?? null)
      const devices = new Map()
      const apps = new Map()
      let updatedAt = null
      let totalMs = 0
      for (const row of rows) {
        if (!devices.has(row.id)) devices.set(row.id, { ...deviceView(row), totalMs: 0 })
        if (row.updated_at && (!updatedAt || row.updated_at > updatedAt)) updatedAt = row.updated_at
        if (row.total_ms === null) continue
        totalMs += row.total_ms
        devices.get(row.id).totalMs += row.total_ms
        if (row.total_ms === 0) continue
        const canonical = canonicalApp(row.platform, row.source_id, row.source_name)
        if (!apps.has(canonical.canonicalId)) apps.set(canonical.canonicalId, { ...canonical, totalMs: 0, devices: new Map() })
        const entry = apps.get(canonical.canonicalId)
        entry.totalMs += row.total_ms
        if (!entry.devices.has(row.id)) entry.devices.set(row.id, { deviceId: row.id, name: row.name, platform: row.platform, totalMs: 0 })
        entry.devices.get(row.id).totalMs += row.total_ms
      }
      const byDuration = (left, right) => right.totalMs - left.totalMs || left.name.localeCompare(right.name) || (left.id ?? left.deviceId ?? left.canonicalId).localeCompare(right.id ?? right.deviceId ?? right.canonicalId)
      return {
        date, metric: 'sumDevices', totalMs, updatedAt,
        devices: [...devices.values()].sort(byDuration),
        apps: [...apps.values()].map((entry) => ({ ...entry, devices: [...entry.devices.values()].sort(byDuration) })).sort(byDuration),
      }
    },
  }
}
