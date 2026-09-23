import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { ApiError } from './validation.mjs'

const derive = promisify(scrypt)
const PARAMETERS = { N: 32768, r: 8, p: 2, maxmem: 64 * 1024 * 1024 }
const DUMMY_SALT = randomBytes(16)
const DUMMY_HASH = Buffer.alloc(64)
export const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000
export const AUTH_ERROR = '邮箱或密码无效，无法完成账号操作'

export async function hashPassword(password) {
  const salt = randomBytes(16)
  const hash = await derive(password, salt, 64, PARAMETERS)
  return `scrypt$${PARAMETERS.N}$${PARAMETERS.r}$${PARAMETERS.p}$${salt.toString('base64')}$${hash.toString('base64')}`
}

export async function verifyPassword(password, encoded) {
  const parts = encoded?.split('$')
  // Missing accounts perform the same expensive derivation as existing accounts.
  // Only our bounded format is accepted, so a modified DB cannot request huge KDFs.
  const valid = parts?.length === 6 && parts[0] === 'scrypt' && parts[1] === '32768' && parts[2] === '8' && parts[3] === '2'
  const salt = valid ? Buffer.from(parts[4], 'base64') : DUMMY_SALT
  const expected = valid ? Buffer.from(parts[5], 'base64') : DUMMY_HASH
  const derived = await derive(password, salt, 64, PARAMETERS)
  return Boolean(valid && expected.length === derived.length && timingSafeEqual(expected, derived))
}

export function tokenHash(token) {
  return createHash('sha256').update(token).digest('hex')
}

export function newSession(now) {
  const token = randomBytes(32).toString('base64url')
  return { token, hash: tokenHash(token), expiresAt: new Date(now + SESSION_DURATION_MS).toISOString() }
}

export function createLimiter({ limit, windowMs, maxKeys = 10000, now }) {
  const entries = new Map()
  return (key) => {
    const time = now()
    let entry = entries.get(key)
    if (!entry || entry.expires <= time) {
      if (entries.size >= maxKeys) {
        for (const [storedKey, value] of entries) if (value.expires <= time) entries.delete(storedKey)
        if (!entries.has(key) && entries.size >= maxKeys) throw new ApiError(429, '请求过于频繁，请稍后再试', 60)
      }
      entry = { count: 0, expires: time + windowMs }
      entries.set(key, entry)
    }
    entry.count += 1
    if (entry.count > limit) throw new ApiError(429, '请求过于频繁，请稍后再试', Math.max(1, Math.ceil((entry.expires - time) / 1000)))
  }
}

export function createAuthGate(maximum = 4) {
  let active = 0
  return async (operation) => {
    if (active >= maximum) throw new ApiError(429, '账号服务繁忙，请稍后重试', 1)
    active += 1
    try { return await operation() } finally { active -= 1 }
  }
}
