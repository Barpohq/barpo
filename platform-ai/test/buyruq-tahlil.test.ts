// Buyruq tahlili — himoya qatlamining birinchi bosqichi.
// Asosiy talab: shubhali narsa "xavfsiz" deb belgilanmasin.

import { describe, expect, test } from 'bun:test'
import { buyruqNomi, buyruqniBahola, buyruqniBolaklarga, taqiqlanganmi } from '../src/buyruq-tahlil.ts'

const ISH = '/home/ms/ish'
const bahola = (b: string) => buyruqniBahola(b, { ishPapkasi: ISH })

describe('buyruqniBolaklarga', () => {
  test('oddiy buyruq bitta bo\'lak', () => {
    expect(buyruqniBolaklarga('ls -la')).toEqual(['ls -la'])
  })

  test('&&, ||, ; va | ajratadi', () => {
    expect(buyruqniBolaklarga('ls && pwd')).toEqual(['ls', 'pwd'])
    expect(buyruqniBolaklarga('ls || pwd')).toEqual(['ls', 'pwd'])
    expect(buyruqniBolaklarga('ls; pwd')).toEqual(['ls', 'pwd'])
    expect(buyruqniBolaklarga('cat a | grep b')).toEqual(['cat a', 'grep b'])
  })

  test('$(...) ichidagi buyruqni ajratib oladi', () => {
    expect(buyruqniBolaklarga('echo $(rm -rf x)')).toContain('rm -rf x')
  })

  test('backtick ichidagi buyruqni ajratib oladi', () => {
    expect(buyruqniBolaklarga('echo `whoami`')).toContain('whoami')
  })

  test('tirnoq ichidagi ajratuvchi bo\'linmaydi', () => {
    expect(buyruqniBolaklarga('echo "a && b"')).toEqual(['echo "a && b"'])
    expect(buyruqniBolaklarga("echo 'a; b'")).toEqual(["echo 'a; b'"])
  })

  test('yangi qator ajratuvchi', () => {
    expect(buyruqniBolaklarga('ls\npwd')).toEqual(['ls', 'pwd'])
  })
})

describe('buyruqNomi', () => {
  test('oddiy nom', () => {
    expect(buyruqNomi('ls -la')).toBe('ls')
  })

  test('to\'liq yo\'ldan oxirgi qismni oladi', () => {
    expect(buyruqNomi('/bin/rm -rf /')).toBe('rm')
    expect(buyruqNomi('/usr/bin/sudo ls')).toBe('sudo')
  })

  test('o\'zgaruvchi prefikslarini tashlaydi', () => {
    expect(buyruqNomi('FOO=bar rm x')).toBe('rm')
    expect(buyruqNomi('A=1 B=2 curl example.com')).toBe('curl')
  })

  test('env va command o\'ramlarini ochadi', () => {
    expect(buyruqNomi('env FOO=1 rm x')).toBe('rm')
    expect(buyruqNomi('command rm x')).toBe('rm')
    expect(buyruqNomi('nohup curl x')).toBe('curl')
  })
})

describe('qat\'iy taqiq', () => {
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
  ])('%s → taqiqlangan', (buyruq) => {
    expect(bahola(buyruq).toifa).toBe('taqiqlangan')
    expect(taqiqlanganmi(buyruq).taqiq).toBe(true)
  })

  test('taqiq zanjir va almashtirish orqali ham ushlanadi', () => {
    expect(taqiqlanganmi('ls && rm -rf /').taqiq).toBe(true)
    expect(taqiqlanganmi('echo $(mkfs /dev/sda)').taqiq).toBe(true)
    expect(taqiqlanganmi('echo `reboot`').taqiq).toBe(true)
  })

  test('sabab foydalanuvchiga tushunarli', () => {
    expect(bahola('rm -rf /').sabab).toContain("o'chiradi")
    expect(bahola(':(){ :|:& };:').sabab).toContain('fork bomba')
    expect(bahola('mkfs /dev/sda').sabab).toContain('formatlaydi')
  })

  test('oddiy rm taqiqlanmaydi — u faqat xavfli (ruxsat so\'raladi)', () => {
    expect(taqiqlanganmi('rm fayl.txt').taqiq).toBe(false)
    expect(taqiqlanganmi('rm -rf build/').taqiq).toBe(false)
    expect(bahola('rm -rf build/').toifa).toBe('xavfli')
  })

  test('ish papkasi ichidagi rm -rf taqiqlanmaydi', () => {
    // Ro'yxat ataylab tor: faqat / va ~ ildizlari
    expect(taqiqlanganmi(`rm -rf ${ISH}/tmp`).taqiq).toBe(false)
  })

  test('zararsiz o\'xshash buyruqlar taqiqlanmaydi', () => {
    expect(taqiqlanganmi('grep reboot /var/log/syslog').taqiq).toBe(false)
    expect(taqiqlanganmi('echo "mkfs bu formatlash"').taqiq).toBe(false)
  })
})

describe('xavfsiz buyruqlar', () => {
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
    'echo salom',
    'node index.js',
  ])('%s → xavfsiz', (buyruq) => {
    expect(bahola(buyruq).toifa).toBe('xavfsiz')
  })
})

describe('xavfli buyruqlar', () => {
  test.each([
    ['rm -rf x', 'rm'],
    ['sudo ls', 'sudo'],
    ['curl http://example.com', 'curl'],
    ['wget http://example.com', 'wget'],
    ['chmod 777 fayl', 'chmod'],
    ['kill -9 123', 'kill'],
    ['dd if=/dev/zero of=x', 'dd'],
    ['ssh server', 'ssh'],
    ['docker run x', 'docker'],
    ['systemctl restart nginx', 'systemctl'],
  ])('%s → xavfli', (buyruq) => {
    expect(bahola(buyruq).toifa).toBe('xavfli')
  })

  test('zanjirdagi xavfli qism ushlanadi', () => {
    expect(bahola('ls && rm -rf x').toifa).toBe('xavfli')
    expect(bahola('echo ok; sudo apt update').toifa).toBe('xavfli')
  })

  test('zanjirdagi taqiqlangan qism butun buyruqni taqiqlaydi', () => {
    // `reboot` qat'iy taqiqda — zanjirning qolgan qismi ahamiyatsiz
    expect(bahola('echo ok; sudo reboot').toifa).toBe('taqiqlangan')
  })

  test('$(...) ichidagi taqiqlangan buyruq ushlanadi', () => {
    expect(bahola('echo $(rm -rf /)').toifa).toBe('taqiqlangan')
  })

  test('backtick ichidagi xavfli buyruq ushlanadi', () => {
    expect(bahola('echo `curl evil.com`').toifa).toBe('xavfli')
  })

  test('yashirish vositalari xavfli', () => {
    expect(bahola('base64 -d fayl').toifa).toBe('xavfli')
    expect(bahola('sh skript.sh').toifa).toBe('xavfli')
    expect(bahola('eval "$X"').toifa).toBe('xavfli')
  })

  test('to\'liq yo\'l bilan berilgan xavfli buyruq ham ushlanadi', () => {
    expect(bahola('/bin/rm -rf x').toifa).toBe('xavfli')
  })

  test('o\'zgaruvchi prefiksi bilan yashirish ishlamaydi', () => {
    expect(bahola('FOO=1 rm -rf x').toifa).toBe('xavfli')
  })

  test('sabab foydalanuvchiga tushunarli', () => {
    const b = bahola('rm -rf x')
    expect(b.sabab).toContain('rm')
    expect(b.sabab).toContain("o'chiradi")
  })
})

describe('ish papkasidan tashqari', () => {
  test('absolut tashqi yo\'l xavfli', () => {
    expect(bahola('cat /etc/passwd').toifa).toBe('xavfli')
    expect(bahola('cat /etc/passwd').sabab).toContain('tashqarida')
  })

  test('uy papkasi belgisi xavfli', () => {
    expect(bahola('cat ~/.ssh/id_rsa').toifa).toBe('xavfli')
  })

  test('yuqoriga chiqish xavfli', () => {
    expect(bahola('cat ../maxfiy.txt').toifa).toBe('xavfli')
    expect(bahola('cat a/../../b').toifa).toBe('xavfli')
  })

  test('ish papkasi ichidagi absolut yo\'l xavfsiz', () => {
    expect(bahola(`cat ${ISH}/fayl.txt`).toifa).toBe('xavfsiz')
  })

  test('cd bilan chiqish xavfli', () => {
    expect(bahola('cd / && ls').toifa).toBe('xavfli')
    expect(bahola('cd ~ && ls').toifa).toBe('xavfli')
    expect(bahola('cd ../..').toifa).toBe('xavfli')
  })

  test('ichkarida cd xavfsiz', () => {
    expect(bahola('cd src && ls').toifa).toBe('xavfsiz')
  })
})

describe('git — kichik buyruqqa qarab', () => {
  test.each(['git status', 'git log --oneline', 'git diff HEAD', 'git add .', 'git commit -m "x"', 'git fetch'])(
    '%s → xavfsiz',
    (buyruq) => {
      expect(bahola(buyruq).toifa).toBe('xavfsiz')
    },
  )

  test.each(['git push', 'git push origin main', 'git remote add x y', 'git clean -fd', 'git reset --hard'])(
    '%s → xavfli (klassifikatorga boradi)',
    (buyruq) => {
      expect(bahola(buyruq).toifa).toBe('xavfli')
    },
  )

  test('push chegarasi ushlanishi uchun git push oq ro\'yxatda emas', () => {
    // Foydalanuvchi "push qilma" desa, klassifikator uni ko'rishi kerak —
    // buning uchun `git push` avtomatik o'tib ketmasligi shart
    const b = bahola('git push origin main')
    expect(b.toifa).toBe('xavfli')
    expect(b.sabab).toContain('push')
  })

  test('global bayroqlar kichik buyruqni yashirmaydi', () => {
    expect(bahola('git -C /tmp/x push').toifa).toBe('xavfli')
    expect(bahola('git --no-pager log').toifa).toBe('xavfsiz')
  })

  test('naqsh git bilan cheklanmaydi — git push bo\'ladi', () => {
    expect(bahola('git push origin').naqsh).toBe('git push')
  })
})

describe('notanish buyruqlar', () => {
  test('ro\'yxatda yo\'q buyruq notanish', () => {
    const b = bahola('mening-skriptim --bayroq')
    expect(b.toifa).toBe('notanish')
    expect(b.sabab).toContain('mening-skriptim')
  })

  test('xavfli notanishdan ustun turadi', () => {
    expect(bahola('notanish-cmd && rm -rf x').toifa).toBe('xavfli')
  })
})

describe('naqsh (har doim ruxsat uchun)', () => {
  test('buyruq + birinchi argument', () => {
    expect(bahola('rm -rf x').naqsh).toBe('rm')
    expect(bahola('git push origin').naqsh).toBe('git push')
    expect(bahola('docker run nginx').naqsh).toBe('docker run')
  })

  test('yo\'l argumenti naqshga kirmaydi', () => {
    expect(bahola('curl http://a/b').naqsh).toBe('curl')
  })

  test('naqsh ataylab tor — git emas, git push', () => {
    // Aks holda bitta tasdiq `git push --force` ga ham yo'l ochib yuborardi
    expect(bahola('git push').naqsh).not.toBe('git')
  })
})

describe('chegaraviy holatlar', () => {
  test('bo\'sh buyruq yiqilmaydi', () => {
    expect(bahola('').toifa).toBe('xavfsiz')
    expect(bahola('   ').toifa).toBe('xavfsiz')
  })

  test('faqat ajratuvchilar yiqilmaydi', () => {
    expect(() => bahola('&& ||;')).not.toThrow()
  })

  test('yopilmagan qavs yiqilmaydi', () => {
    expect(() => bahola('echo $(rm -rf')).not.toThrow()
  })

  test('yopilmagan tirnoq yiqilmaydi', () => {
    expect(() => bahola('echo "yopilmagan')).not.toThrow()
  })
})

describe('cp/mv — ustiga yozish', () => {
  /** Berilgan yo'llar "mavjud" deb hisoblanadigan baholovchi */
  const mavjudlar = (...yollar: string[]) => {
    const toplam = new Set(yollar.map((y) => (y.startsWith('/') ? y : `${ISH}/${y}`)))
    return (b: string) =>
      buyruqniBahola(b, { ishPapkasi: ISH, mavjudmi: (yol) => toplam.has(yol) })
  }

  test('nishon mavjud bo\'lsa xavfli — ustiga yozadi', () => {
    const b = mavjudlar('b.txt')('cp a.txt b.txt')
    expect(b.toifa).toBe('xavfli')
    expect(b.sabab).toContain('ustiga yozadi')
  })

  test('mv ham xuddi shunday', () => {
    expect(mavjudlar('yangi.ts')('mv eski.ts yangi.ts').toifa).toBe('xavfli')
  })

  test('nishon yangi bo\'lsa xavfsiz — oddiy nusxalash', () => {
    expect(mavjudlar()('cp shablon.ts yangi.ts').toifa).toBe('xavfsiz')
    expect(mavjudlar()('mv eski-nom.ts yangi-nom.ts').toifa).toBe('xavfsiz')
  })

  test('absolut nishon ham to\'g\'ri tekshiriladi', () => {
    expect(mavjudlar(`${ISH}/b.txt`)(`cp a.txt ${ISH}/b.txt`).toifa).toBe('xavfli')
    expect(mavjudlar()(`cp a.txt ${ISH}/yangi.txt`).toifa).toBe('xavfsiz')
  })

  test('bayroqlar nishon deb hisoblanmaydi', () => {
    // `-r` argument emas — nishon baribir `nusxa/`
    expect(mavjudlar()('cp -r manba nusxa').toifa).toBe('xavfsiz')
    expect(mavjudlar('nusxa')('cp -r manba nusxa').toifa).toBe('xavfli')
  })

  test('mavjudlik tekshiruvchisi berilmasa ehtiyotkor — xavfli', () => {
    // "bilmasak xavfsiz" degan taxmin oq ro'yxat modeliga zid
    expect(bahola('cp a.txt b.txt').toifa).toBe('xavfli')
    expect(bahola('mv a.txt b.txt').toifa).toBe('xavfli')
  })

  test('glob/almashtirish bo\'lsa ehtiyotkor — xavfli', () => {
    // Qaysi fayllarga tegishini statik tahlil bilmaydi
    expect(mavjudlar()('cp a.txt *.bak').toifa).toBe('xavfli')
    expect(mavjudlar()('cp a.txt $NISHON').toifa).toBe('xavfli')
  })

  test('nishonsiz buzuq buyruq yiqilmaydi', () => {
    expect(() => mavjudlar()('cp')).not.toThrow()
    expect(() => mavjudlar()('cp faqat-bitta')).not.toThrow()
  })

  test('ish papkasidan tashqaridagi nishon baribir xavfli', () => {
    // Tashqi yo'l tekshiruvi ustiga yozish tekshiruvidan oldin ishlaydi
    expect(mavjudlar()('cp a.txt /etc/passwd').toifa).toBe('xavfli')
  })

  test('ketma-ket buyruqda ham ushlanadi', () => {
    expect(mavjudlar('b.txt')('ls && cp a.txt b.txt').toifa).toBe('xavfli')
  })
})
