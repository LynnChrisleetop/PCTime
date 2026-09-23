export function createQuitHandler(options: {
  onStart: () => void
  finish: () => Promise<void>
  quit: () => void
  onError: (error: unknown) => void
}) {
  let complete = false
  let pending: Promise<void> | undefined
  return (event: { preventDefault: () => void }) => {
    if (complete) return
    event.preventDefault()
    if (!pending) {
      options.onStart()
      pending = Promise.resolve().then(options.finish).catch(options.onError).finally(() => {
        complete = true
        options.quit()
      })
    }
    return pending
  }
}
