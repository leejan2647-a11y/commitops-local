/** Keep the same key after an uncertain response; changed inputs create a new submission. */
export function submissionKeys() {
  const fileIds = new WeakMap<File, string>()
  let pending: { signature: string; key: string } | null = null
  return {
    key(fields: string, files: File[]) {
      const ids = files.map(file => {
        if (!fileIds.has(file)) fileIds.set(file, crypto.randomUUID())
        return fileIds.get(file)
      })
      const signature = JSON.stringify([fields, ids])
      if (pending?.signature !== signature) pending = { signature, key: crypto.randomUUID() }
      return pending.key
    },
    acknowledged() { pending = null },
  }
}
