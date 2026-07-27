import { ipcRenderer, contextBridge } from 'electron'

// --------- Expose some API to the Renderer process ---------
contextBridge.exposeInMainWorld('ipcRenderer', {
  on(...args: Parameters<typeof ipcRenderer.on>) {
    const [channel, listener] = args
    return ipcRenderer.on(channel, (event, ...args) => listener(event, ...args))
  },
  off(...args: Parameters<typeof ipcRenderer.off>) {
    const [channel, ...omit] = args
    return ipcRenderer.off(channel, ...omit)
  },
  send(...args: Parameters<typeof ipcRenderer.send>) {
    const [channel, ...omit] = args
    return ipcRenderer.send(channel, ...omit)
  },
  invoke(...args: Parameters<typeof ipcRenderer.invoke>) {
    const [channel, ...omit] = args
    return ipcRenderer.invoke(channel, ...omit)
  },

  // You can expose other APTs you need here.
  // ...
})

contextBridge.exposeInMainWorld('usage', {
  getSummary(range?: string, date?: string) {
    return ipcRenderer.invoke('usage:getSummary', { range, date })
  },
  getConfig() {
    return ipcRenderer.invoke('usage:getConfig')
  },
  setConfig(config: unknown) {
    return ipcRenderer.invoke('usage:setConfig', config)
  },
  saveExport(content: string, defaultPath: string) {
    return ipcRenderer.invoke('usage:saveExport', { content, defaultPath })
  },
  testWebdav() {
    return ipcRenderer.invoke('usage:testWebdav')
  },
  syncNow() {
    return ipcRenderer.invoke('usage:syncNow')
  },
})
