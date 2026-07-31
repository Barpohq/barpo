// ssh.ts — network-free tests: the command runner is faked and the file paths
// point into a temporary folder (PLATFORM_SSH / PLATFORM_USER_SSH_CONFIG).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from '@platforma/shared'
import {
  setCommandRunner,
  managedConfigPath,
  writeManagedConfig,
  ensureInclude,
  installKey,
  parseMetrics,
  type CommandResult,
} from '../src/ssh.ts'

let dir: string

/** The calls made to the fake runner — every test inspects them */
let calls: { argv: string[]; env?: Record<string, string>; stdin?: string }[]

function fakeRunner(reply: (argv: string[]) => CommandResult) {
  setCommandRunner(async (argv, options) => {
    calls.push({ argv, env: options?.env, stdin: options?.stdin })
    return reply(argv)
  })
}

const OK: CommandResult = { code: 0, stdout: '', stderr: '' }
const DENIED: CommandResult = { code: 255, stdout: '', stderr: 'Permission denied (publickey).' }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'platforma-ssh-'))
  process.env.PLATFORM_SSH = join(dir, 'ssh')
  process.env.PLATFORM_USER_SSH_CONFIG = join(dir, 'user-config')
  calls = []
  // The public key is written up front so that ssh-keygen is not invoked
  mkdirSync(join(dir, 'ssh'), { recursive: true })
  writeFileSync(join(dir, 'ssh', 'id_ed25519.pub'), 'ssh-ed25519 AAAATEST platforma\n')
})

afterEach(() => {
  setCommandRunner(null)
  delete process.env.PLATFORM_SSH
  delete process.env.PLATFORM_USER_SSH_CONFIG
  rmSync(dir, { recursive: true, force: true })
})

function server(partial: Partial<Server> = {}): Server {
  return {
    id: 'x',
    name: 'test-1',
    host: '203.0.113.10',
    port: 22,
    username: 'root',
    createdAt: '2026-07-29T00:00:00.000Z',
    ...partial,
  }
}

describe('writeManagedConfig', () => {
  test('it writes a Host block for every server', () => {
    writeManagedConfig([server(), server({ id: 'y', name: 'second', host: 'ex.uz', port: 2222, username: 'deploy' })])

    const text = readFileSync(managedConfigPath(), 'utf-8')
    expect(text).toContain('Host test-1')
    expect(text).toContain('HostName 203.0.113.10')
    expect(text).toContain('Host second')
    expect(text).toContain('Port 2222')
    expect(text).toContain('User deploy')
    expect(text).toContain('IdentitiesOnly yes')
    expect(text).toContain('StrictHostKeyChecking accept-new')
  })

  test('an empty list still writes the file, so a deleted server drops out', () => {
    writeManagedConfig([server()])
    writeManagedConfig([])
    const text = readFileSync(managedConfigPath(), 'utf-8')
    expect(text).not.toContain('Host test-1')
  })
})

describe('ensureInclude', () => {
  test('it writes the Include into a file that does not exist yet', () => {
    ensureInclude()
    const text = readFileSync(join(dir, 'user-config'), 'utf-8')
    expect(text).toContain(`Include ${managedConfigPath()}`)
  })

  test('existing content is kept and the Include goes FIRST', () => {
    writeFileSync(join(dir, 'user-config'), 'Host old\n  HostName old.uz\n')
    ensureInclude()
    const text = readFileSync(join(dir, 'user-config'), 'utf-8')
    expect(text).toContain('Host old')
    // The Include must sit BEFORE the first Host, otherwise it would be read
    // as part of that block
    expect(text.indexOf('Include')).toBeLessThan(text.indexOf('Host old'))
  })

  test('a second call does not duplicate the line (idempotent)', () => {
    ensureInclude()
    ensureInclude()
    const text = readFileSync(join(dir, 'user-config'), 'utf-8')
    const count = text.split('\n').filter((line) => line.startsWith('Include ')).length
    expect(count).toBe(1)
  })
})

describe('installKey', () => {
  test('when the existing key gets in there is one ssh call and no sshpass', async () => {
    fakeRunner(() => OK)
    await installKey({ host: 'ex.uz', port: 22, username: 'root' })

    expect(calls).toHaveLength(1)
    const argv = calls[0]!.argv
    expect(argv[0]).toBe('ssh')
    expect(argv).toContain('BatchMode=yes')
    expect(argv).toContain('root@ex.uz')
    // The script appends the key idempotently
    expect(argv.at(-1)).toContain('authorized_keys')
    expect(argv.at(-1)).toContain('ssh-ed25519 AAAATEST platforma')
  })

  test('when the key is refused and no password is given the error explains why', async () => {
    fakeRunner(() => DENIED)
    await expect(installKey({ host: 'ex.uz', port: 22, username: 'root' })).rejects.toThrow(
      /Enter a password/,
    )
  })

  test('with a password sshpass is invoked and the password travels via SSHPASS', async () => {
    fakeRunner((argv) => (argv[0] === 'sshpass' ? OK : DENIED))
    await installKey({ host: 'ex.uz', port: 2222, username: 'root' }, 'secret')

    expect(calls).toHaveLength(2)
    const second = calls[1]!
    expect(second.argv[0]).toBe('sshpass')
    expect(second.argv).toContain('-e')
    expect(second.env?.SSHPASS).toBe('secret')
    // The password must NEVER appear in argv
    expect(second.argv.join(' ')).not.toContain('secret')
    expect(second.argv).toContain('2222')
  })

  test('a wrong password produces a precise message', async () => {
    fakeRunner((argv) =>
      argv[0] === 'sshpass' ? { code: 5, stdout: '', stderr: 'Permission denied' } : DENIED,
    )
    await expect(
      installKey({ host: 'ex.uz', port: 22, username: 'root' }, 'wrong-password'),
    ).rejects.toThrow(/Wrong password/)
  })
})

describe('parseMetrics', () => {
  test('it turns the full output into percentages', () => {
    const m = parseMetrics(
      [
        'UPTIME=up 3 days, 4 hours, 12 minutes',
        'LOAD=1.5',
        'NPROC=4',
        'RAM=8000000000 2000000000',
        'DISK=100000 84000',
      ].join('\n'),
    )
    expect(m.status).toBe('connected')
    expect(m.uptime).toBe('3 days 4 hours 12 minutes')
    expect(m.cpu).toBe(38) // 1.5 / 4 = 37.5% → 38
    expect(m.ram).toBe(25)
    expect(m.disk).toBe(84)
  })

  test('missing lines leave their field empty but the status is still connected', () => {
    const m = parseMetrics('UPTIME=up 5 minutes\n')
    expect(m.status).toBe('connected')
    expect(m.uptime).toBe('5 minutes')
    expect(m.cpu).toBeUndefined()
    expect(m.ram).toBeUndefined()
    expect(m.disk).toBeUndefined()
  })

  test('a load above the core count is clamped to 100%', () => {
    const m = parseMetrics('LOAD=9.0\nNPROC=2\n')
    expect(m.cpu).toBe(100)
  })
})

describe('ensureKey (indirectly)', () => {
  test('ssh-keygen is invoked when the public key file is missing', async () => {
    rmSync(join(dir, 'ssh', 'id_ed25519.pub'))
    fakeRunner((argv) => {
      if (argv[0] === 'ssh-keygen') {
        // The real keygen writes the file itself — so does the fake one
        writeFileSync(join(dir, 'ssh', 'id_ed25519.pub'), 'ssh-ed25519 NEW platforma\n')
        return OK
      }
      return OK
    })

    await installKey({ host: 'ex.uz', port: 22, username: 'root' })
    expect(calls[0]!.argv[0]).toBe('ssh-keygen')
    expect(existsSync(join(dir, 'ssh', 'id_ed25519.pub'))).toBe(true)
  })
})
