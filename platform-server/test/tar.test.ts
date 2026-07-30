// Tar o'quvchi — asosan ZIP-SLIP himoyasi sinaladi.
//
// Arxiv begona GitHub repo'sidan keladi, ya'ni ichidagi yo'llar dushmanona
// bo'lishi mumkin. `yolniTozala` yagona to'siq — u yiqilsa, arxiv nishon
// papkadan tashqariga yozib ketardi.

import { describe, expect, test } from 'bun:test'
import { tarOqi, yolniTozala } from '../src/tar.ts'

describe('yolniTozala — zip-slip himoyasi', () => {
  test('oddiy yo\'l o\'tadi', () => {
    expect(yolniTozala('a/b/c.txt')).toBe('a/b/c.txt')
  })

  test('`..` bo\'lagi RAD ETILADI', () => {
    expect(yolniTozala('../evil.txt')).toBeNull()
    expect(yolniTozala('a/../../evil.txt')).toBeNull()
    expect(yolniTozala('a/b/../../../etc/passwd')).toBeNull()
  })

  test('absolut yo\'l rad etiladi', () => {
    expect(yolniTozala('/etc/passwd')).toBeNull()
    expect(yolniTozala('/root/.ssh/authorized_keys')).toBeNull()
  })

  test('Windows disk prefiksi rad etiladi', () => {
    expect(yolniTozala('C:/Windows/system32')).toBeNull()
  })

  test('teskari chiziq ham ajratuvchi deb qaraladi', () => {
    // `..\..\x` ni oddiy fayl nomi deb o'tkazib yubormaslik kerak
    expect(yolniTozala('..\\..\\evil.txt')).toBeNull()
    expect(yolniTozala('a\\b\\c.txt')).toBe('a/b/c.txt')
  })

  test('NUL belgisi rad etiladi', () => {
    expect(yolniTozala('a/\0b')).toBeNull()
  })

  test('ortiqcha `.` va bo\'sh bo\'laklar tozalanadi', () => {
    expect(yolniTozala('./a//b/./c')).toBe('a/b/c')
  })

  test('bo\'sh yo\'l null', () => {
    expect(yolniTozala('')).toBeNull()
    expect(yolniTozala('.')).toBeNull()
    expect(yolniTozala('/')).toBeNull()
  })
})

// ---------------------------------------------------------------------------

/** Test uchun minimal tar arxivi quradi */
function tarQur(fayllar: { yol: string; mazmun: string; tur?: string }[]): Uint8Array {
  const bloklar: Uint8Array[] = []

  for (const f of fayllar) {
    const sarlavha = new Uint8Array(512)
    const kodlovchi = new TextEncoder()

    const nom = kodlovchi.encode(f.yol)
    sarlavha.set(nom.subarray(0, 100), 0)

    const mazmun = kodlovchi.encode(f.mazmun)
    // Hajm — 11 raqamli sakkizlik + NUL
    const hajm = mazmun.length.toString(8).padStart(11, '0')
    sarlavha.set(kodlovchi.encode(hajm), 124)
    sarlavha[135] = 0

    sarlavha[156] = (f.tur ?? '0').charCodeAt(0)

    bloklar.push(sarlavha)

    const toldirilgan = new Uint8Array(Math.ceil(mazmun.length / 512) * 512)
    toldirilgan.set(mazmun)
    bloklar.push(toldirilgan)
  }

  // Oxiri: ikkita bo'sh blok
  bloklar.push(new Uint8Array(1024))

  const jami = bloklar.reduce((s, b) => s + b.length, 0)
  const natija = new Uint8Array(jami)
  let ofset = 0
  for (const b of bloklar) {
    natija.set(b, ofset)
    ofset += b.length
  }
  return natija
}

describe('tarOqi', () => {
  test('oddiy fayllar o\'qiladi', () => {
    const arxiv = tarQur([
      { yol: 'repo/SKILL.md', mazmun: 'salom' },
      { yol: 'repo/scripts/x.sh', mazmun: 'echo hi' },
    ])

    const natija = tarOqi(arxiv, 1024 * 1024)
    expect(natija).toHaveLength(2)
    expect(natija[0]?.yol).toBe('repo/SKILL.md')
    expect(new TextDecoder().decode(natija[0]?.mazmun)).toBe('salom')
  })

  test('XAVFLI YO\'LLI yozuv jim tashlanadi, qolgani o\'qiladi', () => {
    const arxiv = tarQur([
      { yol: 'repo/yaxshi.txt', mazmun: 'ok' },
      { yol: '../../etc/passwd', mazmun: 'yovuz' },
      { yol: 'repo/yana-yaxshi.txt', mazmun: 'ok2' },
    ])

    const natija = tarOqi(arxiv, 1024 * 1024)
    expect(natija).toHaveLength(2)
    expect(natija.every((f) => !f.yol.includes('..'))).toBe(true)
    expect(natija.every((f) => !f.yol.startsWith('/'))).toBe(true)
  })

  test('papka yozuvlari tashlanadi', () => {
    const arxiv = tarQur([
      { yol: 'repo/papka/', mazmun: '', tur: '5' },
      { yol: 'repo/fayl.txt', mazmun: 'x' },
    ])
    expect(tarOqi(arxiv, 1024 * 1024)).toHaveLength(1)
  })

  test('symlink yozuvlari tashlanadi — chegaradan chiqish yo\'li bo\'lmasin', () => {
    const arxiv = tarQur([
      { yol: 'repo/link', mazmun: '/etc/passwd', tur: '2' },
      { yol: 'repo/fayl.txt', mazmun: 'x' },
    ])
    const natija = tarOqi(arxiv, 1024 * 1024)
    expect(natija).toHaveLength(1)
    expect(natija[0]?.yol).toBe('repo/fayl.txt')
  })

  test('hajm chegarasi oshsa xato — zip bomb himoyasi', () => {
    const arxiv = tarQur([{ yol: 'repo/katta.bin', mazmun: 'x'.repeat(5000) }])
    expect(() => tarOqi(arxiv, 1000)).toThrow(/too large/)
  })

  test('bo\'sh arxiv bo\'sh ro\'yxat', () => {
    expect(tarOqi(new Uint8Array(1024), 1024)).toEqual([])
  })
})
