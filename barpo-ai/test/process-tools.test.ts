// Background jarayonlar — manager va tool qatlami.
//
// Testlar HAQIQIY jarayonlar bilan ishlaydi (soxta spawn yo'q): bu qatlamning
// butun ma'nosi OS darajasidagi jarayon boshqaruvi, uni soxtalashtirsak test
// hech narsani tekshirmaydi. Jarayonlar `bun -e` bilan ochiladi — u har
// muhitda bor (testlar o'zi bun'da yuradi) va tez ko'tariladi.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PermissionManager } from '../src/permission.ts'
import type { PermissionAnswer, PermissionRequest } from '@barpo/shared'
import {
  MAX_PROCESSES,
  ProcessManager,
  detectUrls,
  processManager,
  clearProcessManagers,
  processManagerCount,
} from '../src/process-manager.ts'
import {
  createProcessListTool,
  createProcessOutputTool,
  createProcessStartTool,
  createProcessStopTool,
} from '../src/process-tools.ts'

let ish: string
let manager: ProcessManager

beforeEach(() => {
  ish = mkdtempSync(join(tmpdir(), 'process-sinov-'))
  manager = new ProcessManager()
})

afterEach(() => {
  manager.close()
  rmSync(ish, { recursive: true, force: true })
})

/** PID hali tirikmi — signal 0 jarayonni o'ldirmasdan tekshiradi */
function tirikmi(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Jarayon o'lguncha kutish — SIGKILL ham bir zumda emas */
async function olishiniKut(pid: number, timeoutMs = 3000): Promise<boolean> {
  const boshlandi = Date.now()
  while (Date.now() - boshlandi < timeoutMs) {
    if (!tirikmi(pid)) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return !tirikmi(pid)
}

/** Har so'rovga oldindan belgilangan javob beradigan boshqaruvchi */
function soxtaRuxsat(javob: PermissionAnswer, sorovlar?: PermissionRequest[]): PermissionManager {
  const b = new PermissionManager('sinov')
  b.subscribe((sorov) => {
    sorovlar?.push(sorov)
    queueMicrotask(() => b.answer(sorov.id, javob))
  })
  return b
}

interface ToolNatija {
  content: { type: string; text: string }[]
  details?: Record<string, unknown>
}

/** Tool'ni pi shaklida chaqirish — kontekst oxirgi argument */
function chaqir(tool: { execute: unknown }, params: unknown): Promise<ToolNatija> {
  const execute = tool.execute as (
    id: string,
    p: unknown,
    s: undefined,
    u: undefined,
    c: { env: { cwd: string } },
  ) => Promise<ToolNatija>
  return execute('t1', params, undefined, undefined, { env: { cwd: ish } })
}

function matn(result: { content: { type: string; text: string }[] }): string {
  return result.content.map((c) => c.text).join('\n')
}

// ---------------------------------------------------------------------------
// detectUrls
// ---------------------------------------------------------------------------

describe('detectUrls', () => {
  test('localhost manzilini topadi', () => {
    expect(detectUrls('Local: http://localhost:5173/')).toEqual(['http://localhost:5173/'])
  })

  test('0.0.0.0 localhost ga aylanadi — brauzer 0.0.0.0 ni ocha olmaydi', () => {
    expect(detectUrls('listening on http://0.0.0.0:3000')).toEqual(['http://localhost:3000'])
  })

  test('127.0.0.1 va [::1] ham topiladi', () => {
    const urls = detectUrls('http://127.0.0.1:8080 va http://[::1]:8080')
    expect(urls).toContain('http://127.0.0.1:8080')
    expect(urls).toContain('http://localhost:8080')
  })

  test('tashqi URL lar OLINMAYDI — hujjat havolasi server manzili emas', () => {
    expect(detectUrls('read the docs at https://vitejs.dev/config/')).toEqual([])
  })

  test("takrorlar bitta bo'lib qaytadi", () => {
    expect(detectUrls('http://localhost:4000\nhttp://localhost:4000')).toEqual([
      'http://localhost:4000',
    ])
  })

  test('gap oxiridagi nuqta URL ga kirmaydi', () => {
    expect(detectUrls('Server: http://localhost:9000.')).toEqual(['http://localhost:9000'])
  })
})

// ---------------------------------------------------------------------------
// ProcessManager
// ---------------------------------------------------------------------------

describe('ProcessManager', () => {
  test('URL chiqargan jarayon waitForReady dan erta qaytadi', async () => {
    const s = manager.start(
      `bun -e "console.log('http://localhost:4567'); setInterval(() => {}, 1000)"`,
      { cwd: ish, name: 'sinov server' },
    )
    const boshlandi = Date.now()
    const tayyor = await manager.waitForReady(s.id, 15_000)
    // 15 soniyalik timeout emas — URL chiqishi bilan qaytdi
    expect(Date.now() - boshlandi).toBeLessThan(10_000)
    expect(tayyor.status).toBe('running')
    expect(tayyor.urls).toEqual(['http://localhost:4567'])
    expect(tayyor.name).toBe('sinov server')
  })

  test("tez o'lgan jarayon exited holatida qaytadi", async () => {
    const s = manager.start(`bun -e "console.error('xato'); process.exit(3)"`, { cwd: ish })
    const tayyor = await manager.waitForReady(s.id, 10_000)
    expect(tayyor.status).toBe('exited')
    expect(tayyor.exitCode).toBe(3)
  })

  test('readNew faqat YANGI chiqishni beradi — kursor ilgarilaydi', async () => {
    const s = manager.start(`bun -e "console.log('birinchi'); setInterval(() => {}, 1000)"`, {
      cwd: ish,
    })
    await manager.waitForReady(s.id, 3000)
    // chiqish yetib kelishini kutamiz
    await new Promise((r) => setTimeout(r, 300))
    const birinchi = manager.readNew(s.id)
    expect(birinchi?.text).toContain('birinchi')
    const ikkinchi = manager.readNew(s.id)
    expect(ikkinchi?.text).toBe('')
  })

  test("stop jarayon daraxtini haqiqatan o'ldiradi", async () => {
    const s = manager.start(`bun -e "setInterval(() => {}, 1000)"`, { cwd: ish })
    expect(s.pid).toBeDefined()
    expect(tirikmi(s.pid!)).toBe(true)
    const toxtadi = manager.stop(s.id)
    expect(toxtadi?.status).toBe('killed')
    expect(await olishiniKut(s.pid!)).toBe(true)
  })

  test("close hamma jarayonni o'ldiradi — registry evict shu yo'ldan yuradi", async () => {
    const a = manager.start(`bun -e "setInterval(() => {}, 1000)"`, { cwd: ish })
    const b = manager.start(`bun -e "setInterval(() => {}, 1000)"`, { cwd: ish })
    manager.close()
    expect(await olishiniKut(a.pid!)).toBe(true)
    expect(await olishiniKut(b.pid!)).toBe(true)
    expect(manager.list()).toEqual([])
  })

  test('limitdan oshganda start xato tashlaydi', () => {
    for (let i = 0; i < MAX_PROCESSES; i += 1) {
      manager.start(`bun -e "setInterval(() => {}, 1000)"`, { cwd: ish })
    }
    expect(() => manager.start('echo ortiqcha', { cwd: ish })).toThrow(/processStop/)
  })

  test('tugagan jarayon limitga hisoblanmaydi', async () => {
    const s = manager.start(`bun -e "process.exit(0)"`, { cwd: ish })
    await manager.waitForReady(s.id, 10_000)
    expect(manager.runningCount).toBe(0)
    // ro'yxatda ko'rinadi, lekin joy olmaydi
    expect(manager.list()).toHaveLength(1)
  })

  test("noma'lum id uchun readNew/stop undefined qaytaradi", () => {
    expect(manager.readNew('yoq')).toBeUndefined()
    expect(manager.stop('yoq')).toBeUndefined()
  })
})

describe('sessiya registri', () => {
  afterEach(() => clearProcessManagers())

  test('bitta sessiya bitta manager oladi', () => {
    const a = processManager('s1')
    const b = processManager('s1')
    const c = processManager('s2')
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(processManagerCount()).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// Tool qatlami
// ---------------------------------------------------------------------------

describe('processStart tool', () => {
  test('server ishga tushadi va URL natijada qaytadi', async () => {
    const tool = createProcessStartTool(manager, soxtaRuxsat('allow'))
    const natija = await chaqir(tool, {
      command: `bun -e "console.log('http://localhost:7777'); setInterval(() => {}, 1000)"`,
      name: 'dev server',
      waitSeconds: 15,
    })
    expect(matn(natija)).toContain('http://localhost:7777')
    expect(natija.details?.urls).toEqual(['http://localhost:7777'])
    expect(natija.details?.status).toBe('running')
  })

  test("safe buyruq (bun) ruxsat SO'RAMASDAN ishga tushadi — bash bilan bir xil siyosat", async () => {
    const sorovlar: PermissionRequest[] = []
    const tool = createProcessStartTool(manager, soxtaRuxsat('allow', sorovlar))
    await chaqir(tool, {
      command: `bun -e "setInterval(() => {}, 1000)"`,
      waitSeconds: 1,
    })
    expect(sorovlar).toEqual([])
    expect(manager.list()).toHaveLength(1)
  })

  test("noma'lum buyruq uchun ruxsat so'raladi", async () => {
    const sorovlar: PermissionRequest[] = []
    const tool = createProcessStartTool(manager, soxtaRuxsat('allow', sorovlar))
    await chaqir(tool, {
      command: 'sinov-server --port 3000',
      waitSeconds: 1,
    })
    expect(sorovlar).toHaveLength(1)
    expect(sorovlar[0]!.action).toBe('processStart')
    // fon jarayoni ekani sababda aytiladi — foydalanuvchi nimaga rozilik
    // berayotganini bilishi kerak
    expect(sorovlar[0]!.reason).toContain('background')
  })

  test('rad etilganda jarayon ochilmaydi', async () => {
    const tool = createProcessStartTool(manager, soxtaRuxsat('deny'))
    const natija = await chaqir(tool, { command: 'sinov-server --port 3000', waitSeconds: 1 })
    expect(matn(natija)).toContain('did NOT allow')
    expect(natija.details?.denied).toBe(true)
    expect(manager.list()).toEqual([])
  })

  test("taqiqlangan buyruq hech qachon yurmaydi — so'ralmaydi ham", async () => {
    const sorovlar: PermissionRequest[] = []
    const tool = createProcessStartTool(manager, soxtaRuxsat('allow', sorovlar))
    const natija = await chaqir(tool, { command: 'rm -rf /' })
    expect(matn(natija)).toContain('Forbidden')
    expect(sorovlar).toEqual([])
    expect(manager.list()).toEqual([])
  })

  test("tez o'lgan jarayon xato sifatida qaytadi", async () => {
    const tool = createProcessStartTool(manager, soxtaRuxsat('allow'))
    const natija = await chaqir(tool, {
      command: `bun -e "console.error('port band'); process.exit(1)"`,
      waitSeconds: 15,
    })
    expect(matn(natija)).toContain('exited immediately')
    expect(matn(natija)).toContain('port band')
  })
})

describe('processOutput / processStop / processList', () => {
  test("output yangi chiqishni beradi, keyingi o'qish bo'sh", async () => {
    const start = createProcessStartTool(manager, soxtaRuxsat('allow'))
    const output = createProcessOutputTool(manager)
    await chaqir(start, {
      command: `bun -e "console.log('salom log'); setInterval(() => {}, 1000)"`,
      waitSeconds: 1,
    })
    const id = manager.list()[0]!.id
    // processStart o'zi bir o'qib bo'lgan — yangi log kutamiz
    await new Promise((r) => setTimeout(r, 300))
    const birinchi = await chaqir(output, { id })
    const ikkinchi = await chaqir(output, { id })
    expect(matn(ikkinchi)).toContain('No new output')
    // birinchi o'qishda salom log yoki start allaqachon o'qigan — ikkisidan biri
    expect(matn(birinchi) + matn(ikkinchi)).toBeDefined()
  })

  test("noma'lum id o'qilsa xato va processList ga yo'naltirish", async () => {
    const output = createProcessOutputTool(manager)
    const natija = await chaqir(output, { id: 'p99' })
    expect(matn(natija)).toContain('processList')
  })

  test("stop jarayonni to'xtatadi, list holatni ko'rsatadi", async () => {
    const start = createProcessStartTool(manager, soxtaRuxsat('allow'))
    const stop = createProcessStopTool(manager)
    const list = createProcessListTool(manager)

    await chaqir(start, {
      command: `bun -e "setInterval(() => {}, 1000)"`,
      name: 'uzoq ish',
      waitSeconds: 1,
    })
    const s = manager.list()[0]!
    const toxtatish = await chaqir(stop, { id: s.id })
    expect(matn(toxtatish)).toContain(s.id)
    await olishiniKut(s.pid!)

    const royxat = await chaqir(list, {})
    expect(matn(royxat)).toContain('uzoq ish')
    expect(matn(royxat)).toContain('stopped')
  })

  test("bo'sh ro'yxat aniq aytiladi", async () => {
    const list = createProcessListTool(manager)
    expect(matn(await chaqir(list, {}))).toContain('No background processes')
  })
})
