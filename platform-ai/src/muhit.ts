// Chegaralangan bajarilish muhiti — tool'larni ish papkasiga qulflaydi.
//
// pi-agent-core ning `NodeExecutionEnv` da HECH QANDAY chegara yo'q: sinovda
// u /etc/passwd ni o'qidi va `cd /` qila oldi. Bu pi uchun to'g'ri qaror
// (u ishonchli lokal CLI), lekin platformada LLM o'qigan matn ishonchsiz —
// prompt injection orqali "endi ~/.ssh ni o'qi" deyilishi mumkin.
//
// Shuning uchun bu o'ram har fayl amalidan oldin yo'lni tekshiradi:
//   ish papkasi ichida  → o'tadi
//   tashqarida          → foydalanuvchidan ruxsat so'raladi
//   rad etilsa          → FileError("permission_denied")
//
// Symlink orqali chiqib ketishga qarshi `canonicalPath` ishlatiladi: fayl
// mavjud bo'lsa uning HAQIQIY joyi tekshiriladi, ish papkasi ichidagi
// symlink /etc ga qarab tursa ham ushlanadi.
//
// CHEKLOV: bu himoya qatlami, sandbox emas. `bash` orqali bajarilgan buyruq
// bizning tekshiruvimizdan o'tgach operatsion tizim darajasida cheklanmaydi.
// Haqiqiy izolyatsiya uchun ExecutionEnv ni Docker ustida qayta yozish kerak —
// interfeys shu uchun to'liq delegatsiya qilinadi.

import {
  ExecutionError,
  FileError,
  NodeExecutionEnv,
  type ExecutionEnv,
  type FileInfo,
  type Result,
  type ShellExecOptions,
} from '@earendil-works/pi-agent-core/node'
import { buyruqniBahola } from './buyruq-tahlil.ts'
import type { RuxsatBoshqaruvchi } from './ruxsat.ts'

/** Yo'l tekshiruvidan o'tmagan amal uchun xato */
function radXatosi(yol: string, sabab: string): FileError {
  return new FileError('permission_denied', `Ruxsat berilmadi: ${sabab}`, yol)
}

export interface ChegaralanganMuhitSozlamalari {
  /** Tool'lar ishlaydigan papka — undan tashqari hamma narsa so'raladi */
  ishPapkasi: string
  ruxsat: RuxsatBoshqaruvchi
  /** Test uchun ichki muhitni almashtirish */
  ichki?: ExecutionEnv
}

export class ChegaralanganMuhit implements ExecutionEnv {
  readonly cwd: string
  private ichki: ExecutionEnv
  private ruxsat: RuxsatBoshqaruvchi
  /** Shu oqimda allaqachon ruxsat berilgan yo'llar — qayta so'ralmaydi */
  private ruxsatEtilgan = new Set<string>()

  constructor(sozlama: ChegaralanganMuhitSozlamalari) {
    this.cwd = sozlama.ishPapkasi
    this.ichki = sozlama.ichki ?? new NodeExecutionEnv({ cwd: sozlama.ishPapkasi })
    this.ruxsat = sozlama.ruxsat
  }

  // -------------------------------------------------------------------------
  // Chegara tekshiruvi
  // -------------------------------------------------------------------------

  /** Yo'l ish papkasi ichidami — matn darajasida (mavjud bo'lmagan fayllar uchun) */
  private ichkarimi(absolutYol: string): boolean {
    return absolutYol === this.cwd || absolutYol.startsWith(`${this.cwd}/`)
  }

  /**
   * Yo'lni tekshiradi. Ichkarida bo'lsa darhol o'tadi, aks holda ruxsat
   * so'raydi. `amal` — qaysi tool so'rayapti (UI'da ko'rsatiladi).
   */
  private async yolniTekshir(yol: string, amal: string): Promise<Result<string, FileError>> {
    const absolut = await this.ichki.absolutePath(yol)
    if (!absolut.ok) return absolut

    let tekshiriladigan = absolut.value

    // Symlink orqali chiqib ketishni ushlaymiz: fayl mavjud bo'lsa haqiqiy
    // joyini olamiz. Mavjud bo'lmasa (yangi fayl) matn yo'li yetarli —
    // uning ota-papkasi baribir ichkarida bo'lishi kerak.
    const kanonik = await this.ichki.canonicalPath(absolut.value)
    if (kanonik.ok) tekshiriladigan = kanonik.value

    if (this.ichkarimi(tekshiriladigan)) return { ok: true, value: absolut.value }

    // Shu oqimda allaqachon ruxsat berilganmi
    if (this.ruxsatEtilgan.has(tekshiriladigan)) return { ok: true, value: absolut.value }

    const javob = await this.ruxsat.sora({
      tur: 'fayl',
      amal,
      nishon: tekshiriladigan,
      sabab: "ish papkasidan tashqaridagi fayl",
      naqsh: `${amal}:${tekshiriladigan}`,
    })

    if (javob === 'rad') {
      return { ok: false, error: radXatosi(tekshiriladigan, 'ish papkasidan tashqarida') }
    }
    this.ruxsatEtilgan.add(tekshiriladigan)
    return { ok: true, value: absolut.value }
  }

  // -------------------------------------------------------------------------
  // FileSystem — o'qish
  // -------------------------------------------------------------------------

  async absolutePath(path: string, abortSignal?: AbortSignal): Promise<Result<string, FileError>> {
    // Yo'lni hal qilish o'zi xavfsiz — tekshiruv haqiqiy amalda bo'ladi
    return this.ichki.absolutePath(path, abortSignal)
  }

  async joinPath(parts: string[], abortSignal?: AbortSignal): Promise<Result<string, FileError>> {
    return this.ichki.joinPath(parts, abortSignal)
  }

  async readTextFile(path: string, abortSignal?: AbortSignal): Promise<Result<string, FileError>> {
    const tekshirilgan = await this.yolniTekshir(path, 'read')
    if (!tekshirilgan.ok) return tekshirilgan
    return this.ichki.readTextFile(tekshirilgan.value, abortSignal)
  }

  async readTextLines(
    path: string,
    options?: { maxLines?: number; abortSignal?: AbortSignal },
  ): Promise<Result<string[], FileError>> {
    const tekshirilgan = await this.yolniTekshir(path, 'read')
    if (!tekshirilgan.ok) return tekshirilgan
    return this.ichki.readTextLines(tekshirilgan.value, options)
  }

  async readBinaryFile(path: string, abortSignal?: AbortSignal): Promise<Result<Uint8Array, FileError>> {
    const tekshirilgan = await this.yolniTekshir(path, 'read')
    if (!tekshirilgan.ok) return tekshirilgan
    return this.ichki.readBinaryFile(tekshirilgan.value, abortSignal)
  }

  async fileInfo(path: string, abortSignal?: AbortSignal): Promise<Result<FileInfo, FileError>> {
    const tekshirilgan = await this.yolniTekshir(path, 'read')
    if (!tekshirilgan.ok) return tekshirilgan
    return this.ichki.fileInfo(tekshirilgan.value, abortSignal)
  }

  async listDir(path: string, abortSignal?: AbortSignal): Promise<Result<FileInfo[], FileError>> {
    const tekshirilgan = await this.yolniTekshir(path, 'read')
    if (!tekshirilgan.ok) return tekshirilgan
    return this.ichki.listDir(tekshirilgan.value, abortSignal)
  }

  async canonicalPath(path: string, abortSignal?: AbortSignal): Promise<Result<string, FileError>> {
    return this.ichki.canonicalPath(path, abortSignal)
  }

  async exists(path: string, abortSignal?: AbortSignal): Promise<Result<boolean, FileError>> {
    // `exists` — eng zararsiz amal, lekin u bilan fayl tizimini "paypaslash"
    // mumkin. Tashqaridagi yo'l uchun ruxsat so'ramaymiz, shunchaki `false`
    // qaytaramiz: agent tashqarida nima borligini bilmasin.
    const absolut = await this.ichki.absolutePath(path, abortSignal)
    if (!absolut.ok) return absolut
    const kanonik = await this.ichki.canonicalPath(absolut.value, abortSignal)
    const tekshiriladigan = kanonik.ok ? kanonik.value : absolut.value
    if (!this.ichkarimi(tekshiriladigan) && !this.ruxsatEtilgan.has(tekshiriladigan)) {
      return { ok: true, value: false }
    }
    return this.ichki.exists(absolut.value, abortSignal)
  }

  // -------------------------------------------------------------------------
  // FileSystem — yozish
  // -------------------------------------------------------------------------

  async writeFile(
    path: string,
    content: string | Uint8Array,
    abortSignal?: AbortSignal,
  ): Promise<Result<void, FileError>> {
    const tekshirilgan = await this.yolniTekshir(path, 'write')
    if (!tekshirilgan.ok) return tekshirilgan
    return this.ichki.writeFile(tekshirilgan.value, content, abortSignal)
  }

  async appendFile(
    path: string,
    content: string | Uint8Array,
    abortSignal?: AbortSignal,
  ): Promise<Result<void, FileError>> {
    const tekshirilgan = await this.yolniTekshir(path, 'write')
    if (!tekshirilgan.ok) return tekshirilgan
    return this.ichki.appendFile(tekshirilgan.value, content, abortSignal)
  }

  async createDir(
    path: string,
    options?: { recursive?: boolean; abortSignal?: AbortSignal },
  ): Promise<Result<void, FileError>> {
    const tekshirilgan = await this.yolniTekshir(path, 'write')
    if (!tekshirilgan.ok) return tekshirilgan
    return this.ichki.createDir(tekshirilgan.value, options)
  }

  async remove(
    path: string,
    options?: { recursive?: boolean; force?: boolean; abortSignal?: AbortSignal },
  ): Promise<Result<void, FileError>> {
    // O'chirish — ish papkasi ichida ham har doim so'raladi. Tool'lar orasida
    // `remove` yo'q (read/write/edit/bash), lekin interfeys uni talab qiladi
    // va kelajakdagi tool'lar uchun himoya qoladi.
    const absolut = await this.ichki.absolutePath(path, options?.abortSignal)
    if (!absolut.ok) return absolut

    const javob = await this.ruxsat.sora({
      tur: 'fayl',
      amal: 'remove',
      nishon: absolut.value,
      sabab: "fayl yoki papkani o'chiradi",
      naqsh: `remove:${absolut.value}`,
    })
    if (javob === 'rad') {
      return { ok: false, error: radXatosi(absolut.value, "o'chirish rad etildi") }
    }
    return this.ichki.remove(absolut.value, options)
  }

  async createTempDir(prefix?: string, abortSignal?: AbortSignal): Promise<Result<string, FileError>> {
    return this.ichki.createTempDir(prefix, abortSignal)
  }

  async createTempFile(options?: {
    prefix?: string
    suffix?: string
    abortSignal?: AbortSignal
  }): Promise<Result<string, FileError>> {
    return this.ichki.createTempFile(options)
  }

  // -------------------------------------------------------------------------
  // Shell
  // -------------------------------------------------------------------------

  async exec(
    command: string,
    options?: ShellExecOptions,
  ): Promise<Result<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>> {
    const baho = buyruqniBahola(command, { ishPapkasi: this.cwd })

    // Qat'iy taqiq — klassifikatorga ham, foydalanuvchiga ham bormaydi.
    // Bu yagona shartsiz kafolat: qolgan hamma himoya ehtimoliy.
    if (baho.toifa === 'taqiqlangan') {
      return {
        ok: false,
        error: new ExecutionError(
          'spawn_error',
          `Taqiqlangan buyruq: ${baho.sabab ?? 'tizimga zarar yetkazadi'}`,
        ),
      }
    }

    if (baho.toifa !== 'xavfsiz') {
      const javob = await this.ruxsat.sora({
        tur: 'buyruq',
        amal: 'bash',
        nishon: command,
        sabab: baho.sabab ?? 'tekshirilmagan buyruq',
        naqsh: baho.naqsh,
      })
      if (javob === 'rad') {
        return {
          ok: false,
          error: new ExecutionError(
            'spawn_error',
            `Ruxsat berilmadi: ${baho.sabab ?? 'buyruq rad etildi'}`,
          ),
        }
      }
    }

    // Buyruq har doim ish papkasida boshlanadi
    return this.ichki.exec(command, { ...options, cwd: options?.cwd ?? this.cwd })
  }

  async cleanup(): Promise<void> {
    await this.ichki.cleanup()
  }
}
