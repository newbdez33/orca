import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodePairingOffer } from './pairing'
import {
  addEnvironmentFromPairingCode,
  getEnvironmentStorePath,
  listEnvironments,
  MAX_RUNTIME_ENVIRONMENT_STORE_FILE_BYTES,
  RuntimeEnvironmentStoreError
} from './runtime-environment-store'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>()
  return {
    ...actual,
    openSync: vi.fn(actual.openSync),
    renameSync: vi.fn(actual.renameSync)
  }
})

vi.mock('./secure-path-windows-acl', () => ({
  bestEffortRestrictWindowsPath: () => {},
  restrictWindowsPathSync: () => true,
  resetSecureFileWindowsUserSidForTests: () => {}
}))

const pairingCode = encodePairingOffer({
  v: 2,
  endpoint: 'ws://127.0.0.1:6768',
  deviceToken: 'recovery-test-token',
  publicKeyB64: Buffer.alloc(32, 1).toString('base64')
})

describe('runtime environment store recovery', () => {
  let userDataPath: string
  let storePath: string

  beforeEach(() => {
    userDataPath = fs.mkdtempSync(join(tmpdir(), 'orca-environment-recovery-'))
    storePath = getEnvironmentStorePath(userDataPath)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetAllMocks()
    fs.rmSync(userDataPath, { recursive: true, force: true })
  })

  function backups(): string[] {
    return fs
      .readdirSync(userDataPath)
      .filter((name) => name.startsWith(`${basename(storePath)}.corrupt.`))
      .map((name) => join(userDataPath, name))
  }

  it.each([
    ['NUL-filled', Buffer.alloc(640)],
    ['empty', Buffer.alloc(0)],
    ['truncated', Buffer.from('{"version":1,"environments":[')]
  ])('backs up a %s store and permits a new server to persist', (_label, contents) => {
    fs.writeFileSync(storePath, contents, { mode: 0o600 })

    expect(listEnvironments(userDataPath)).toEqual([])
    expect(fs.existsSync(storePath)).toBe(false)
    const savedBackups = backups()
    expect(savedBackups).toHaveLength(1)
    expect(fs.readFileSync(savedBackups[0]!)).toEqual(contents)
    if (process.platform !== 'win32') {
      expect(fs.statSync(savedBackups[0]!).mode & 0o777).toBe(0o600)
    }

    expect(listEnvironments(userDataPath)).toEqual([])
    expect(backups()).toEqual(savedBackups)
    const added = addEnvironmentFromPairingCode(userDataPath, { name: 'dev box', pairingCode })
    expect(listEnvironments(userDataPath)).toEqual([added])
    expect(JSON.parse(fs.readFileSync(storePath, 'utf8')).environments).toEqual([added])
    expect(fs.readFileSync(savedBackups[0]!)).toEqual(contents)
  })

  it('recovers when adding a server is the first operation after corruption', () => {
    fs.writeFileSync(storePath, Buffer.alloc(640))

    const added = addEnvironmentFromPairingCode(userDataPath, { name: 'dev box', pairingCode })

    expect(listEnvironments(userDataPath)).toEqual([added])
    expect(backups()).toHaveLength(1)
    expect(fs.readFileSync(backups()[0]!)).toEqual(Buffer.alloc(640))
  })

  it('keeps both backups when two corruptions have the same timestamp', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000)
    fs.writeFileSync(storePath, Buffer.alloc(640))
    expect(listEnvironments(userDataPath)).toEqual([])
    const firstBackup = backups()[0]!

    fs.writeFileSync(storePath, '{')
    expect(listEnvironments(userDataPath)).toEqual([])

    expect(backups()).toHaveLength(2)
    expect(fs.readFileSync(firstBackup)).toEqual(Buffer.alloc(640))
    expect(
      fs.readFileSync(
        backups().find((path) => path !== firstBackup)!,
        'utf8'
      )
    ).toBe('{')
  })

  it('preserves the original and refuses a save if the backup cannot be made', () => {
    const contents = Buffer.alloc(640)
    fs.writeFileSync(storePath, contents)
    vi.mocked(fs.renameSync).mockImplementation(() => {
      throw Object.assign(new Error('Backup denied'), { code: 'EPERM' })
    })

    expect(() => listEnvironments(userDataPath)).toThrow(RuntimeEnvironmentStoreError)
    expect(() =>
      addEnvironmentFromPairingCode(userDataPath, { name: 'dev box', pairingCode })
    ).toThrow(RuntimeEnvironmentStoreError)
    expect(fs.readFileSync(storePath)).toEqual(contents)
    expect(backups()).toEqual([])
  })

  it.each(['EACCES', 'EIO'])('preserves the store after a %s read failure', (code) => {
    const contents = '{"version":1,"environments":[]}'
    fs.writeFileSync(storePath, contents)
    vi.mocked(fs.openSync).mockImplementation(() => {
      throw Object.assign(new Error('Read failed'), { code })
    })

    expect(() => listEnvironments(userDataPath)).toThrow(RuntimeEnvironmentStoreError)
    expect(fs.renameSync).not.toHaveBeenCalled()
    expect(fs.readFileSync(storePath, 'utf8')).toBe(contents)
    expect(backups()).toEqual([])
  })

  it.each([
    ['unsupported version', '{"version":2,"environments":[]}'],
    ['invalid schema', '{"version":1,"environments":[{"id":"saved-server"}]}']
  ])('preserves parseable data with an %s', (_label, contents) => {
    fs.writeFileSync(storePath, contents)

    expect(() => listEnvironments(userDataPath)).toThrow(RuntimeEnvironmentStoreError)
    expect(() =>
      addEnvironmentFromPairingCode(userDataPath, { name: 'dev box', pairingCode })
    ).toThrow(RuntimeEnvironmentStoreError)
    expect(fs.readFileSync(storePath, 'utf8')).toBe(contents)
    expect(backups()).toEqual([])
  })

  it('preserves a store that exceeds the read limit', () => {
    fs.writeFileSync(storePath, '{"version":1,"environments":[]}')
    fs.truncateSync(storePath, MAX_RUNTIME_ENVIRONMENT_STORE_FILE_BYTES + 1)

    expect(() => listEnvironments(userDataPath)).toThrow(RuntimeEnvironmentStoreError)
    expect(fs.statSync(storePath).size).toBe(MAX_RUNTIME_ENVIRONMENT_STORE_FILE_BYTES + 1)
    expect(backups()).toEqual([])
  })
})
