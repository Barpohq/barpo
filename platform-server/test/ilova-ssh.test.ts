// Ilova boshqaruvi uchun SSH qatlami — injection himoyasining birinchi ikki
// qatlami shu yerda tekshiriladi.
//
// Bu testlarning maqsadi: foydalanuvchi kiritgan qiymat (bot tokeni) HECH
// QANDAY holatda serverdagi shellga buyruq bo'lib tushmasin va `ps` da
// ko'rinmasin.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  ENV_HAJM_CHEGARASI,
  envQatorlariniYangila,
  envQiymatiniQochir,
  ilovaSshYarat,
} from '../src/ilova-ssh.ts'
import { bajaruvchiOrnat, type BuyruqNatija } from '../src/ssh.ts'

let chaqiruvlar: { argv: string[]; stdin?: string }[]

function soxta(javob: (argv: string[]) => BuyruqNatija) {
  bajaruvchiOrnat(async (argv, imkoniyat) => {
    chaqiruvlar.push({ argv, stdin: imkoniyat?.stdin })
    return javob(argv)
  })
}

const OK: BuyruqNatija = { kod: 0, stdout: '', stderr: '' }

beforeEach(() => {
  chaqiruvlar = []
})

afterEach(() => {
  bajaruvchiOrnat(null)
})

describe('envQiymatiniQochir — shell hech narsani izohlamasin', () => {
  test('oddiy qiymat qo\'shtirnoqsiz qoladi (fayl o\'qishga qulay)', () => {
    expect(envQiymatiniQochir('7891234:AAHabc-def_x')).toBe('7891234:AAHabc-def_x')
    expect(envQiymatiniQochir('https://example.com/hook')).toBe('https://example.com/hook')
    expect(envQiymatiniQochir('')).toBe('')
  })

  // ENG MUHIM TEST. `.env` fayli `source` qilinsa, qochirilmagan `$(...)`
  // BUYRUQ bo'lib bajarilardi.
  test('buyruq bajarishga urinadigan qiymatlar zararsizlantiriladi', () => {
    const xavflilar = [
      '$(rm -rf /)',
      '`whoami`',
      '${HOME}',
      'x; rm -rf /',
      'x && curl evil.com',
      'x | sh',
      'x > /etc/passwd',
    ]

    for (const xom of xavflilar) {
      const natija = envQiymatiniQochir(xom)
      // Bir qavatli qo'shtirnoq ichida shell hech narsani izohlamaydi
      expect(natija.startsWith("'")).toBe(true)
      expect(natija.endsWith("'")).toBe(true)
    }
  })

  // Qo'shtirnoq qochirishning klassik teshigi: `'` qiymatni yopib, qolganini
  // shellga chiqarib yuborardi.
  test('qiymat ichidagi qo\'shtirnoq POSIX usulida qochiriladi', () => {
    expect(envQiymatiniQochir("x'y")).toBe("'x'\\''y'")
    // Qochirishdan chiqishga urinish
    expect(envQiymatiniQochir("'; rm -rf /; '")).toBe("''\\''; rm -rf /; '\\'''")
  })

  test('yangi qator olib tashlanadi — qiymat ikkinchi kalitga bo\'linmasin', () => {
    // Aks holda `TOKEN=x\nADMIN=1` ikki kalit bo'lib qolardi.
    expect(envQiymatiniQochir('x\nADMIN=1')).not.toContain('\n')
    expect(envQiymatiniQochir('x\r\ny')).not.toContain('\r')
  })
})

describe('envQatorlariniYangila — eski qiymat FAYLDA QOLMASIN', () => {
  test('mavjud kalit JOYIDA almashtiriladi', () => {
    const natija = envQatorlariniYangila('TOKEN=eski\nADMIN=1\n', { TOKEN: 'yangi' })

    expect(natija).toBe('TOKEN=yangi\nADMIN=1\n')
    // Eski qiymat qolmasligi — asosiy talab: ba'zi `.env` o'quvchilar
    // BIRINCHI qiymatni oladi, ya'ni bot eskisini ishlatishda davom etardi.
    expect(natija).not.toContain('eski')
  })

  test('yo\'q kalit oxiriga qo\'shiladi', () => {
    expect(envQatorlariniYangila('ADMIN=1\n', { TOKEN: 'yangi' })).toBe('ADMIN=1\nTOKEN=yangi\n')
  })

  test('bo\'sh fayldan boshlanadi', () => {
    expect(envQatorlariniYangila('', { TOKEN: 'x' })).toBe('TOKEN=x\n')
  })

  // Fayl odam o'qiydigan konfiguratsiya — izohni tozalab tashlash
  // foydalanuvchi ishini yo'qotardi.
  test('izohlar va tartib saqlanadi', () => {
    const mavjud = '# Bot sozlamalari\nTOKEN=eski\n\n# Admin\nADMIN=1\n'
    const natija = envQatorlariniYangila(mavjud, { TOKEN: 'yangi' })

    expect(natija).toContain('# Bot sozlamalari')
    expect(natija).toContain('# Admin')
    expect(natija.indexOf('TOKEN')).toBeLessThan(natija.indexOf('ADMIN'))
  })

  test('izoh ichidagi kalitga tegmaydi', () => {
    const natija = envQatorlariniYangila('#TOKEN=izohda\nTOKEN=haqiqiy\n', { TOKEN: 'yangi' })
    expect(natija).toContain('#TOKEN=izohda')
    expect(natija).toContain('TOKEN=yangi')
  })

  test('bir necha kalit birga yangilanadi', () => {
    const natija = envQatorlariniYangila('A=1\nB=2\n', { A: '10', C: '30' })
    expect(natija).toBe('A=10\nB=2\nC=30\n')
  })

  test('oxirgi qator yangi qator bilan tugaydi', () => {
    // POSIX vositalari (`source`, `read`) oxirgi qatorni tashlab ketishi mumkin.
    expect(envQatorlariniYangila('A=1', { B: '2' }).endsWith('\n')).toBe(true)
  })

  test('qiymat qochiriladi', () => {
    const natija = envQatorlariniYangila('', { TOKEN: '$(evil)' })
    expect(natija).toBe("TOKEN='$(evil)'\n")
  })
})

describe('ssh.buyruq — yiqilgan buyruq XATO bo\'lib chiqadi', () => {
  // ┌──────────────────────────────────────────────────────────────┐
  // │ ENG MUHIM TEST. AI kodi chiqish kodini TEKSHIRMAYDI:          │
  // │     await ssh('h').buyruq([...])                              │
  // │     return { xabar: 'Bot restart qilindi' }                    │
  // │ Natija qaytarsak, `ssh` yiqilganda ham foydalanuvchi           │
  // │ "restart qilindi" ko'rardi — JIMGINA yolg'on.                  │
  // └──────────────────────────────────────────────────────────────┘
  test('chiqish kodi ≠ 0 bo\'lsa XATO tashlanadi', async () => {
    soxta(() => ({ kod: 255, stdout: '', stderr: 'ssh: connect to host: No route to host' }))

    await expect(ilovaSshYarat('h').buyruq(['docker', 'restart', 'bot'])).rejects.toThrow(
      /No route to host/,
    )
  })

  test('xato matnida chiqish kodi ko\'rsatiladi', async () => {
    soxta(() => ({ kod: 127, stdout: '', stderr: '' }))
    await expect(ilovaSshYarat('h').buyruq(['yoq-buyruq'])).rejects.toThrow(/127/)
  })

  test('stderr bo\'sh bo\'lsa stdout dan sabab olinadi', async () => {
    soxta(() => ({ kod: 1, stdout: 'Error: container not found', stderr: '' }))
    await expect(ilovaSshYarat('h').buyruq(['docker', 'restart', 'x'])).rejects.toThrow(
      /container not found/,
    )
  })

  test('muvaffaqiyatli buyruq natijani qaytaradi', async () => {
    soxta(() => ({ kod: 0, stdout: 'tayyor', stderr: '' }))
    const n = await ilovaSshYarat('h').buyruq(['echo', 'x'])
    expect(n.stdout).toBe('tayyor')
  })

  // `docker inspect` yo'q konteyner uchun 1 qaytaradi — bu XATO emas, JAVOB.
  test('buyruqXom chiqish kodini xato deb hisoblamaydi', async () => {
    soxta(() => ({ kod: 1, stdout: '', stderr: 'not found' }))

    const n = await ilovaSshYarat('h').buyruqXom(['docker', 'inspect', 'x'])
    expect(n.kod).toBe(1)
    expect(n.stderr).toContain('not found')
  })
})

describe('ssh.buyruq — shell satri QABUL QILINMAYDI', () => {
  test('argv massivi bilan ishlaydi', async () => {
    soxta(() => OK)
    const ssh = ilovaSshYarat('helsinki-1')
    await ssh.buyruq(['docker', 'restart', 'bot'])

    expect(chaqiruvlar).toHaveLength(1)
    // Boshqariladigan config va BatchMode majburiy
    expect(chaqiruvlar[0]!.argv).toContain('-F')
    expect(chaqiruvlar[0]!.argv).toContain('helsinki-1')
  })

  // Bu himoyaning BIRINCHI qatlami: satr qabul qilsak AI shablon satri
  // yozardi va foydalanuvchi kirishi shellga tushardi.
  test('satr berilsa XATO tashlanadi', async () => {
    soxta(() => OK)
    const ssh = ilovaSshYarat('helsinki-1')

    // @ts-expect-error — ataylab noto'g'ri tip
    await expect(ssh.buyruq('docker restart bot')).rejects.toThrow(/array/i)
    expect(chaqiruvlar).toHaveLength(0)
  })

  test('bo\'sh argv XATO tashlaydi', async () => {
    soxta(() => OK)
    await expect(ilovaSshYarat('h').buyruq([])).rejects.toThrow()
  })

  test('obyekt argument XATO tashlaydi', async () => {
    soxta(() => OK)
    // @ts-expect-error — ataylab noto'g'ri tip
    await expect(ilovaSshYarat('h').buyruq(['echo', { a: 1 }])).rejects.toThrow(/string/i)
  })

  // Foydalanuvchi kiritgan konteyner nomi buyruqqa tushadi — u alohida
  // argument bo'lib qolishi kerak, buyruq bo'lib ketmasligi.
  test('argumentdagi shell belgilari zararsizlantiriladi', async () => {
    soxta(() => OK)
    const ssh = ilovaSshYarat('helsinki-1')
    await ssh.buyruq(['docker', 'restart', 'bot; rm -rf /'])

    const yuborilgan = chaqiruvlar[0]!.argv.join(' ')
    // `;` qochirilgan qo'shtirnoq ichida — shell uni ajratgich deb ko'rmaydi
    expect(yuborilgan).toContain("'bot; rm -rf /'")
  })
})

describe('ssh.envYoz — token `ps` da KO\'RINMASIN', () => {
  test('qiymat STDIN orqali boradi, argv da yo\'q', async () => {
    soxta(() => OK)
    const ssh = ilovaSshYarat('helsinki-1')

    await ssh.envYoz('/opt/bot/.env', { TOKEN: '7891234:SIRLI' })

    // Oxirgi chaqiruv — yozish
    const yozish = chaqiruvlar[chaqiruvlar.length - 1]!

    // ┌────────────────────────────────────────────────────────────┐
    // │ ASOSIY TEKSHIRUV: token argumentlarda BO'LMASLIGI kerak.   │
    // │ Aks holda u serverdagi `ps` chiqishida ko'rinardi.         │
    // └────────────────────────────────────────────────────────────┘
    expect(yozish.argv.join(' ')).not.toContain('SIRLI')
    expect(yozish.stdin).toContain('TOKEN=7891234:SIRLI')
  })

  test('mavjud fayl o\'qiladi va kalit almashtiriladi', async () => {
    soxta((argv) => {
      if (argv.includes('cat')) {
        return { kod: 0, stdout: 'TOKEN=eski\nADMIN=5\n', stderr: '' }
      }
      return OK
    })

    await ilovaSshYarat('h').envYoz('/opt/bot/.env', { TOKEN: 'yangi' })

    const yozish = chaqiruvlar[chaqiruvlar.length - 1]!
    expect(yozish.stdin).toBe('TOKEN=yangi\nADMIN=5\n')
  })

  test('fayl yo\'q bo\'lsa noldan yaratiladi (xato emas)', async () => {
    soxta((argv) => {
      if (argv.includes('cat')) {
        return { kod: 1, stdout: '', stderr: 'No such file' }
      }
      return OK
    })

    await ilovaSshYarat('h').envYoz('/opt/bot/.env', { TOKEN: 'x' })
    expect(chaqiruvlar[chaqiruvlar.length - 1]!.stdin).toBe('TOKEN=x\n')
  })

  // Yarim yozilgan `.env` bilan bot ko'tarilmasdi.
  test('atomik yozish: vaqtinchalik fayl + mv', async () => {
    soxta(() => OK)
    await ilovaSshYarat('h').envYoz('/opt/bot/.env', { TOKEN: 'x' })

    const buyruq = chaqiruvlar[chaqiruvlar.length - 1]!.argv.join(' ')
    expect(buyruq).toContain('platforma-yangi')
    expect(buyruq).toContain('mv -f')
    // Token faylda turadi — huquq cheklangan bo'lishi kerak
    expect(buyruq).toContain('umask 177')
  })

  test('yozish yiqilsa vaqtinchalik fayl o\'chiriladi va xato tashlanadi', async () => {
    soxta((argv) => {
      if (argv.some((a) => a.includes('mv -f'))) {
        return { kod: 1, stdout: '', stderr: 'Permission denied' }
      }
      return OK
    })

    await expect(ilovaSshYarat('h').envYoz('/opt/bot/.env', { TOKEN: 'x' })).rejects.toThrow(
      /Permission denied/,
    )

    // Tozalash chaqirilgan
    expect(chaqiruvlar.some((c) => c.argv.join(' ').includes('rm -f'))).toBe(true)
  })

  // AI kodi manifestdagi kalitlarni emas, o'zi yasagan nomni berishi mumkin —
  // shuning uchun ikkinchi tekshiruv shu qatlamda.
  test('yaroqsiz env kaliti XATO tashlaydi', async () => {
    soxta(() => OK)
    const ssh = ilovaSshYarat('h')

    for (const kalit of ['TO KEN', 'TO=KEN', 'TO\nKEN', '1TOKEN', 'TOKEN;x', '']) {
      await expect(ssh.envYoz('/opt/bot/.env', { [kalit]: 'x' })).rejects.toThrow()
    }
  })

  test('chegaradan katta fayl yozilmaydi', async () => {
    soxta((argv) => {
      if (argv.includes('cat')) {
        return { kod: 0, stdout: 'X='.padEnd(ENV_HAJM_CHEGARASI + 100, 'a') + '\n', stderr: '' }
      }
      return OK
    })

    await expect(ilovaSshYarat('h').envYoz('/opt/bot/.env', { TOKEN: 'x' })).rejects.toThrow(
      /too large/i,
    )
  })
})

describe('ssh.faylOqi', () => {
  test('mavjud fayl matnini qaytaradi', async () => {
    soxta(() => ({ kod: 0, stdout: 'salom', stderr: '' }))
    expect(await ilovaSshYarat('h').faylOqi('/tmp/x')).toBe('salom')
  })

  test('fayl yo\'q bo\'lsa `null` — xato tashlamaydi', async () => {
    soxta(() => ({ kod: 1, stdout: '', stderr: 'No such file' }))
    // Birinchi sozlashda fayl yo'qligi NORMAL holat.
    expect(await ilovaSshYarat('h').faylOqi('/tmp/yoq')).toBeNull()
  })

  test('yo\'ldagi shell belgilari qochiriladi', async () => {
    soxta(() => OK)
    await ilovaSshYarat('h').faylOqi('/tmp/x; rm -rf /')
    expect(chaqiruvlar[0]!.argv.join(' ')).toContain("'/tmp/x; rm -rf /'")
  })
})

describe('server nomi closure da qulflangan', () => {
  // AI kodi boshqa serverga o'tib keta olmasligi kerak: obyekt bitta
  // server uchun yasaladi va nom argument bo'lib berilmaydi.
  test('har chaqiruv o\'sha serverga boradi', async () => {
    soxta(() => OK)
    const ssh = ilovaSshYarat('helsinki-1')

    await ssh.buyruq(['uptime'])
    await ssh.faylOqi('/tmp/x')

    for (const c of chaqiruvlar) {
      expect(c.argv).toContain('helsinki-1')
    }
  })
})
