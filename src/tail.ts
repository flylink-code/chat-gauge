import { Buffer } from 'node:buffer'
import { open } from 'node:fs/promises'
import { Transcript } from './transcript'

const MAX_BYTES = 1024 * 1024

export class TranscriptTail {
  private offset = 0
  private identity = ''
  private pending = Buffer.alloc(0)
  private skipLine = false
  private parser = new Transcript()

  private readonly path: string
  private readonly sessionId: string

  constructor(path: string, sessionId: string) {
    this.path = path
    this.sessionId = sessionId
  }

  async read() {
    const file = await open(this.path, 'r')
    try {
      const stat = await file.stat()
      if (!stat.isFile()) return null
      const identity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`
      if (identity !== this.identity || stat.size < this.offset || stat.size - this.offset > MAX_BYTES) {
        this.identity = identity
        this.offset = Math.max(0, stat.size - MAX_BYTES)
        this.pending = Buffer.alloc(0)
        this.skipLine = this.offset > 0
        this.parser = new Transcript()
      }
      const toRead = stat.size - this.offset
      if (toRead === 0) return this.parser.sample
      const buf = Buffer.allocUnsafe(toRead)
      const { bytesRead } = await file.read(buf, 0, toRead, this.offset)
      this.offset += bytesRead
      const bytes = Buffer.concat([this.pending, buf.subarray(0, bytesRead)])
      let start = 0
      for (let end = bytes.indexOf(10); end !== -1; end = bytes.indexOf(10, start)) {
        if (!this.skipLine && end - start <= MAX_BYTES) {
          this.parser.consume(bytes.toString('utf8', start, end), this.sessionId)
        }
        this.skipLine = false
        start = end + 1
      }
      const remaining = bytes.length - start
      if (remaining >= MAX_BYTES) this.skipLine = true
      this.pending = this.skipLine ? Buffer.alloc(0) : Buffer.from(bytes.subarray(start))
      return this.parser.sample
    } finally { await file.close() }
  }
}
