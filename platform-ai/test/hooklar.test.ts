// Hook tizimi testlari.
//
// Majburlanadigan xulqlar:
//   1) `oldin` da BIRINCHI bloklagan g'olib — keyingi hook uni bekor qila
//      olmaydi (aks holda hook tartibi xavfsizlikka ta'sir qilardi);
//   2) `oldin` hook xatosi TOOLNI BLOKLAYDI (fail-closed) — maxfiy
//      ma'lumotni yashiradigan hook ishlamasa, filtrsiz o'tkazish xavfliroq;
//   3) `keyin` hook xatosi natijani yo'qotmaydi, lekin jimgina o'tmaydi.

import { describe, expect, test } from 'bun:test'
import {
  keyinZanjiri,
  kuzatuvHooki,
  maxfiyniYashirHooki,
  oldinZanjiri,
  qoshimchaTaqiqHooki,
  uzunlikHooki,
  type ToolHooki,
} from '../src/hooklar.ts'

const kontekst = {
  nom: 'bash',
  args: { command: 'ls' },
  ishPapkasi: '/ish',
  sessionId: 's1',
}

const natijaKonteksti = { ...kontekst, natija: 'chiqish', xatomi: false }

describe('oldin zanjiri', () => {
  test('hech kim bloklamasa undefined', async () => {
    const hooklar: ToolHooki[] = [{ nom: 'a' }, { nom: 'b', oldin: () => undefined }]
    expect(await oldinZanjiri(hooklar, kontekst)).toBeUndefined()
  })

  test('bloklagan hook toolni to\'xtatadi', async () => {
    const hooklar: ToolHooki[] = [{ nom: 'a', oldin: () => ({ blokla: true, sabab: 'yaramaydi' }) }]
    const n = await oldinZanjiri(hooklar, kontekst)
    expect(n?.blokla).toBe(true)
    expect(n?.sabab).toBe('yaramaydi')
  })

  test('BIRINCHI bloklagan g\'olib — keyingilari chaqirilmaydi', async () => {
    // Keyingi hook bloklashni bekor qila olmasligi kerak
    let ikkinchiChaqirildi = false
    const hooklar: ToolHooki[] = [
      { nom: 'a', oldin: () => ({ blokla: true, sabab: 'birinchi' }) },
      {
        nom: 'b',
        oldin: () => {
          ikkinchiChaqirildi = true
          return undefined
        },
      },
    ]
    const n = await oldinZanjiri(hooklar, kontekst)
    expect(n?.sabab).toBe('birinchi')
    expect(ikkinchiChaqirildi).toBe(false)
  })

  test('hook XATOSI toolni BLOKLAYDI (fail-closed)', async () => {
    const hooklar: ToolHooki[] = [
      {
        nom: 'buzuq',
        oldin: () => {
          throw new Error('ishlamadi')
        },
      },
    ]
    const n = await oldinZanjiri(hooklar, kontekst)
    expect(n?.blokla).toBe(true)
    expect(n?.sabab).toContain('buzuq')
  })

  test('async hook qo\'llab-quvvatlanadi', async () => {
    const hooklar: ToolHooki[] = [
      { nom: 'a', oldin: async () => ({ blokla: true, sabab: 'async blok' }) },
    ]
    expect((await oldinZanjiri(hooklar, kontekst))?.sabab).toBe('async blok')
  })

  test('sabab berilmasa hook nomi ishlatiladi', async () => {
    const hooklar: ToolHooki[] = [{ nom: 'nomsiz', oldin: () => ({ blokla: true }) }]
    expect((await oldinZanjiri(hooklar, kontekst))?.sabab).toContain('nomsiz')
  })
})

describe('keyin zanjiri', () => {
  test('hech kim o\'zgartirmasa natija o\'zgarmaydi', async () => {
    const n = await keyinZanjiri([{ nom: 'a' }], natijaKonteksti)
    expect(n.natija).toBe('chiqish')
    expect(n.xatomi).toBe(false)
  })

  test('hook natijani almashtiradi', async () => {
    const hooklar: ToolHooki[] = [{ nom: 'a', keyin: () => ({ natija: 'yangi' }) }]
    expect((await keyinZanjiri(hooklar, natijaKonteksti)).natija).toBe('yangi')
  })

  test('hook\'lar ZANJIR bo\'lib ishlaydi — keyingisi oldingisining natijasini ko\'radi', async () => {
    const hooklar: ToolHooki[] = [
      { nom: 'a', keyin: ({ natija }) => ({ natija: `${natija}-1` }) },
      { nom: 'b', keyin: ({ natija }) => ({ natija: `${natija}-2` }) },
    ]
    expect((await keyinZanjiri(hooklar, natijaKonteksti)).natija).toBe('chiqish-1-2')
  })

  test('hook xatosi natijani yo\'qotmaydi, lekin ko\'rinadi', async () => {
    const hooklar: ToolHooki[] = [
      {
        nom: 'buzuq',
        keyin: () => {
          throw new Error('yiqildi')
        },
      },
    ]
    const n = await keyinZanjiri(hooklar, natijaKonteksti)
    expect(n.natija).toContain('chiqish')
    expect(n.natija).toContain('buzuq')
  })

  test('xato bayrog\'ini o\'zgartirish mumkin', async () => {
    const hooklar: ToolHooki[] = [{ nom: 'a', keyin: () => ({ xatomi: true }) }]
    expect((await keyinZanjiri(hooklar, natijaKonteksti)).xatomi).toBe(true)
  })
})

describe('maxfiyni yashirish', () => {
  const hook = maxfiyniYashirHooki()

  async function yashir(natija: string): Promise<string> {
    return (await keyinZanjiri([hook], { ...natijaKonteksti, natija })).natija
  }

  test('env shaklidagi kalitlar yashiriladi', async () => {
    const n = await yashir('OPENAI_API_KEY=sk-abcdefghijklmnopqrst\nPORT=3000')
    expect(n).not.toContain('sk-abcdefghijklmnopqrst')
    expect(n).toContain('OPENAI_API_KEY')
    // Maxfiy bo'lmagan qiymat qoladi
    expect(n).toContain('PORT=3000')
  })

  test('JSON shaklidagi kalitlar yashiriladi', async () => {
    const n = await yashir('{"api_key": "juda-maxfiy-qiymat", "port": 3000}')
    expect(n).not.toContain('juda-maxfiy-qiymat')
    expect(n).toContain('port')
  })

  test('tanilgan kalit shakllari nomidan qat\'i nazar yashiriladi', async () => {
    const n = await yashir('token bu: ghp_abcdefghijklmnopqrstuvwxyz12')
    expect(n).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz12')
  })

  test('maxfiy narsa bo\'lmasa natija tegilmaydi', async () => {
    const matn = 'oddiy chiqish, hech qanday sir yo\'q'
    expect(await yashir(matn)).toBe(matn)
  })
})

describe('uzunlik hooki', () => {
  test('uzun natija kesiladi va bu aytiladi', async () => {
    const uzun = 'x'.repeat(5000)
    const n = await keyinZanjiri([uzunlikHooki(100)], { ...natijaKonteksti, natija: uzun })
    expect(n.natija.length).toBeLessThan(200)
    expect(n.natija).toContain('qisqartirildi')
  })

  test('qisqa natija tegilmaydi', async () => {
    const n = await keyinZanjiri([uzunlikHooki(100)], natijaKonteksti)
    expect(n.natija).toBe('chiqish')
  })
})

describe('qo\'shimcha taqiq', () => {
  test('taqiqlangan buyruq bloklanadi', async () => {
    const hook = qoshimchaTaqiqHooki(['docker'])
    const n = await oldinZanjiri([hook], { ...kontekst, args: { command: 'docker ps' } })
    expect(n?.blokla).toBe(true)
    expect(n?.sabab).toContain('docker')
  })

  test('to\'liq yo\'l bilan yashirish ushlanadi', async () => {
    const hook = qoshimchaTaqiqHooki(['docker'])
    const n = await oldinZanjiri([hook], { ...kontekst, args: { command: '/usr/bin/docker ps' } })
    expect(n?.blokla).toBe(true)
  })

  test('zanjir ichida yashirilgan buyruq ushlanadi', async () => {
    const hook = qoshimchaTaqiqHooki(['docker'])
    const n = await oldinZanjiri([hook], { ...kontekst, args: { command: 'ls && docker ps' } })
    expect(n?.blokla).toBe(true)
  })

  test('taqiqlanmagan buyruq o\'tadi', async () => {
    const hook = qoshimchaTaqiqHooki(['docker'])
    expect(await oldinZanjiri([hook], { ...kontekst, args: { command: 'ls -la' } })).toBeUndefined()
  })

  test('bo\'sh taqiq ro\'yxati hech narsani bloklamaydi', async () => {
    const hook = qoshimchaTaqiqHooki([])
    expect(await oldinZanjiri([hook], kontekst)).toBeUndefined()
  })

  test('bash bo\'lmagan tool tegilmaydi', async () => {
    const hook = qoshimchaTaqiqHooki(['docker'])
    const n = await oldinZanjiri([hook], { nom: 'read', args: { path: 'docker' }, ishPapkasi: '/i', sessionId: 's' })
    expect(n).toBeUndefined()
  })
})

describe('kuzatuv hooki', () => {
  test('chaqiriladi va bloklamaydi', async () => {
    const korilgan: string[] = []
    const hook = kuzatuvHooki((k) => korilgan.push(k.nom))
    expect(await oldinZanjiri([hook], kontekst)).toBeUndefined()
    expect(korilgan).toEqual(['bash'])
  })

  test('kuzatuvchi xatosi toolni bloklamaydi', async () => {
    // Audit yozish yiqilgani tool bajarilishini to'xtatmasligi kerak
    const hook = kuzatuvHooki(() => {
      throw new Error('audit yiqildi')
    })
    expect(await oldinZanjiri([hook], kontekst)).toBeUndefined()
  })
})
