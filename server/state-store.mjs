import fs from 'node:fs/promises'
import path from 'node:path'

export class StateStore {
  constructor(filePath) {
    this.filePath = filePath
    this.value = null
  }

  async load() {
    try {
      this.value = JSON.parse(await fs.readFile(this.filePath, 'utf8'))
    } catch {
      this.value = {}
    }
    return this.value
  }

  async save(value) {
    this.value = value
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    const tempPath = `${this.filePath}.${process.pid}.tmp`
    await fs.writeFile(tempPath, JSON.stringify(value), { mode: 0o600 })
    await fs.rename(tempPath, this.filePath)
  }
}
