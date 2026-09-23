import type { UsageConfig, WebDavConfig } from './configModel'

export type WebdavClient = {
  stat(remotePath: string): Promise<unknown>
  getDirectoryContents(remotePath: string): Promise<unknown>
  createDirectory(remotePath: string, options?: { recursive: boolean }): Promise<unknown>
  getFileContents(remotePath: string, options: { format: 'text' }): Promise<unknown>
  putFileContents(remotePath: string, contents: string, options: { overwrite: boolean }): Promise<unknown>
}

export function normalizeRemotePath(remotePath: string) {
  const normalized = remotePath.replace(/\\/g, '/').trim().replace(/\/+$/, '')
  if (!normalized) return remotePath.trim() === '/' ? '/' : '/PCTime'
  return normalized.startsWith('/') ? normalized : `/${normalized}`
}

function missing(error: unknown) {
  return (error as { status?: number })?.status === 404
}

export function validateWebdav(config: WebDavConfig) {
  if (!config.url || !config.username || !config.password) throw new Error('请先填写并保存 WebDAV 地址、账号和密码')
  let url: URL
  try { url = new URL(config.url) } catch { throw new Error('WebDAV 地址格式无效') }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('WebDAV 地址必须以 http:// 或 https:// 开头')
}

// Testing a connection must never create, download, or overwrite user files.
export async function testWebdavConnection(client: WebdavClient, remotePath: string) {
  let directory = normalizeRemotePath(remotePath)
  for (;;) {
    try {
      await client.getDirectoryContents(directory)
      return { ok: true, message: '连接成功，目录可读取；写入权限将在同步时验证' }
    } catch (error) {
      if (!missing(error) || directory === '/') throw error
      directory = directory.slice(0, directory.lastIndexOf('/')) || '/'
    }
  }
}

export async function syncUsageWithWebdav(client: WebdavClient, options: {
  remotePath: string
  flush: () => Promise<void>
  merge: (value: unknown) => Promise<void>
  readUsage: () => Promise<string>
  config: UsageConfig
}) {
  const basePath = normalizeRemotePath(options.remotePath)
  try {
    await client.stat(basePath)
  } catch (error) {
    if (!missing(error)) throw error
    await client.createDirectory(basePath, { recursive: true })
  }
  const remoteFile = `${basePath === '/' ? '' : basePath}/usage.json`
  await options.flush()
  let remoteContents: unknown
  try {
    remoteContents = await client.getFileContents(remoteFile, { format: 'text' })
  } catch (error) {
    if (!missing(error)) throw error
  }
  if (remoteContents !== undefined) {
    if (typeof remoteContents !== 'string') throw new Error('远端统计数据格式无效，本地数据未被替换')
    let imported: unknown
    try { imported = JSON.parse(remoteContents) } catch { throw new Error('远端统计文件不是有效 JSON，本地数据未被替换') }
    await options.merge(imported)
  }
  await options.flush()
  await client.putFileContents(remoteFile, await options.readUsage(), { overwrite: true })
  // Configuration is a backup only: another device must not replace this machine's
  // live settings or credentials. Credentials and startup settings stay local.
  const { categories, categoryColors, defaultCategory, rules } = options.config
  const configuration = { categories, categoryColors, defaultCategory, rules }
  await client.putFileContents(`${basePath === '/' ? '' : basePath}/config.json`, JSON.stringify(configuration, null, 2), { overwrite: true })
}

export function webdavErrorMessage(error: unknown) {
  const status = (error as { status?: number })?.status
  if (status === 401 || status === 403) return '认证失败或没有访问权限，请检查账号、密码和目录权限'
  if (status === 404) return '远端地址或目录不存在，请检查 WebDAV 配置'
  if (status === 409) return '远端目录无法创建，请检查同步目录'
  if (error instanceof Error && !error.message.includes('http')) return error.message
  return '无法连接 WebDAV，请检查网络、服务器地址和访问权限'
}
