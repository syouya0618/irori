/** Browser-local wrapping keys. They are not authentication or XSS boundaries. */
const DATABASE = "irori-record-request-keys"
const STORE = "keys"

function openKeys(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1)
    let done = false
    const timer = setTimeout(() => { done = true; reject(new Error("key store unavailable")) }, 3000)
    request.onupgradeneeded = () => request.result.createObjectStore(STORE)
    request.onerror = () => { clearTimeout(timer); reject(request.error) }
    request.onblocked = () => { clearTimeout(timer); done = true; reject(new Error("key store blocked")) }
    request.onsuccess = () => {
      clearTimeout(timer)
      if (done) request.result.close()
      else resolve(request.result)
    }
  })
}

function readKey(db: IDBDatabase, owner: string, candidate?: CryptoKey): Promise<CryptoKey | undefined> {
  return new Promise((resolve, reject) => {
    // A readwrite get-or-add prevents two tabs from replacing each other's key.
    const transaction = db.transaction(STORE, candidate ? "readwrite" : "readonly")
    const store = transaction.objectStore(STORE)
    const request = store.get(owner)
    let value: CryptoKey | undefined
    request.onsuccess = () => {
      value = request.result
      if (!value && candidate) { value = candidate; store.add(candidate, owner) }
    }
    transaction.oncomplete = () => resolve(value)
    transaction.onerror = transaction.onabort = () => reject(transaction.error ?? new Error("key transaction failed"))
  })
}

export async function recordRequestKey(owner: string, create: boolean): Promise<CryptoKey> {
  const db = await openKeys()
  try {
    let key = await readKey(db, owner)
    if (!key && create) {
      const candidate = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"])
      key = await readKey(db, owner, candidate)
    }
    if (!key || key.type !== "secret" || key.extractable || key.algorithm.name !== "AES-GCM" || !key.usages.includes("encrypt") || !key.usages.includes("decrypt")) throw new Error("key unavailable")
    return key
  } finally { db.close() }
}

export async function removeRecordRequestKeys(owners: string[], canRemove: (owner: string) => boolean): Promise<void> {
  if (!owners.length) return
  const db = await openKeys()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE, "readwrite")
      const store = transaction.objectStore(STORE)
      for (const owner of owners) {
        const request = store.get(owner)
        // Recheck inside the active transaction, after open/queue waits. A stale
        // account cleanup must not delete a key used by a returned owner.
        request.onsuccess = () => { try { if (canRemove(owner)) store.delete(owner) } catch { transaction.abort() } }
      }
      transaction.oncomplete = () => resolve()
      transaction.onerror = transaction.onabort = () => reject(transaction.error ?? new Error("key cleanup failed"))
    })
  } finally { db.close() }
}
