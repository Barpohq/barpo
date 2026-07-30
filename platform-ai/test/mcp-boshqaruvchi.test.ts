// McpBoshqaruvchi — ruxsat integratsiyasi va xato izolyatsiyasi.
//
// ENG MUHIM TEKSHIRUVLAR:
//   1) har tool chaqiruvi `RuxsatBoshqaruvchi.sora()` dan o'tadi;
//   2) "rad" javobi chaqiruvni BLOKLAYDI (server umuman chaqirilmaydi);
//   3) "har doim" ikkinchi chaqiruvda `sora()` ni umuman chaqirmaydi;
//   4) maxfiy argumentlar ruxsat so'rovida YASHIRILADI;
//   5) bir server yiqilsa qolganlari ishlaydi.

import { afterEach, describe, expect, test } from 'bun:test'
import { argumentlarniNishonga, McpBoshqaruvchi, mcpNaqshi } from '../src/mcp-boshqaruvchi.ts'
import { jarayonYaratuvchiniOrnat, type McpJarayon } from '../src/mcp-transport.ts'
import { RuxsatBoshqaruvchi } from '../src/ruxsat.ts'

afterEach(() => {
  jarayonYaratuvchiniOrnat(null)
})

// ---------------------------------------------------------------------------
// Soxta jarayon: buyruq nomiga qarab xulqi o'zgaradi
// ---------------------------------------------------------------------------

interface Chaqiruv {
  buyruq: string
  toolNomi: string
  argumentlar: unknown
}

/**
 * Jarayon yaratuvchini o'rnatadi.
 *
 * `yiqiladiganlar` ro'yxatidagi buyruq nomi bilan ishga tushirilgan jarayon
 * handshake'ga javob bermaydi — "server ishga tushmadi" holatini taqlid qiladi.
 */
function soxtaOrnat(yiqiladiganlar: string[] = []): Chaqiruv[] {
  const chaqiruvlar: Chaqiruv[] = []

  jarayonYaratuvchiniOrnat((argv) => {
    const buyruq = argv[0] ?? ''
    const yiqiladi = yiqiladiganlar.includes(buyruq)

    let chiqish: ((b: string) => void) | undefined
    const jarayon: McpJarayon = {
      yoz(matn) {
        for (const qator of matn.split('\n')) {
          if (!qator.trim()) continue
          const x = JSON.parse(qator) as {
            id?: number
            method?: string
            params?: { name?: string; arguments?: unknown }
          }
          if (yiqiladi) continue // javob bermaydi → timeout

          if (x.method === 'initialize') {
            javobYubor(chiqish, { jsonrpc: '2.0', id: x.id, result: {} })
            continue
          }
          if (x.method === 'notifications/initialized') continue
          if (x.method === 'tools/list') {
            javobYubor(chiqish, {
              jsonrpc: '2.0',
              id: x.id,
              result: {
                tools: [
                  { name: 'oqi', description: 'o\'qish', inputSchema: { type: 'object' } },
                  { name: 'ochir', description: 'o\'chirish', inputSchema: { type: 'object' } },
                ],
              },
            })
            continue
          }
          if (x.method === 'tools/call') {
            chaqiruvlar.push({
              buyruq,
              toolNomi: x.params?.name ?? '',
              argumentlar: x.params?.arguments,
            })
            javobYubor(chiqish, {
              jsonrpc: '2.0',
              id: x.id,
              result: { content: [{ type: 'text', text: `${buyruq}:${x.params?.name} bajarildi` }] },
            })
          }
        }
      },
      chiqishniTingla(fn) {
        chiqish = fn
      },
      xatoOqiminiTingla() {},
      toxtat() {},
      old() {},
      tugadi: Promise.resolve(0),
    }
    return jarayon
  })

  return chaqiruvlar
}

function javobYubor(chiqish: ((b: string) => void) | undefined, javob: unknown): void {
  queueMicrotask(() => chiqish?.(`${JSON.stringify(javob)}\n`))
}

function serverTarifi(id: string, nom: string, buyruq = nom) {
  return {
    id,
    nom,
    sozlama: {
      transport: 'stdio' as const,
      buyruq,
      handshakeTimeoutMs: 200,
      chaqiruvTimeoutMs: 200,
    },
  }
}

/** Ruxsat javoblarini oldindan belgilab beruvchi boshqaruvchi */
function ruxsatQur(javob: 'ruxsat' | 'rad' | 'hardoim'): {
  ruxsat: RuxsatBoshqaruvchi
  sorovlar: { tur: string; amal: string; nishon: string; naqsh: string }[]
} {
  const ruxsat = new RuxsatBoshqaruvchi('sessiya-1')
  const sorovlar: { tur: string; amal: string; nishon: string; naqsh: string }[] = []

  ruxsat.kuzat((sorov) => {
    sorovlar.push({
      tur: sorov.tur,
      amal: sorov.amal,
      nishon: sorov.nishon,
      naqsh: sorov.naqsh,
    })
    // Kuzatuvchi ichidan darhol javob beramiz (UI tugmasi bosilgani kabi)
    queueMicrotask(() => ruxsat.javobBer(sorov.id, javob))
  })

  return { ruxsat, sorovlar }
}

// ---------------------------------------------------------------------------

describe('ulash', () => {
  test('tool ro\'yxati server nomi bilan yig\'iladi', async () => {
    soxtaOrnat()
    const { ruxsat } = ruxsatQur('ruxsat')
    const b = new McpBoshqaruvchi('s1', ruxsat)

    await b.ulash([serverTarifi('id-1', 'github'), serverTarifi('id-2', 'slack')])

    expect(b.ulanganSoni).toBe(2)
    const royxat = b.royxat()
    expect(royxat).toHaveLength(4) // har serverda 2 tool
    expect(royxat.filter((r) => r.serverNomi === 'github').map((r) => r.tool.name)).toEqual([
      'oqi',
      'ochir',
    ])

    await b.yop()
  })

  test('bir server yiqilsa qolganlari ishlaydi', async () => {
    soxtaOrnat(['buzuq'])
    const { ruxsat } = ruxsatQur('ruxsat')
    const b = new McpBoshqaruvchi('s1', ruxsat)

    await b.ulash([serverTarifi('id-1', 'yaxshi'), serverTarifi('id-2', 'buzuq')])

    expect(b.ulanganSoni).toBe(1)
    expect(b.royxat().every((r) => r.serverNomi === 'yaxshi')).toBe(true)
    expect(b.ulanishXatolari.get('id-2')).toMatch(/did not respond/)

    await b.yop()
  })

  test('hamma server yiqilsa ham xato tashlanmaydi', async () => {
    soxtaOrnat(['a', 'b'])
    const { ruxsat } = ruxsatQur('ruxsat')
    const b = new McpBoshqaruvchi('s1', ruxsat)

    await b.ulash([serverTarifi('id-1', 'a'), serverTarifi('id-2', 'b')])

    expect(b.ulanganSoni).toBe(0)
    expect(b.royxat()).toEqual([])
    expect(b.ulanishXatolari.size).toBe(2)

    await b.yop()
  })

  test('bo\'sh ro\'yxat bilan ulash xavfsiz', async () => {
    soxtaOrnat()
    const { ruxsat } = ruxsatQur('ruxsat')
    const b = new McpBoshqaruvchi('s1', ruxsat)

    await b.ulash([])
    expect(b.royxat()).toEqual([])
    await b.yop()
  })
})

describe('ruxsat oqimi', () => {
  test('har chaqiruv sora() dan o\'tadi', async () => {
    const chaqiruvlar = soxtaOrnat()
    const { ruxsat, sorovlar } = ruxsatQur('ruxsat')
    const b = new McpBoshqaruvchi('s1', ruxsat)
    await b.ulash([serverTarifi('id-1', 'github')])

    await b.chaqir('id-1', 'oqi', { yol: 'a.txt' })

    expect(sorovlar).toHaveLength(1)
    expect(sorovlar[0]?.tur).toBe('mcp')
    expect(sorovlar[0]?.amal).toBe('github.oqi')
    expect(chaqiruvlar).toHaveLength(1)

    await b.yop()
  })

  test('RAD chaqiruvni bloklaydi — server umuman chaqirilmaydi', async () => {
    const chaqiruvlar = soxtaOrnat()
    const { ruxsat } = ruxsatQur('rad')
    const b = new McpBoshqaruvchi('s1', ruxsat)
    await b.ulash([serverTarifi('id-1', 'github')])

    await expect(b.chaqir('id-1', 'ochir', { yol: 'muhim.txt' })).rejects.toThrow(
      /Permission denied/,
    )
    // ENG MUHIM: server chaqirilmagan bo'lishi kerak
    expect(chaqiruvlar).toHaveLength(0)

    await b.yop()
  })

  test('HAR DOIM ikkinchi chaqiruvda sora() ni chaqirmaydi', async () => {
    const chaqiruvlar = soxtaOrnat()
    const { ruxsat, sorovlar } = ruxsatQur('hardoim')
    const b = new McpBoshqaruvchi('s1', ruxsat)
    await b.ulash([serverTarifi('id-1', 'github')])

    await b.chaqir('id-1', 'oqi', { yol: 'a' })
    await b.chaqir('id-1', 'oqi', { yol: 'b' })
    await b.chaqir('id-1', 'oqi', { yol: 'c' })

    // Faqat BIRINCHI chaqiruv so'rov chiqargan
    expect(sorovlar).toHaveLength(1)
    // Lekin uchalasi ham bajarilgan
    expect(chaqiruvlar).toHaveLength(3)

    await b.yop()
  })

  test('HAR DOIM boshqa tool\'ga o\'tmaydi (granularlik)', async () => {
    soxtaOrnat()
    const { ruxsat, sorovlar } = ruxsatQur('hardoim')
    const b = new McpBoshqaruvchi('s1', ruxsat)
    await b.ulash([serverTarifi('id-1', 'github')])

    await b.chaqir('id-1', 'oqi', {})
    await b.chaqir('id-1', 'ochir', {}) // BOSHQA tool — qayta so'ralishi kerak

    expect(sorovlar).toHaveLength(2)
    expect(sorovlar.map((s) => s.naqsh)).toEqual(['mcp:github.oqi', 'mcp:github.ochir'])

    await b.yop()
  })

  test('naqsh server va tool nomini o\'z ichiga oladi', async () => {
    soxtaOrnat()
    const { ruxsat, sorovlar } = ruxsatQur('ruxsat')
    const b = new McpBoshqaruvchi('s1', ruxsat)
    await b.ulash([serverTarifi('id-1', 'github'), serverTarifi('id-2', 'slack')])

    await b.chaqir('id-1', 'oqi', {})
    await b.chaqir('id-2', 'oqi', {}) // bir xil tool nomi, boshqa server

    expect(sorovlar.map((s) => s.naqsh)).toEqual(['mcp:github.oqi', 'mcp:slack.oqi'])

    await b.yop()
  })

  test('sabab matnida server va tool nomi bor', async () => {
    soxtaOrnat()
    const ruxsat = new RuxsatBoshqaruvchi('s1')
    const sabablar: string[] = []
    ruxsat.kuzat((sorov) => {
      sabablar.push(sorov.sabab)
      queueMicrotask(() => ruxsat.javobBer(sorov.id, 'ruxsat'))
    })

    const b = new McpBoshqaruvchi('s1', ruxsat)
    await b.ulash([serverTarifi('id-1', 'github')])
    await b.chaqir('id-1', 'oqi', {})

    expect(sabablar[0]).toContain('github')
    expect(sabablar[0]).toContain('oqi')

    await b.yop()
  })
})

describe('maxfiy argumentlar', () => {
  test('token ruxsat so\'rovida YASHIRILADI', async () => {
    soxtaOrnat()
    const { ruxsat, sorovlar } = ruxsatQur('ruxsat')
    const b = new McpBoshqaruvchi('s1', ruxsat)
    await b.ulash([serverTarifi('id-1', 'github')])

    await b.chaqir('id-1', 'oqi', { token: 'ghp_abcdefghij1234567890', yol: 'a.txt' })

    const nishon = sorovlar[0]?.nishon ?? ''
    expect(nishon).not.toContain('ghp_abcdefghij1234567890')
    expect(nishon).toContain('yashirildi')
    // Maxfiy bo'lmagan qism ko'rinib turishi kerak — foydalanuvchi nimaga
    // ruxsat berayotganini bilishi uchun
    expect(nishon).toContain('a.txt')

    await b.yop()
  })

  test('server SOF argumentni oladi — yashirish faqat ko\'rinishda', async () => {
    const chaqiruvlar = soxtaOrnat()
    const { ruxsat } = ruxsatQur('ruxsat')
    const b = new McpBoshqaruvchi('s1', ruxsat)
    await b.ulash([serverTarifi('id-1', 'github')])

    await b.chaqir('id-1', 'oqi', { token: 'ghp_abcdefghij1234567890' })

    // Yashirish faqat ruxsat so'rovi uchun — serverga haqiqiy qiymat borishi kerak
    expect(chaqiruvlar[0]?.argumentlar).toEqual({ token: 'ghp_abcdefghij1234567890' })

    await b.yop()
  })
})

describe('xato holatlari', () => {
  test('ulanmagan serverga chaqiruv sabab bilan xato beradi', async () => {
    soxtaOrnat(['buzuq'])
    const { ruxsat, sorovlar } = ruxsatQur('ruxsat')
    const b = new McpBoshqaruvchi('s1', ruxsat)
    await b.ulash([serverTarifi('id-1', 'buzuq')])

    await expect(b.chaqir('id-1', 'oqi', {})).rejects.toThrow(/not connected: buzuq/)
    // Ruxsat SO'RALMAYDI — bajarib bo'lmaydigan amal uchun so'rov chiqarish
    // foydalanuvchini chalg'itardi
    expect(sorovlar).toHaveLength(0)

    await b.yop()
  })

  test('noma\'lum serverId xato beradi', async () => {
    soxtaOrnat()
    const { ruxsat } = ruxsatQur('ruxsat')
    const b = new McpBoshqaruvchi('s1', ruxsat)
    await b.ulash([serverTarifi('id-1', 'github')])

    await expect(b.chaqir('yoq-bunday', 'oqi', {})).rejects.toThrow(/not found/)
    await b.yop()
  })

  test('yop() ikki marta chaqirilishi xavfsiz', async () => {
    soxtaOrnat()
    const { ruxsat } = ruxsatQur('ruxsat')
    const b = new McpBoshqaruvchi('s1', ruxsat)
    await b.ulash([serverTarifi('id-1', 'github')])

    await b.yop()
    await b.yop()
    expect(b.ulanganSoni).toBe(0)
  })

  test('yopilgandan keyin ulash hech narsa qilmaydi', async () => {
    soxtaOrnat()
    const { ruxsat } = ruxsatQur('ruxsat')
    const b = new McpBoshqaruvchi('s1', ruxsat)

    await b.yop()
    await b.ulash([serverTarifi('id-1', 'github')])
    expect(b.ulanganSoni).toBe(0)
  })
})

describe('argumentlarniNishonga', () => {
  test('oddiy argumentlar JSON bo\'lib chiqadi', () => {
    expect(argumentlarniNishonga({ a: 1, b: 'matn' })).toBe('{"a":1,"b":"matn"}')
  })

  test('bo\'sh/undefined argumentlar bo\'sh obyekt', () => {
    expect(argumentlarniNishonga(undefined)).toBe('{}')
    expect(argumentlarniNishonga(null)).toBe('{}')
  })

  test('maxfiy kalitlar yashiriladi', () => {
    const natija = argumentlarniNishonga({ api_key: 'juda-maxfiy-qiymat' })
    expect(natija).not.toContain('juda-maxfiy-qiymat')
    expect(natija).toContain('yashirildi')
  })

  test('uzun argumentlar qisqartiriladi', () => {
    const uzun = argumentlarniNishonga({ matn: 'a'.repeat(3000) })
    expect(uzun.length).toBeLessThanOrEqual(1001)
    expect(uzun.endsWith('…')).toBe(true)
  })

  test('aylanma havola xato tashlamaydi', () => {
    const aylanma: Record<string, unknown> = { a: 1 }
    aylanma.ozi = aylanma
    expect(() => argumentlarniNishonga(aylanma)).not.toThrow()
  })
})

describe('mcpNaqshi', () => {
  test('server va tool nomidan quriladi', () => {
    expect(mcpNaqshi('github', 'create_issue')).toBe('mcp:github.create_issue')
  })

  test('reverse-DNS nom ham ishlaydi', () => {
    expect(mcpNaqshi('io.github.owner/repo', 'qidir')).toBe('mcp:io.github.owner/repo.qidir')
  })
})
