// Bazadagi MCP server yozuvini ULANISH SOZLAMASIGA aylantirish.
//
// Bu qatlam `orchestrator.ts` va `platform-ai` orasidagi ko'prik: baza
// (katalog + o'rnatish + kredensial) → `McpUlanadiganServer`.
//
// UCHTA MANBADAN QIYMAT YIG'ILADI:
//   1) katalog yozuvi — buyruq, argumentlar, url, sozlama SXEMASI;
//   2) o'rnatish qatori — maxfiy BO'LMAGAN qiymatlar (`sozlama_qiymatlari`);
//   3) kredensial ombori — MAXFIY qiymatlar (alohida fayl, bazada emas).
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ O'RIN EGALLOVCHILAR SHU YERDA ALMASHTIRILADI.                        │
// │                                                                      │
// │ Registry yozuvlarida argument va sarlavhalar shablon bo'lishi mumkin: │
// │ `Bearer {api_key}`. Ular `Bun.spawn` ga BERILISHIDAN OLDIN oddiy      │
// │ matn amali bilan almashtiriladi va natija argv MASSIVI elementi       │
// │ bo'ladi — shell umuman ishtirok etmaydi.                             │
// └──────────────────────────────────────────────────────────────────────┘

import type { McpUlanadiganServer } from '@platforma/ai'
import type { McpOrnatish, McpServer } from '@platforma/shared'
import { mcpKredensialOmbori } from './mcp-kredensial.ts'
import { orinEgallovchilarniAlmashtir } from './mcp-registry.ts'

/**
 * Sessiya uchun qaysi o'rnatish qiymatlari ishlatilishini tanlaydi.
 *
 * Bitta server global VA loyihaga o'rnatilgan bo'lishi mumkin — u holda
 * LOYIHA o'rnatishi ustun turadi: aniqroq qamrov aniqroq sozlamani
 * bildiradi (masalan shu loyiha uchun alohida token).
 *
 * Eksport qilingan — test aynan shu tanlovni tekshiradi.
 */
export function ornatishniTanla(
  server: McpServer,
  projectId: string | null,
): McpOrnatish | undefined {
  if (projectId) {
    const loyiha = server.ornatilgan.find(
      (o) => o.qamrov === 'loyiha' && o.projectId === projectId,
    )
    if (loyiha) return loyiha
  }
  return server.ornatilgan.find((o) => o.qamrov === 'global')
}

/**
 * Bazadagi serverni ulanish sozlamasiga aylantiradi.
 *
 * `null` qaytsa — server bu sessiyada ishlatilmaydi (o'rnatish topilmadi).
 *
 * TIMEOUT BERILMAYDI: u platforma sozlamasi va `agent.ts` da configdan
 * qo'llanadi. Bu qatlam faqat "qayerga va qanday ulanish" ni aytadi.
 */
export async function mcpSozlamaQur(
  server: McpServer,
  projectId: string | null,
): Promise<McpUlanadiganServer | null> {
  const ornatish = ornatishniTanla(server, projectId)
  if (!ornatish) return null

  // Ochiq qiymatlar bazadan, maxfiylar alohida fayldan. Ular BIRLASHADI:
  // bitta server ham `BASE_URL` (ochiq), ham `TOKEN` (maxfiy) so'rashi mumkin.
  const maxfiylar = await mcpKredensialOmbori().ol(ornatish.id)
  const qiymatlar: Record<string, string> = { ...ornatish.sozlamaQiymatlari, ...maxfiylar }

  // Sxemada e'lon qilingan standart qiymatlar — foydalanuvchi kiritmagan
  // maydonlar uchun. Ular ENG PAST ustuvorlikda.
  const toliq: Record<string, string> = {}
  for (const maydon of server.sozlamalar) {
    if (maydon.standart !== undefined) toliq[maydon.nom] = maydon.standart
  }
  Object.assign(toliq, qiymatlar)

  if (server.transport === 'stdio') {
    if (!server.buyruq) return null
    return {
      id: server.id,
      nom: server.nom,
      sozlama: {
        transport: 'stdio',
        buyruq: server.buyruq,
        argumentlar: (server.argumentlar ?? []).map((a) =>
          orinEgallovchilarniAlmashtir(a, toliq),
        ),
        // Env — sozlama maydonlari. Faqat SXEMADA e'lon qilinganlar
        // uzatiladi: foydalanuvchi kiritgan boshqa kalitlar jarayonga
        // tushmasligi kerak (`toliq` da standartlar ham bor, lekin ular
        // baribir sxemadan kelgan).
        env: envQur(server, toliq),
      },
    }
  }

  if (!server.url) return null
  return {
    id: server.id,
    nom: server.nom,
    sozlama: {
      transport: 'http',
      url: orinEgallovchilarniAlmashtir(server.url, toliq),
      sarlavhalar: sarlavhalarQur(server, toliq),
    },
  }
}

/**
 * stdio uchun env obyekti.
 *
 * Sxemadagi har maydon uchun qiymat bo'lsa qo'shiladi. Bo'sh qiymatlar
 * TASHLANADI: bo'sh env o'zgaruvchisi ba'zi serverlarda "berilgan, lekin
 * bo'sh" deb tushuniladi va "umuman berilmagan" dan boshqacha ishlanadi.
 */
function envQur(server: McpServer, qiymatlar: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const maydon of server.sozlamalar) {
    const qiymat = qiymatlar[maydon.nom]
    if (qiymat) env[maydon.nom] = qiymat
  }
  return env
}

/**
 * HTTP uchun sarlavhalar.
 *
 * Registry'da sarlavha qiymati shablon bo'ladi (`Bearer {api_key}`) va u
 * SXEMADA `value` bo'lib keladi. Bizda esa sxema faqat maydon nomlarini
 * saqlaydi, shuning uchun sarlavha qiymati foydalanuvchi kiritgan qiymatning
 * o'zi bo'ladi. Agar u `Bearer ` prefiksini o'zi yozmagan bo'lsa — bu
 * foydalanuvchi qarori; biz taxmin qilmaymiz.
 */
function sarlavhalarQur(
  server: McpServer,
  qiymatlar: Record<string, string>,
): Record<string, string> {
  const sarlavhalar: Record<string, string> = {}
  for (const maydon of server.sozlamalar) {
    const qiymat = qiymatlar[maydon.nom]
    if (qiymat) sarlavhalar[maydon.nom] = orinEgallovchilarniAlmashtir(qiymat, qiymatlar)
  }
  return sarlavhalar
}

/**
 * Sessiya uchun ulanadigan serverlar ro'yxati.
 *
 * `orchestrator.ts` `agentOqimi()` ga shu funksiyani `mcpManbasi` sifatida
 * beradi. Ulanmaydigan yozuvlar (o'rnatish yo'q, buyruq yo'q) jimgina
 * tashlanadi — sessiya baribir boshlanishi kerak.
 */
export async function ulanadiganServerlar(
  serverlar: readonly McpServer[],
  projectId: string | null,
): Promise<McpUlanadiganServer[]> {
  const natija: McpUlanadiganServer[] = []
  for (const server of serverlar) {
    const sozlama = await mcpSozlamaQur(server, projectId)
    if (sozlama) natija.push(sozlama)
  }
  return natija
}
