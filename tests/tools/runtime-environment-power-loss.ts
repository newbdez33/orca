import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { encodePairingOffer } from '../../src/shared/pairing'
import { createEnvironmentFromPairingOffer } from '../../src/shared/runtime-environments'
import {
  addEnvironmentFromPairingCode,
  getEnvironmentStorePath
} from '../../src/shared/runtime-environment-store'

function emit(value: unknown): void {
  writeSync(1, `${JSON.stringify(value)}\n`)
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

const [mode, argument, countArgument] = process.argv.slice(2)
if (mode === 'write') {
  const targetBytes = Number(argument ?? 640)
  if (!Number.isSafeInteger(targetBytes) || targetBytes < 640 || targetBytes > 65_536) {
    throw new Error('Payload size must be between 640 and 65536 bytes')
  }
  const maxWrites = Number(countArgument ?? 500)
  if (!Number.isSafeInteger(maxWrites) || maxWrites < 1 || maxWrites > 500) {
    throw new Error('Write count must be between 1 and 500')
  }
  const root = mkdtempSync(join(tmpdir(), 'orca-environment-power-loss-'))
  const now = 1_700_000_000_000
  const offer = {
    v: 2 as const,
    endpoint: 'ws://127.0.0.1:6768',
    deviceToken: 'power-loss-test-token',
    publicKeyB64: Buffer.alloc(32, 1).toString('base64')
  }
  const sample = createEnvironmentFromPairingOffer({
    id: '00000000-0000-0000-0000-000000000000',
    name: 'x',
    now,
    offer
  })
  const sampleLength = Buffer.byteLength(JSON.stringify({ version: 1, environments: [sample] }))
  const name = 'x'.repeat(targetBytes - sampleLength + 1)
  const pairingCode = encodePairingOffer(offer)
  emit({
    event: 'ready',
    root,
    pid: process.pid,
    platform: process.platform,
    node: process.version,
    targetBytes
  })
  const started = performance.now()
  for (let index = 0; index < maxWrites && performance.now() - started < 120_000; index += 1) {
    const userDataPath = mkdtempSync(join(root, 'sample-'))
    const path = getEnvironmentStorePath(userDataPath)
    emit({ event: 'write-start', index, path })
    const saved = addEnvironmentFromPairingCode(userDataPath, { name, pairingCode, now })
    const expected = Buffer.from(JSON.stringify({ version: 1, environments: [saved] }))
    if (expected.length !== targetBytes) {
      throw new Error(`Unexpected serialized size: ${expected.length}`)
    }
    emit({ event: 'write-complete', index, path, bytes: expected.length, sha256: sha256(expected) })
  }
  emit({ event: 'batch-complete' })
} else if (mode === 'inspect') {
  if (!argument) {
    throw new Error('A host-recorded manifest is required')
  }
  const manifest = JSON.parse(readFileSync(argument, 'utf8')) as {
    root: string
    events: { event: string; path?: string; bytes?: number; sha256?: string }[]
  }
  if (!basename(manifest.root).startsWith('orca-environment-power-loss-')) {
    throw new Error('Refusing to inspect an unrelated directory')
  }
  const expected = new Map(
    manifest.events
      .filter((event) => event.event === 'write-complete')
      .map((event) => [event.path!, event])
  )
  const started = manifest.events.filter((event) => event.event === 'write-start')
  const results: Record<string, unknown>[] = []
  for (const event of started) {
    const path = event.path!
    const completion = expected.get(path)
    try {
      const raw = readFileSync(path)
      const digest = sha256(raw)
      let outcome = 'unacknowledged'
      if (completion) {
        if (raw.length === completion.bytes && digest === completion.sha256) {
          outcome = 'intact'
        } else if (raw.length === 0) {
          outcome = 'empty'
        } else if (raw.every((byte) => byte === 0)) {
          outcome = 'nul-filled'
        } else {
          try {
            JSON.parse(raw.toString('utf8'))
            outcome = 'unexpected-json'
          } catch {
            outcome = 'invalid-json'
          }
        }
      }
      results.push({
        path,
        acknowledged: Boolean(completion),
        outcome,
        bytes: raw.length,
        sha256: digest,
        rawBase64: raw.toString('base64')
      })
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      results.push({
        path,
        acknowledged: Boolean(completion),
        outcome: code === 'ENOENT' ? 'missing' : 'unreadable',
        code
      })
    }
  }
  const counts: Record<string, number> = {}
  for (const item of results) {
    if (item.acknowledged) {
      const outcome = String(item.outcome)
      counts[outcome] = (counts[outcome] ?? 0) + 1
    }
  }
  let remainingEntries: string[] = []
  try {
    remainingEntries = readdirSync(manifest.root)
  } catch {}
  emit({
    event: 'inspection',
    root: manifest.root,
    completedWrites: expected.size,
    counts,
    results,
    remainingEntries
  })
} else {
  throw new Error('Usage: probe.cjs write [bytes] [max-writes] | inspect manifest.json')
}
