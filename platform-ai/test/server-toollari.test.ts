// `serverList` tool'ining xulqi: formatlash, manba inversiyasi, shartli
// e'lon qilinishi va promptga mosligi.
//
// Bu tool'da fayl tizimi ham, SSH ham yo'q — u faqat chaqiruvchi bergan
// funksiyaga tayanadi. Shu sababli testlar soxta manba bilan ishlaydi va
// hech qanday tashqi holatga bog'lanmaydi.

import { describe, expect, test } from 'bun:test'
import { AGENT_SISTEM_PROMPT } from '../src/agent.ts'
import {
  SERVER_PROMPT_QISMI,
  serverListToolYarat,
  serverlarniMatnga,
  serverToollari,
  serverToollariXom,
  type ServerYozuvi,
} from '../src/server-toollari.ts'

const web: ServerYozuvi = { name: 'web-1', host: '10.0.0.5', port: 22, username: 'root' }
const db: ServerYozuvi = { name: 'db-main', host: 'db.misol.uz', port: 2222, username: 'deploy' }

/** Tool'ni `agent.ts` chaqiradigan shaklda ishga tushiradi */
async function toolniChaqir(
  tool: ReturnType<typeof serverListToolYarat>,
): Promise<{ matn: string; soni: number | undefined }> {
  const natija = await tool.execute(
    'id-1',
    {},
    undefined,
    undefined,
    { env: { cwd: '/istalgan/joy' } },
  )
  const matn = natija.content.map((b) => ('text' in b ? b.text : '')).join('')
  return { matn, soni: natija.details?.soni }
}

describe('serverlarniMatnga', () => {
  test('ustunlar va qiymatlar chiqadi', () => {
    const matn = serverlarniMatnga([web, db])
    expect(matn).toContain('NOM')
    expect(matn).toContain('HOST')
    expect(matn).toContain('PORT')
    expect(matn).toContain('USER')
    expect(matn).toContain('web-1')
    expect(matn).toContain('10.0.0.5')
    expect(matn).toContain('db.misol.uz')
    expect(matn).toContain('deploy')
  })

  test('standart bo\'lmagan port ham ko\'rinadi', () => {
    // Agent `ssh -p` kerakligini bilishi uchun port har doim chiqadi
    expect(serverlarniMatnga([db])).toContain('2222')
  })

  test('har server alohida qatorda', () => {
    const qatorlar = serverlarniMatnga([web, db]).split('\n')
    expect(qatorlar.filter((q) => q.startsWith('web-1'))).toHaveLength(1)
    expect(qatorlar.filter((q) => q.startsWith('db-main'))).toHaveLength(1)
  })

  test('bo\'sh ro\'yxat — xato emas, tushuntirish', () => {
    const matn = serverlarniMatnga([])
    expect(matn).toContain('No servers are connected')
    // Agent foydalanuvchiga nima qilish kerakligini ayta olsin
    expect(matn).toContain('Serverlar')
  })

  test('ssh ishlatish yo\'riqnomasi ro\'yxat bilan birga keladi', () => {
    // Nomni olgan agent u bilan nima qilishni ham bilsin
    expect(serverlarniMatnga([web])).toContain('ssh')
  })
})

describe('serverList tool', () => {
  test('manbadagi serverlarni qaytaradi', async () => {
    const { matn, soni } = await toolniChaqir(serverListToolYarat(() => [web, db]))
    expect(matn).toContain('web-1')
    expect(matn).toContain('db-main')
    expect(soni).toBe(2)
  })

  test('asinxron manba ham qo\'llanadi', async () => {
    const { matn, soni } = await toolniChaqir(
      serverListToolYarat(async () => [web]),
    )
    expect(matn).toContain('web-1')
    expect(soni).toBe(1)
  })

  test('manba HAR CHAQIRUVDA qayta o\'qiladi', async () => {
    // Foydalanuvchi suhbat davomida server qo'shishi mumkin — agent
    // eskirgan ro'yxatga qarab qolmasin
    let royxat: ServerYozuvi[] = [web]
    const tool = serverListToolYarat(() => royxat)

    const birinchi = await toolniChaqir(tool)
    expect(birinchi.soni).toBe(1)

    royxat = [web, db]
    const ikkinchi = await toolniChaqir(tool)
    expect(ikkinchi.soni).toBe(2)
    expect(ikkinchi.matn).toContain('db-main')
  })

  test('bo\'sh manba bilan ham xato tashlamaydi', async () => {
    const { matn, soni } = await toolniChaqir(serverListToolYarat(() => []))
    expect(soni).toBe(0)
    expect(matn).toContain('No servers are connected')
  })

  test('parametrsiz chaqiriladi — sxema bo\'sh obyekt', () => {
    const tool = serverListToolYarat(() => [])
    expect(tool.name).toBe('serverList')
    expect(tool.parameters).toBeDefined()
  })
})

describe('shartli e\'lon qilinish', () => {
  test('manba berilmasa tool UMUMAN yo\'q', () => {
    // "Bor, lekin har doim bo'sh" dan yaxshiroq: model yo'q imkoniyatni
    // qayta-qayta urinmaydi
    expect(serverToollariXom(undefined)).toHaveLength(0)
    expect(serverToollari(undefined)).toHaveLength(0)
  })

  test('manba berilsa bitta tool e\'lon qilinadi', () => {
    const toollar = serverToollariXom(() => [web])
    expect(toollar).toHaveLength(1)
    expect(toollar[0]!.name).toBe('serverList')
  })

  test('kontekst biriktirilgan shakl ham ishlaydi', async () => {
    const toollar = serverToollari(() => [web])
    expect(toollar).toHaveLength(1)
    const natija = await (toollar[0]! as unknown as {
      execute: (id: string, p: unknown) => Promise<{ content: { text?: string }[] }>
    }).execute('id-1', {})
    expect(natija.content.map((b) => b.text ?? '').join('')).toContain('web-1')
  })
})

describe('prompt bilan moslik', () => {
  test('serverlarBor=true bo\'lsa tool prompt ro\'yxatida bor', () => {
    const prompt = AGENT_SISTEM_PROMPT('/ish', undefined, undefined, undefined, true)
    expect(prompt).toContain('serverList')
    // Ko'rsatma ham tushsin — faqat nom yetarli emas
    expect(prompt).toContain('NEVER guess a server name')
  })

  test('serverlarBor=false bo\'lsa prompt uni umuman tilga olmaydi', () => {
    // Tool yo'q bo'lsa u haqda yozish modelni yo'q imkoniyatga undardi
    const prompt = AGENT_SISTEM_PROMPT('/ish', undefined, undefined, undefined, false)
    expect(prompt).not.toContain('serverList')
  })

  test('standart holat — bayroqsiz chaqiruvda tool tilga olinmaydi', () => {
    expect(AGENT_SISTEM_PROMPT('/ish')).not.toContain('serverList')
  })

  test('prompt qismidagi tool nomi haqiqiy tool nomiga teng', () => {
    // Ikkisi bir faylda tursa ham, nom o'zgarsa test buni ushlaydi
    const nom = serverToollariXom(() => [])[0]?.name ?? 'serverList'
    expect(SERVER_PROMPT_QISMI.royxat.join(' ')).toContain(nom)
  })
})
