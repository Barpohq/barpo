// The SSH layer used by app controls — the first two layers of injection
// protection are checked here.
//
// What these tests are for: a value the user typed (a bot token) must under NO
// circumstances reach the server's shell as a command, and must never show up
// in `ps`.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  createAppSsh,
  ENV_SIZE_LIMIT,
  escapeEnvValue,
  updateEnvLines,
} from '../src/app-ssh.ts'
import { setCommandRunner, type CommandResult } from '../src/ssh.ts'

let calls: { argv: string[]; stdin?: string }[]

function fakeSsh(reply: (argv: string[]) => CommandResult) {
  setCommandRunner(async (argv, options) => {
    calls.push({ argv, stdin: options?.stdin })
    return reply(argv)
  })
}

const OK: CommandResult = { code: 0, stdout: '', stderr: '' }

beforeEach(() => {
  calls = []
})

afterEach(() => {
  setCommandRunner(null)
})

describe('escapeEnvValue — the shell must interpret nothing', () => {
  test('a plain value is left unquoted (easier to read in the file)', () => {
    expect(escapeEnvValue('7891234:AAHabc-def_x')).toBe('7891234:AAHabc-def_x')
    expect(escapeEnvValue('https://example.com/hook')).toBe('https://example.com/hook')
    expect(escapeEnvValue('')).toBe('')
  })

  // THE MOST IMPORTANT TEST. If the `.env` file is `source`d, an unescaped
  // `$(...)` would run as a COMMAND.
  test('values that try to execute a command are neutralised', () => {
    const dangerous = [
      '$(rm -rf /)',
      '`whoami`',
      '${HOME}',
      'x; rm -rf /',
      'x && curl evil.com',
      'x | sh',
      'x > /etc/passwd',
    ]

    for (const raw of dangerous) {
      const result = escapeEnvValue(raw)
      // Inside single quotes the shell interprets nothing
      expect(result.startsWith("'")).toBe(true)
      expect(result.endsWith("'")).toBe(true)
    }
  })

  // The classic hole in quote escaping: a `'` would close the value and spill
  // the rest out to the shell.
  test("a quote inside the value is escaped the POSIX way", () => {
    expect(escapeEnvValue("x'y")).toBe("'x'\\''y'")
    // An attempt to break out of the escaping
    expect(escapeEnvValue("'; rm -rf /; '")).toBe("''\\''; rm -rf /; '\\'''")
  })

  test('newlines are stripped — a value must not split into a second key', () => {
    // Otherwise `TOKEN=x\nADMIN=1` would end up as two keys.
    expect(escapeEnvValue('x\nADMIN=1')).not.toContain('\n')
    expect(escapeEnvValue('x\r\ny')).not.toContain('\r')
  })
})

describe('updateEnvLines — THE OLD VALUE MUST NOT REMAIN IN THE FILE', () => {
  test('an existing key is replaced IN PLACE', () => {
    const result = updateEnvLines('TOKEN=old\nADMIN=1\n', { TOKEN: 'new' })

    expect(result).toBe('TOKEN=new\nADMIN=1\n')
    // That the old value does not survive is the core requirement: some `.env`
    // readers take the FIRST value, so the bot would keep using the old one.
    expect(result).not.toContain('old')
  })

  test('a missing key is appended at the end', () => {
    expect(updateEnvLines('ADMIN=1\n', { TOKEN: 'new' })).toBe('ADMIN=1\nTOKEN=new\n')
  })

  test('it starts from an empty file', () => {
    expect(updateEnvLines('', { TOKEN: 'x' })).toBe('TOKEN=x\n')
  })

  // The file is human-readable configuration — wiping the comments out would
  // destroy the user's work.
  test('comments and ordering are preserved', () => {
    const existing = '# Bot settings\nTOKEN=old\n\n# Admin\nADMIN=1\n'
    const result = updateEnvLines(existing, { TOKEN: 'new' })

    expect(result).toContain('# Bot settings')
    expect(result).toContain('# Admin')
    expect(result.indexOf('TOKEN')).toBeLessThan(result.indexOf('ADMIN'))
  })

  test('a key inside a comment is left alone', () => {
    const result = updateEnvLines('#TOKEN=commented\nTOKEN=real\n', { TOKEN: 'new' })
    expect(result).toContain('#TOKEN=commented')
    expect(result).toContain('TOKEN=new')
  })

  test('several keys are updated together', () => {
    const result = updateEnvLines('A=1\nB=2\n', { A: '10', C: '30' })
    expect(result).toBe('A=10\nB=2\nC=30\n')
  })

  test('the last line ends with a newline', () => {
    // POSIX tools (`source`, `read`) can drop a final line without one.
    expect(updateEnvLines('A=1', { B: '2' }).endsWith('\n')).toBe(true)
  })

  test('the value is escaped', () => {
    const result = updateEnvLines('', { TOKEN: '$(evil)' })
    expect(result).toBe("TOKEN='$(evil)'\n")
  })
})

describe('ssh.command — a failed command COMES BACK AS AN ERROR', () => {
  // ┌──────────────────────────────────────────────────────────────┐
  // │ THE MOST IMPORTANT TEST. The AI's code DOES NOT CHECK the    │
  // │ exit code:                                                   │
  // │     await ssh('h').command([...])                            │
  // │     return { message: 'The bot was restarted' }               │
  // │ If we returned a result, the user would see "restarted" even │
  // │ when `ssh` had failed — a SILENT lie.                        │
  // └──────────────────────────────────────────────────────────────┘
  test('a non-zero exit code THROWS', async () => {
    fakeSsh(() => ({ code: 255, stdout: '', stderr: 'ssh: connect to host: No route to host' }))

    await expect(createAppSsh('h').command(['docker', 'restart', 'bot'])).rejects.toThrow(
      /No route to host/,
    )
  })

  test('the error text names the exit code', async () => {
    fakeSsh(() => ({ code: 127, stdout: '', stderr: '' }))
    await expect(createAppSsh('h').command(['no-such-command'])).rejects.toThrow(/127/)
  })

  test('when stderr is empty the reason is taken from stdout', async () => {
    fakeSsh(() => ({ code: 1, stdout: 'Error: container not found', stderr: '' }))
    await expect(createAppSsh('h').command(['docker', 'restart', 'x'])).rejects.toThrow(
      /container not found/,
    )
  })

  test('a successful command returns its result', async () => {
    fakeSsh(() => ({ code: 0, stdout: 'ready', stderr: '' }))
    const result = await createAppSsh('h').command(['echo', 'x'])
    expect(result.stdout).toBe('ready')
  })

  // `docker inspect` returns 1 for a missing container — that is not an ERROR,
  // it is an ANSWER.
  test('rawCommand does not treat a non-zero exit code as an error', async () => {
    fakeSsh(() => ({ code: 1, stdout: '', stderr: 'not found' }))

    const result = await createAppSsh('h').rawCommand(['docker', 'inspect', 'x'])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('not found')
  })
})

describe('ssh.command — a shell STRING IS NOT ACCEPTED', () => {
  test('it works with an argv array', async () => {
    fakeSsh(() => OK)
    const ssh = createAppSsh('helsinki-1')
    await ssh.command(['docker', 'restart', 'bot'])

    expect(calls).toHaveLength(1)
    // The managed config and BatchMode are mandatory
    expect(calls[0]!.argv).toContain('-F')
    expect(calls[0]!.argv).toContain('helsinki-1')
  })

  // This is the FIRST layer of the protection: if we accepted a string, the AI
  // would write a template string and the user's input would land in the shell.
  test('passing a string THROWS', async () => {
    fakeSsh(() => OK)
    const ssh = createAppSsh('helsinki-1')

    // @ts-expect-error — deliberately the wrong type
    await expect(ssh.command('docker restart bot')).rejects.toThrow(/array/i)
    expect(calls).toHaveLength(0)
  })

  test('an empty argv THROWS', async () => {
    fakeSsh(() => OK)
    await expect(createAppSsh('h').command([])).rejects.toThrow()
  })

  test('an object argument THROWS', async () => {
    fakeSsh(() => OK)
    // @ts-expect-error — deliberately the wrong type
    await expect(createAppSsh('h').command(['echo', { a: 1 }])).rejects.toThrow(/string/i)
  })

  // A container name typed by the user goes into the command — it has to stay a
  // separate argument and must not turn into a command of its own.
  test('shell metacharacters inside an argument are neutralised', async () => {
    fakeSsh(() => OK)
    const ssh = createAppSsh('helsinki-1')
    await ssh.command(['docker', 'restart', 'bot; rm -rf /'])

    const sent = calls[0]!.argv.join(' ')
    // The `;` sits inside escaped quotes — the shell does not read it as a separator
    expect(sent).toContain("'bot; rm -rf /'")
  })
})

describe('ssh.writeEnv — the token MUST NOT SHOW UP in `ps`', () => {
  test('the value travels over STDIN and is absent from argv', async () => {
    fakeSsh(() => OK)
    const ssh = createAppSsh('helsinki-1')

    await ssh.writeEnv('/opt/bot/.env', { TOKEN: '7891234:SECRET' })

    // The last call is the write
    const write = calls[calls.length - 1]!

    // ┌────────────────────────────────────────────────────────────┐
    // │ THE CORE CHECK: the token must NOT be in the arguments.     │
    // │ Otherwise it would be visible in `ps` output on the server. │
    // └────────────────────────────────────────────────────────────┘
    expect(write.argv.join(' ')).not.toContain('SECRET')
    expect(write.stdin).toContain('TOKEN=7891234:SECRET')
  })

  test('an existing file is read and the key replaced', async () => {
    fakeSsh((argv) => {
      if (argv.includes('cat')) {
        return { code: 0, stdout: 'TOKEN=old\nADMIN=5\n', stderr: '' }
      }
      return OK
    })

    await createAppSsh('h').writeEnv('/opt/bot/.env', { TOKEN: 'new' })

    const write = calls[calls.length - 1]!
    expect(write.stdin).toBe('TOKEN=new\nADMIN=5\n')
  })

  test('a missing file is created from scratch (not an error)', async () => {
    fakeSsh((argv) => {
      if (argv.includes('cat')) {
        return { code: 1, stdout: '', stderr: 'No such file' }
      }
      return OK
    })

    await createAppSsh('h').writeEnv('/opt/bot/.env', { TOKEN: 'x' })
    expect(calls[calls.length - 1]!.stdin).toBe('TOKEN=x\n')
  })

  // A half-written `.env` would stop the bot from coming back up.
  test('the write is atomic: a temporary file plus mv', async () => {
    fakeSsh(() => OK)
    await createAppSsh('h').writeEnv('/opt/bot/.env', { TOKEN: 'x' })

    const command = calls[calls.length - 1]!.argv.join(' ')
    expect(command).toContain('platform-new')
    expect(command).toContain('mv -f')
    // The token sits in the file — its permissions have to be restricted
    expect(command).toContain('umask 177')
  })

  test('a failed write removes the temporary file and throws', async () => {
    fakeSsh((argv) => {
      if (argv.some((a) => a.includes('mv -f'))) {
        return { code: 1, stdout: '', stderr: 'Permission denied' }
      }
      return OK
    })

    await expect(createAppSsh('h').writeEnv('/opt/bot/.env', { TOKEN: 'x' })).rejects.toThrow(
      /Permission denied/,
    )

    // The clean-up ran
    expect(calls.some((c) => c.argv.join(' ').includes('rm -f'))).toBe(true)
  })

  // The AI's code may pass a name it made up rather than a key from the
  // manifest — which is why the second check lives in this layer.
  test('an invalid env key THROWS', async () => {
    fakeSsh(() => OK)
    const ssh = createAppSsh('h')

    for (const key of ['TO KEN', 'TO=KEN', 'TO\nKEN', '1TOKEN', 'TOKEN;x', '']) {
      await expect(ssh.writeEnv('/opt/bot/.env', { [key]: 'x' })).rejects.toThrow()
    }
  })

  test('a file over the size limit is not written', async () => {
    fakeSsh((argv) => {
      if (argv.includes('cat')) {
        return { code: 0, stdout: 'X='.padEnd(ENV_SIZE_LIMIT + 100, 'a') + '\n', stderr: '' }
      }
      return OK
    })

    await expect(createAppSsh('h').writeEnv('/opt/bot/.env', { TOKEN: 'x' })).rejects.toThrow(
      /too large/i,
    )
  })
})

describe('ssh.readFile', () => {
  test('returns the text of an existing file', async () => {
    fakeSsh(() => ({ code: 0, stdout: 'hello', stderr: '' }))
    expect(await createAppSsh('h').readFile('/tmp/x')).toBe('hello')
  })

  test('returns `null` for a missing file — it does not throw', async () => {
    fakeSsh(() => ({ code: 1, stdout: '', stderr: 'No such file' }))
    // On first setup the file being absent is a NORMAL state.
    expect(await createAppSsh('h').readFile('/tmp/missing')).toBeNull()
  })

  test('shell metacharacters in the path are escaped', async () => {
    fakeSsh(() => OK)
    await createAppSsh('h').readFile('/tmp/x; rm -rf /')
    expect(calls[0]!.argv.join(' ')).toContain("'/tmp/x; rm -rf /'")
  })
})

describe('the server name is locked into the closure', () => {
  // The AI's code must not be able to hop to another server: the object is
  // built for one server and the name is never passed as an argument.
  test('every call goes to that same server', async () => {
    fakeSsh(() => OK)
    const ssh = createAppSsh('helsinki-1')

    await ssh.command(['uptime'])
    await ssh.readFile('/tmp/x')

    for (const c of calls) {
      expect(c.argv).toContain('helsinki-1')
    }
  })
})
