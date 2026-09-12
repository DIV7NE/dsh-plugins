import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const p = process.argv[2]
let text
try {
  text = zstdDecompressSync(readFileSync(p)).toString('utf8')
} catch (error) {
  console.log('DECOMPRESS_FAIL ' + error.message)
  process.exit(0)
}
const lines = text.split('\n').filter(Boolean)
console.log('lines: ' + lines.length)
for (const line of lines.slice(-10)) {
  try {
    const o = JSON.parse(line)
    console.log((o.type ?? '?') + ' | ' + String(o.time ?? '') + ' | ' + JSON.stringify(o.data ?? {}).slice(0, 160))
  } catch {
    console.log('raw: ' + line.slice(0, 160))
  }
}
