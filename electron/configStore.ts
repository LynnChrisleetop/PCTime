import { app } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createSerialQueue, DEFAULT_CONFIG, sanitizeConfig } from './configModel'
import type { UsageConfig } from './configModel'

export type { CategoryRule, UsageConfig, WebDavConfig } from './configModel'

export function getConfigPath() {
  return path.join(app.getPath('userData'), 'config.json')
}

const enqueueWrite = createSerialQueue()

export async function loadConfig(): Promise<UsageConfig> {
  const filePath = getConfigPath()
  let raw: string
  try {
    raw = await fs.readFile(filePath, 'utf-8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return saveConfig(DEFAULT_CONFIG)
  }
  try {
    return sanitizeConfig(JSON.parse(raw))
  } catch {
    // Preserve a broken file for recovery instead of silently overwriting it.
    await fs.copyFile(filePath, `${filePath}.corrupt-${Date.now()}`)
    return saveConfig(DEFAULT_CONFIG)
  }
}

export function saveConfig(config: UsageConfig) {
  const normalized = sanitizeConfig(config)
  return enqueueWrite(async () => {
    const filePath = getConfigPath()
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    const temporaryPath = `${filePath}.tmp`
    await fs.writeFile(temporaryPath, JSON.stringify(normalized, null, 2), 'utf-8')
    await fs.rename(temporaryPath, filePath)
    return normalized
  })
}
