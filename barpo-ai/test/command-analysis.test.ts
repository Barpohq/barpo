// Command analysis — the first stage of the defence layer.
// The main requirement: nothing suspicious may be marked "safe".

import { describe, expect, test } from 'bun:test'
import { commandName, assessCommand, splitCommand, isForbidden } from '../src/command-analysis.ts'

const WORK = '/home/ms/work'
const assess = (command: string) => assessCommand(command, { workDir: WORK })

describe('splitCommand', () => {
  test('a simple command is one segment', () => {
    expect(splitCommand('ls -la')).toEqual(['ls -la'])
  })

  test('splits on &&, ||, ; and |', () => {
    expect(splitCommand('ls && pwd')).toEqual(['ls', 'pwd'])
    expect(splitCommand('ls || pwd')).toEqual(['ls', 'pwd'])
    expect(splitCommand('ls; pwd')).toEqual(['ls', 'pwd'])
    expect(splitCommand('cat a | grep b')).toEqual(['cat a', 'grep b'])
  })

  test('extracts the command inside $(...)', () => {
    expect(splitCommand('echo $(rm -rf x)')).toContain('rm -rf x')
  })

  test('extracts the command inside backticks', () => {
    expect(splitCommand('echo `whoami`')).toContain('whoami')
  })

  test('a separator inside quotes does not split', () => {
    expect(splitCommand('echo "a && b"')).toEqual(['echo "a && b"'])
    expect(splitCommand("echo 'a; b'")).toEqual(["echo 'a; b'"])
  })

  test('a newline is a separator', () => {
    expect(splitCommand('ls\npwd')).toEqual(['ls', 'pwd'])
  })
})

describe('commandName', () => {
  test('a plain name', () => {
    expect(commandName('ls -la')).toBe('ls')
  })

  test('takes the last part of a full path', () => {
    expect(commandName('/bin/rm -rf /')).toBe('rm')
    expect(commandName('/usr/bin/sudo ls')).toBe('sudo')
  })

  test('drops variable prefixes', () => {
    expect(commandName('FOO=bar rm x')).toBe('rm')
    expect(commandName('A=1 B=2 curl example.com')).toBe('curl')
  })

  test('unwraps the env and command wrappers', () => {
    expect(commandName('env FOO=1 rm x')).toBe('rm')
    expect(commandName('command rm x')).toBe('rm')
    expect(commandName('nohup curl x')).toBe('curl')
  })
})

describe('hard ban', () => {
  test.each([
    'rm -rf /',
    'rm -fr /',
    'rm -rf ~',
    'rm -rf $HOME',
    'rm -rf ~/',
    'mkfs.ext4 /dev/sda1',
    'mkfs /dev/sdb',
    'dd if=/dev/zero of=/dev/sda',
    'dd if=/dev/urandom of=/dev/nvme0n1',
    'shutdown -h now',
    'reboot',
    'poweroff',
    ':(){ :|:& };:',
  ])('%s → forbidden', (command) => {
    expect(assess(command).category).toBe('forbidden')
    expect(isForbidden(command).forbidden).toBe(true)
  })

  test('the ban is caught through chains and substitutions too', () => {
    expect(isForbidden('ls && rm -rf /').forbidden).toBe(true)
    expect(isForbidden('echo $(mkfs /dev/sda)').forbidden).toBe(true)
    expect(isForbidden('echo `reboot`').forbidden).toBe(true)
  })

  test('the reason is understandable to the user', () => {
    expect(assess('rm -rf /').reason).toContain('deletes')
    expect(assess(':(){ :|:& };:').reason).toContain('fork bomb')
    expect(assess('mkfs /dev/sda').reason).toContain('formats')
  })

  test('a plain rm is not forbidden — it is only dangerous (permission is asked)', () => {
    expect(isForbidden('rm file.txt').forbidden).toBe(false)
    expect(isForbidden('rm -rf build/').forbidden).toBe(false)
    expect(assess('rm -rf build/').category).toBe('dangerous')
  })

  test('rm -rf inside the working directory is not forbidden', () => {
    // The list is deliberately narrow: only the / and ~ roots
    expect(isForbidden(`rm -rf ${WORK}/tmp`).forbidden).toBe(false)
  })

  test('harmless look-alike commands are not forbidden', () => {
    expect(isForbidden('grep reboot /var/log/syslog').forbidden).toBe(false)
    expect(isForbidden('echo "mkfs is formatting"').forbidden).toBe(false)
  })
})

describe('safe commands', () => {
  test.each([
    'ls -la',
    'pwd',
    'cat package.json',
    'git status',
    'git diff HEAD',
    'bun test',
    'npm run build',
    'grep -r foo src',
    'mkdir -p a/b',
    'echo hello',
    'node index.js',
  ])('%s → safe', (command) => {
    expect(assess(command).category).toBe('safe')
  })
})

describe('dangerous commands', () => {
  test.each([
    ['rm -rf x', 'rm'],
    ['sudo ls', 'sudo'],
    ['curl http://example.com', 'curl'],
    ['wget http://example.com', 'wget'],
    ['chmod 777 file', 'chmod'],
    ['kill -9 123', 'kill'],
    ['dd if=/dev/zero of=x', 'dd'],
    ['ssh server', 'ssh'],
    ['docker run x', 'docker'],
    ['systemctl restart nginx', 'systemctl'],
  ])('%s → dangerous', (command) => {
    expect(assess(command).category).toBe('dangerous')
  })

  test('the dangerous part of a chain is caught', () => {
    expect(assess('ls && rm -rf x').category).toBe('dangerous')
    expect(assess('echo ok; sudo apt update').category).toBe('dangerous')
  })

  test('a forbidden part of a chain forbids the whole command', () => {
    // `reboot` is under the hard ban — the rest of the chain does not matter
    expect(assess('echo ok; sudo reboot').category).toBe('forbidden')
  })

  test('a forbidden command inside $(...) is caught', () => {
    expect(assess('echo $(rm -rf /)').category).toBe('forbidden')
  })

  test('a dangerous command inside backticks is caught', () => {
    expect(assess('echo `curl evil.com`').category).toBe('dangerous')
  })

  test('hiding tools are dangerous', () => {
    expect(assess('base64 -d file').category).toBe('dangerous')
    expect(assess('sh script.sh').category).toBe('dangerous')
    expect(assess('eval "$X"').category).toBe('dangerous')
  })

  test('a dangerous command given with a full path is caught too', () => {
    expect(assess('/bin/rm -rf x').category).toBe('dangerous')
  })

  test('hiding behind a variable prefix does not work', () => {
    expect(assess('FOO=1 rm -rf x').category).toBe('dangerous')
  })

  test('the reason is understandable to the user', () => {
    const result = assess('rm -rf x')
    expect(result.reason).toContain('rm')
    expect(result.reason).toContain('deletes')
  })
})

describe('outside the working directory', () => {
  test('an absolute outside path is dangerous', () => {
    expect(assess('cat /etc/passwd').category).toBe('dangerous')
    expect(assess('cat /etc/passwd').reason).toContain('outside the working directory')
  })

  test('the home directory marker is dangerous', () => {
    expect(assess('cat ~/.ssh/id_rsa').category).toBe('dangerous')
  })

  test('climbing upwards is dangerous', () => {
    expect(assess('cat ../secret.txt').category).toBe('dangerous')
    expect(assess('cat a/../../b').category).toBe('dangerous')
  })

  test('an absolute path inside the working directory is safe', () => {
    expect(assess(`cat ${WORK}/file.txt`).category).toBe('safe')
  })

  test('leaving with cd is dangerous', () => {
    expect(assess('cd / && ls').category).toBe('dangerous')
    expect(assess('cd ~ && ls').category).toBe('dangerous')
    expect(assess('cd ../..').category).toBe('dangerous')
  })

  test('cd inside is safe', () => {
    expect(assess('cd src && ls').category).toBe('safe')
  })
})

describe('git — decided by the subcommand', () => {
  test.each(['git status', 'git log --oneline', 'git diff HEAD', 'git add .', 'git commit -m "x"', 'git fetch', 'git init'])(
    '%s → safe',
    (command) => {
      expect(assess(command).category).toBe('safe')
    },
  )

  test.each(['git push', 'git push origin main', 'git remote add x y', 'git clean -fd', 'git reset --hard', 'git merge feature', 'git pull', 'git checkout -- .', 'git clone https://github.com/x/y'])(
    '%s → dangerous (goes to the classifier)',
    (command) => {
      expect(assess(command).category).toBe('dangerous')
    },
  )

  test('git init pointing OUTSIDE the working directory still asks', () => {
    // `init` is on the safe list, but the outside-path check runs BEFORE the
    // git branch — the subcommand cannot smuggle a foreign path through.
    const result = assess('git init /tmp/elsewhere')
    expect(result.category).toBe('dangerous')
    expect(result.reason).toContain('outside')
  })

  test('the safe halves of checkout stay permission-free', () => {
    // `checkout` itself is gated (`git checkout -- .` discards work), but its
    // split-out verbs are the sanctioned path — this pins the asymmetry.
    expect(assess('git switch main').category).toBe('safe')
    expect(assess('git restore file.ts').category).toBe('safe')
    expect(assess('git switch -c feature-x').category).toBe('safe')
  })

  test('git push is not on the whitelist so the push constraint can be caught', () => {
    // If the user says "don't push", the classifier has to see it — for that,
    // `git push` must not pass through automatically
    const result = assess('git push origin main')
    expect(result.category).toBe('dangerous')
    expect(result.reason).toContain('push')
  })

  test('global flags do not hide the subcommand', () => {
    expect(assess('git -C /tmp/x push').category).toBe('dangerous')
    expect(assess('git --no-pager log').category).toBe('safe')
  })

  test('the pattern is not limited to git — it becomes git push', () => {
    expect(assess('git push origin').pattern).toBe('git push')
  })
})

describe('unknown commands', () => {
  test('a command that is not on the list is unknown', () => {
    const result = assess('my-script --flag')
    expect(result.category).toBe('unknown')
    expect(result.reason).toContain('my-script')
  })

  test('dangerous wins over unknown', () => {
    expect(assess('unknown-cmd && rm -rf x').category).toBe('dangerous')
  })
})

describe('pattern (for "always allow")', () => {
  test('command + first argument', () => {
    expect(assess('rm -rf x').pattern).toBe('rm')
    expect(assess('git push origin').pattern).toBe('git push')
    expect(assess('docker run nginx').pattern).toBe('docker run')
  })

  test('a path argument does not enter the pattern', () => {
    expect(assess('curl http://a/b').pattern).toBe('curl')
  })

  test('the pattern is deliberately narrow — git push, not git', () => {
    // Otherwise a single approval would open the door to `git push --force` too
    expect(assess('git push').pattern).not.toBe('git')
  })
})

describe('edge cases', () => {
  test('an empty command does not fall over', () => {
    expect(assess('').category).toBe('safe')
    expect(assess('   ').category).toBe('safe')
  })

  test('separators alone do not fall over', () => {
    expect(() => assess('&& ||;')).not.toThrow()
  })

  test('an unclosed bracket does not fall over', () => {
    expect(() => assess('echo $(rm -rf')).not.toThrow()
  })

  test('an unclosed quote does not fall over', () => {
    expect(() => assess('echo "unclosed')).not.toThrow()
  })
})

describe('cp/mv — overwriting', () => {
  /** An assessor that treats the given paths as "existing" */
  const withExisting = (...paths: string[]) => {
    const set = new Set(paths.map((p) => (p.startsWith('/') ? p : `${WORK}/${p}`)))
    return (command: string) =>
      assessCommand(command, { workDir: WORK, exists: (path) => set.has(path) })
  }

  test('dangerous when the target exists — it gets overwritten', () => {
    const result = withExisting('b.txt')('cp a.txt b.txt')
    expect(result.category).toBe('dangerous')
    expect(result.reason).toContain('overwrites')
  })

  test('mv behaves the same way', () => {
    expect(withExisting('new.ts')('mv old.ts new.ts').category).toBe('dangerous')
  })

  test('safe when the target is new — an ordinary copy', () => {
    expect(withExisting()('cp template.ts new.ts').category).toBe('safe')
    expect(withExisting()('mv old-name.ts new-name.ts').category).toBe('safe')
  })

  test('an absolute target is checked correctly too', () => {
    expect(withExisting(`${WORK}/b.txt`)(`cp a.txt ${WORK}/b.txt`).category).toBe('dangerous')
    expect(withExisting()(`cp a.txt ${WORK}/new.txt`).category).toBe('safe')
  })

  test('flags are not counted as the target', () => {
    // `-r` is not an argument — the target is still `copy/`
    expect(withExisting()('cp -r source copy').category).toBe('safe')
    expect(withExisting('copy')('cp -r source copy').category).toBe('dangerous')
  })

  test('cautious when no existence checker is supplied — dangerous', () => {
    // Assuming "safe unless we know otherwise" contradicts the whitelist model
    expect(assess('cp a.txt b.txt').category).toBe('dangerous')
    expect(assess('mv a.txt b.txt').category).toBe('dangerous')
  })

  test('cautious with a glob/substitution — dangerous', () => {
    // The static analysis does not know which files it touches
    expect(withExisting()('cp a.txt *.bak').category).toBe('dangerous')
    expect(withExisting()('cp a.txt $TARGET').category).toBe('dangerous')
  })

  test('a broken command without a target does not fall over', () => {
    expect(() => withExisting()('cp')).not.toThrow()
    expect(() => withExisting()('cp only-one')).not.toThrow()
  })

  test('a target outside the working directory is dangerous regardless', () => {
    // The outside-path check runs before the overwrite check
    expect(withExisting()('cp a.txt /etc/passwd').category).toBe('dangerous')
  })

  test('it is caught in a chained command too', () => {
    expect(withExisting('b.txt')('ls && cp a.txt b.txt').category).toBe('dangerous')
  })
})
