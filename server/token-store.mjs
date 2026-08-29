import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

const ALGORITHM = 'aes-256-gcm'

async function ensureParent(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
}

export class EncryptedTokenStore {
  constructor({ filePath, key }) {
    this.filePath = filePath
    this.key = key
  }

  async load() {
    if (!this.key) return null
    try {
      const envelope = JSON.parse(await fs.readFile(this.filePath, 'utf8'))
      if (envelope.version !== 1 || typeof envelope.iv !== 'string' || typeof envelope.tag !== 'string' || typeof envelope.data !== 'string') return null
      const decipher = crypto.createDecipheriv(ALGORITHM, this.key, Buffer.from(envelope.iv, 'base64'))
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'))
      return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]).toString('utf8'))
    } catch {
      return null
    }
  }

  async save(value) {
    if (!this.key) throw new Error('TOKEN_ENCRYPTION_KEY is not configured')
    await ensureParent(this.filePath)
    const iv = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv(ALGORITHM, this.key, iv)
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])
    const envelope = JSON.stringify({ version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: encrypted.toString('base64') })
    const tempPath = `${this.filePath}.${process.pid}.tmp`
    await fs.writeFile(tempPath, envelope, { mode: 0o600 })
    await fs.rename(tempPath, this.filePath)
  }

  async clear() {
    await fs.rm(this.filePath, { force: true })
  }
}
