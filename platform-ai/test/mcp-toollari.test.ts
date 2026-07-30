// MCP tool'larini agentga e'lon qilish.
//
// ASOSIY TEKSHIRUVLAR:
//   1) boshqaruvchi berilmasa tool UMUMAN e'lon qilinmaydi (agent MCP
//      borligini bilmaydi);
//   2) ikki server bir xil tool nomini bersa nomlar TO'QNASHMAYDI;
//   3) JSON Schema konvertatsiyasiz o'tadi;
//   4) chaqiruv ruxsat qatlamidan o'tadi (o'ram uni chetlab o'tmaydi).

import { afterEach, describe, expect, test } from 'bun:test'
import { AGENT_SISTEM_PROMPT } from '../src/agent.ts'
import { McpBoshqaruvchi } from '../src/mcp-boshqaruvchi.ts'
import {
  MCP_PROMPT_QISMI,
  MCP_TOOL_PREFIKSI,
  mcpTooliMi,
  mcpToollari,
  mcpToollariXom,
  mcpToolNomi,
  xavfsizToolNomi,
} from '../src/mcp-toollari.ts'
import { jarayonYaratuvchiniOrnat, type McpJarayon } from '../src/mcp-transport.ts'
import { RuxsatBoshqaruvchi } from '../src/ruxsat.ts'

afterEach(() => {
  jarayonYaratuvchiniOrnat(null)
})

/** Har chaqirilgan tool nomini yozib boradigan soxta jarayon */
function soxtaOrnat(toolNomlari: string[]): { chaqirilgan: string[] } {
  const chaqirilgan: string[] = []

  jarayonYaratuvchiniOrnat(() => {
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
          const javob = (natija: unknown) =>
            queueMicrotask(() =>
              chiqish?.(`${JSON.stringify({ jsonrpc: '2.0', id: x.id, result: natija })}\n`),
            )

          if (x.method === 'initialize') javob({})
          else if (x.method === 'tools/list') {
            javob({
              tools: toolNomlari.map((nom) => ({
                name: nom,
                description: `${nom} tavsifi`,
                inputSchema: { type: 'object', properties: { soz: { type: 'string' } } },
              })),
            })
          } else if (x.method === 'tools/call') {
            chaqirilgan.push(x.params?.name ?? '')
            javob({ content: [{ type: 'text', text: `${x.params?.name} bajarildi` }] })
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

  return { chaqirilgan }
}

function serverTarifi(id: string, nom: string) {
  return {
    id,
    nom,
    sozlama: {
      transport: 'stdio' as const,
      buyruq: 'soxta',
      handshakeTimeoutMs: 200,
      chaqiruvTimeoutMs: 200,
    },
  }
}

/** Hamma so'rovga darhol ruxsat beruvchi boshqaruvchi */
function ruxsatQur(javob: 'ruxsat' | 'rad' = 'ruxsat'): RuxsatBoshqaruvchi {
  const ruxsat = new RuxsatBoshqaruvchi('sessiya-1')
  ruxsat.kuzat((sorov) => {
    queueMicrotask(() => ruxsat.javobBer(sorov.id, javob))
  })
  return ruxsat
}

async function boshqaruvchiQur(
  serverlar: { id: string; nom: string }[],
  javob: 'ruxsat' | 'rad' = 'ruxsat',
): Promise<McpBoshqaruvchi> {
  const b = new McpBoshqaruvchi('s1', ruxsatQur(javob))
  await b.ulash(serverlar.map((s) => serverTarifi(s.id, s.nom)))
  return b
}

// ---------------------------------------------------------------------------

describe('boshqaruvchi berilmaganda', () => {
  test('xom ro\'yxat bo\'sh', () => {
    expect(mcpToollariXom(undefined)).toEqual([])
    expect(mcpToollari(undefined)).toEqual([])
  })

  test('server ulanmagan boshqaruvchi ham bo\'sh ro\'yxat beradi', async () => {
    soxtaOrnat(['echo'])
    const b = new McpBoshqaruvchi('s1', ruxsatQur())
    // Ulash CHAQIRILMADI
    expect(mcpToollariXom(b)).toEqual([])
  })
})

describe('tool e\'lon qilish', () => {
  test('nom prefikslanadi', async () => {
    soxtaOrnat(['echo', 'qidir'])
    const b = await boshqaruvchiQur([{ id: 'id-1', nom: 'github' }])

    const toollar = mcpToollariXom(b)
    expect(toollar.map((t) => t.name)).toEqual(['mcp__github__echo', 'mcp__github__qidir'])
    // `label` ham bir xil — UI kartasida shu ko'rinadi
    expect(toollar[0]?.label).toBe('mcp__github__echo')

    await b.yop()
  })

  test('tavsifda server nomi ko\'rinadi', async () => {
    soxtaOrnat(['echo'])
    const b = await boshqaruvchiQur([{ id: 'id-1', nom: 'github' }])

    expect(mcpToollariXom(b)[0]?.description).toBe('[MCP: github] echo tavsifi')
    await b.yop()
  })

  test('JSON Schema KONVERTATSIYASIZ o\'tadi', async () => {
    soxtaOrnat(['echo'])
    const b = await boshqaruvchiQur([{ id: 'id-1', nom: 'github' }])

    // Server bergan sxema aynan shu holda `parameters` bo'lishi kerak
    expect(mcpToollariXom(b)[0]?.parameters).toEqual({
      type: 'object',
      properties: { soz: { type: 'string' } },
    })

    await b.yop()
  })

  test('IKKI SERVER bir xil tool nomi — nomlar to\'qnashmaydi', async () => {
    soxtaOrnat(['search'])
    const b = await boshqaruvchiQur([
      { id: 'id-1', nom: 'github' },
      { id: 'id-2', nom: 'slack' },
    ])

    const nomlar = mcpToollariXom(b).map((t) => t.name)
    expect(nomlar).toHaveLength(2)
    expect(new Set(nomlar).size).toBe(2)
    expect(nomlar.sort()).toEqual(['mcp__github__search', 'mcp__slack__search'])

    await b.yop()
  })
})

describe('chaqiruv', () => {
  test('tool bajarilib natija qaytadi', async () => {
    const { chaqirilgan } = soxtaOrnat(['echo'])
    const b = await boshqaruvchiQur([{ id: 'id-1', nom: 'github' }])

    const tool = mcpToollari(b)[0]!
    const natija = (await tool.execute('c1', { soz: 'salom' } as never, undefined, undefined as never)) as {
      content: { text: string }[]
      details?: { serverNomi: string; toolNomi: string }
    }

    // MUHIM: serverga PREFIKSSIZ asl nom borishi kerak
    expect(chaqirilgan).toEqual(['echo'])
    expect(natija.content[0]?.text).toBe('echo bajarildi')
    expect(natija.details).toEqual({ serverNomi: 'github', toolNomi: 'echo' })

    await b.yop()
  })

  test('RUXSAT RAD ETILSA o\'ram ham bloklanadi', async () => {
    const { chaqirilgan } = soxtaOrnat(['echo'])
    const b = await boshqaruvchiQur([{ id: 'id-1', nom: 'github' }], 'rad')

    const tool = mcpToollari(b)[0]!
    await expect(
      tool.execute('c1', {} as never, undefined, undefined as never),
    ).rejects.toThrow(/Ruxsat berilmadi/)

    // Tool o'rami ruxsatni CHETLAB O'TMAYDI
    expect(chaqirilgan).toEqual([])
    await b.yop()
  })

  test('isError natija agentga xato bo\'lib boradi', async () => {
    jarayonYaratuvchiniOrnat(() => {
      let chiqish: ((b: string) => void) | undefined
      return {
        yoz(matn) {
          for (const qator of matn.split('\n')) {
            if (!qator.trim()) continue
            const x = JSON.parse(qator) as { id?: number; method?: string }
            const javob = (natija: unknown) =>
              queueMicrotask(() =>
                chiqish?.(`${JSON.stringify({ jsonrpc: '2.0', id: x.id, result: natija })}\n`),
              )
            if (x.method === 'initialize') javob({})
            else if (x.method === 'tools/list') javob({ tools: [{ name: 'echo' }] })
            else if (x.method === 'tools/call') {
              javob({ content: [{ type: 'text', text: 'ruxsat yetmadi' }], isError: true })
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
    })

    const b = await boshqaruvchiQur([{ id: 'id-1', nom: 'github' }])
    const tool = mcpToollari(b)[0]!
    const natija = (await tool.execute('c1', {} as never, undefined, undefined as never)) as {
      content: { text: string }[]
      isError?: boolean
    }

    expect(natija.isError).toBe(true)
    expect(natija.content[0]?.text).toBe('ruxsat yetmadi')
    await b.yop()
  })
})

describe('nom yordamchilari', () => {
  test('xavfsizToolNomi reverse-DNS nomni tozalaydi', () => {
    expect(xavfsizToolNomi('io.github.owner/repo')).toBe('io_github_owner_repo')
    expect(xavfsizToolNomi('oddiy-nom_2')).toBe('oddiy-nom_2')
    expect(xavfsizToolNomi('!!!')).toBe('___')
    expect(xavfsizToolNomi('')).toBe('nomalum')
  })

  test('mcpToolNomi prefiks va ajratuvchi qo\'yadi', () => {
    expect(mcpToolNomi('github', 'create_issue')).toBe('mcp__github__create_issue')
    expect(mcpToolNomi('io.example/srv', 'qidir')).toBe('mcp__io_example_srv__qidir')
  })

  test('mcpTooliMi prefiks bo\'yicha ajratadi', () => {
    expect(mcpTooliMi('mcp__github__echo')).toBe(true)
    expect(mcpTooliMi('bash')).toBe(false)
    expect(mcpTooliMi('serverList')).toBe(false)
    expect(MCP_TOOL_PREFIKSI).toBe('mcp__')
  })
})

describe('prompt', () => {
  test('MCP yo\'q bo\'lsa prompt uni TILGA OLMAYDI', () => {
    const prompt = AGENT_SISTEM_PROMPT('/ish', undefined, undefined, undefined, false, false, false)
    expect(prompt).not.toContain('mcp__')
    expect(prompt).not.toContain('MCP')
  })

  test('MCP bor bo\'lsa qism qo\'shiladi', () => {
    const prompt = AGENT_SISTEM_PROMPT('/ish', undefined, undefined, undefined, false, false, true)
    expect(prompt).toContain('mcp__<server>__<tool>')
    expect(prompt).toContain('MCP TOOLS')
    // Tashqi ta'sir haqida ogohlantirish bo'lishi kerak
    expect(prompt).toContain('EXTERNAL systems')
  })

  test('prompt qismi ikki bo\'lakdan iborat', () => {
    expect(MCP_PROMPT_QISMI.royxat.length).toBeGreaterThan(0)
    expect(MCP_PROMPT_QISMI.qoida.length).toBeGreaterThan(0)
  })
})
