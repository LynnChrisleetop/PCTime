declare module 'webdav' {
  export function createClient(
    url: string,
    options: { username: string; password: string; timeout?: number }
  ): import('./webdavSync').WebdavClient
}
