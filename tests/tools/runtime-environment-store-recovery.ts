import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { encodePairingOffer } from '../../src/shared/pairing'
import {
  addEnvironmentFromPairingCode,
  getEnvironmentStorePath,
  listEnvironments,
  RuntimeEnvironmentStoreError
} from '../../src/shared/runtime-environment-store'

// Bundle this entry to run the actual store and ACL code on another host without dependencies.
const expectBlocked = process.argv.includes('--expect-blocked')
const root = mkdtempSync(join(tmpdir(), 'orca-environment-recovery-proof-'))
const pairingCode = encodePairingOffer({
  v: 2,
  endpoint: 'ws://127.0.0.1:6768',
  deviceToken: 'recovery-proof-token',
  publicKeyB64: Buffer.alloc(32, 1).toString('base64')
})

const cases = [
  { name: 'nul', contents: Buffer.alloc(640) },
  { name: 'empty', contents: Buffer.alloc(0) },
  { name: 'truncated', contents: Buffer.from('{"version":1,"environments":[') }
]
const fixtureIndex = process.argv.indexOf('--fixture')
if (fixtureIndex !== -1) {
  const fixturePath = process.argv[fixtureIndex + 1]
  if (!fixturePath) {
    throw new Error('--fixture requires a path to a corrupt store')
  }
  cases.push({ name: 'captured', contents: readFileSync(fixturePath) })
}
const results: Record<string, unknown>[] = []

for (const entry of cases) {
  const userDataPath = mkdtempSync(join(root, `${entry.name}-`))
  const storePath = getEnvironmentStorePath(userDataPath)
  writeFileSync(storePath, entry.contents, { mode: 0o600 })
  if (expectBlocked) {
    assert.throws(
      () => addEnvironmentFromPairingCode(userDataPath, { name: 'dev box', pairingCode }),
      RuntimeEnvironmentStoreError
    )
    assert.deepEqual(readFileSync(storePath), entry.contents)
    assert.deepEqual(readdirSync(userDataPath), [basename(storePath)])
    results.push({ case: entry.name, outcome: 'save-blocked', bytes: entry.contents.length })
    continue
  }

  const saved = addEnvironmentFromPairingCode(userDataPath, { name: 'dev box', pairingCode })
  assert.deepEqual(listEnvironments(userDataPath), [saved])
  assert.deepEqual(JSON.parse(readFileSync(storePath, 'utf8')).environments, [saved])
  const backupNames = readdirSync(userDataPath).filter((name) =>
    name.startsWith(`${basename(storePath)}.corrupt.`)
  )
  assert.equal(backupNames.length, 1)
  const backupPath = join(userDataPath, backupNames[0]!)
  const backupBytes = readFileSync(backupPath)
  assert.deepEqual(backupBytes, entry.contents)
  if (process.platform !== 'win32') {
    assert.equal(statSync(backupPath).mode & 0o777, 0o600)
  }
  results.push({
    case: entry.name,
    outcome: 'backup-preserved-and-server-saved',
    backupPath,
    backupBytes: backupBytes.length,
    backupSha256: createHash('sha256').update(backupBytes).digest('hex')
  })
}

const validPath = mkdtempSync(join(root, 'valid-'))
const valid = addEnvironmentFromPairingCode(validPath, { name: 'existing box', pairingCode })
assert.deepEqual(listEnvironments(validPath), [valid])
assert.equal(existsSync(getEnvironmentStorePath(validPath)), true)
assert.deepEqual(readdirSync(validPath), [basename(getEnvironmentStorePath(validPath))])

console.log(
  JSON.stringify(
    {
      platform: process.platform,
      node: process.version,
      expectBlocked,
      root,
      validStore: 'preserved',
      results
    },
    null,
    2
  )
)
