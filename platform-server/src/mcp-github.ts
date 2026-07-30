// GitHub repo'dan MCP server yozuvlarini skanerlash.
//
// `skill-ombor.ts` dagi `manbaniSkanerla` bilan bir xil naqsh, lekin
// TARBALL YO'Q: MCP serverda diskka tushadigan fayl bo'lmaydi. Bizga faqat
// METADATA kerak (`server.json`), jarayon esa keyinchalik `npx`/`uvx` bilan
// o'z paketini o'zi yuklab oladi. Ya'ni bu yerda ombor qatlami umuman yo'q.
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ `server.json` — RASMIY PUBLISH FORMATI, registry sxemasi bilan       │
// │ AYNI. Shuning uchun `registryYozuvniAylantir()` qayta ishlatiladi:   │
// │ ikki manba, bitta konvertor.                                         │
// │                                                                      │
// │ DARAXT BO'YLAB qidiramiz, faqat ildizni emas. Tekshirilgan:          │
// │ `github/github-mcp-server` va `cloudflare/mcp-server-cloudflare` da  │
// │ fayl ildizda, lekin monorepolarda (`modelcontextprotocol/servers`)   │
// │ ildizda YO'Q — u ichki papkalarda bo'lishi mumkin.                   │
// └──────────────────────────────────────────────────────────────────────┘

import type { McpKatalogYozuvi } from '@platforma/shared'
import { blobniOqi, fayllarniTop, repoMalumoti, type GithubManzil } from './github.ts'
import { registryYozuvniAylantir, type RegistryServerYozuvi } from './mcp-registry.ts'

/** Papka ichida yoki ildizda `server.json` (katta-kichik harf farqsiz) */
const SERVER_JSON_NAQSHI = /(^|\/)server\.json$/i

/**
 * Bir repo'da o'qiladigan eng ko'p fayl.
 *
 * `skill-ombor.ts` dagi `MAKS_SKANER_FAYL` bilan bir xil sabab: har fayl
 * uchun bitta blob so'rovi ketadi va rate limit 60/soat (autentifikatsiyasiz).
 * MCP uchun chegara PASTROQ — `server.json` odatda bitta-ikkita bo'ladi,
 * o'ndan ko'p bo'lsa bu MCP repo emas, boshqa narsa (masalan `server.json`
 * nomli konfiguratsiya fayllari to'plami).
 */
export const MAKS_MCP_SKANER_FAYL = 10

export interface McpSkanerNatija {
  ref: string
  sha: string
  serverlar: Omit<McpKatalogYozuvi, 'id' | 'manbaId' | 'createdAt'>[]
  ogohlantirishlar: string[]
}

/**
 * Repo'dagi `server.json` fayllarini o'qib katalog yozuvlariga aylantiradi.
 *
 * XATO TASHLAYDI faqat repo'ga umuman kirib bo'lmasa (404, rate limit).
 * Bitta fayl buzuq bo'lsa qolganini yo'qotmaymiz — ogohlantirish qo'shiladi
 * (`skill-ombor.ts` dagi bilan bir xil qoida).
 */
export async function mcpManbaniSkanerla(m: GithubManzil): Promise<McpSkanerNatija> {
  const ogohlantirishlar: string[] = []
  const { ref, sha } = await repoMalumoti(m)
  const { fayllar, kesilgan } = await fayllarniTop(m, ref, SERVER_JSON_NAQSHI)

  if (kesilgan) {
    ogohlantirishlar.push('Repository too large — the file list is incomplete')
  }

  let royxat = fayllar
  if (royxat.length > MAKS_MCP_SKANER_FAYL) {
    ogohlantirishlar.push(
      `Found ${royxat.length} server.json files, read the first ${MAKS_MCP_SKANER_FAYL}`,
    )
    royxat = royxat.slice(0, MAKS_MCP_SKANER_FAYL)
  }

  const serverlar: McpSkanerNatija['serverlar'] = []
  const korilganNomlar = new Set<string>()

  for (const fayl of royxat) {
    let xom: string
    try {
      xom = await blobniOqi(m, fayl.sha)
    } catch {
      // Bitta fayl o'qilmasa qolganini yo'qotmaymiz
      ogohlantirishlar.push(`${fayl.yol}: could not be read`)
      continue
    }

    let malumot: RegistryServerYozuvi
    try {
      malumot = JSON.parse(xom) as RegistryServerYozuvi
    } catch {
      ogohlantirishlar.push(`${fayl.yol}: not JSON — skipped`)
      continue
    }

    // `server.json` nomli fayl har xil narsa bo'lishi mumkin (masalan
    // eski MCP konfiguratsiyasi yoki umuman boshqa loyihaning fayli).
    // MCP publish formati `name` va (`packages` yoki `remotes`) talab qiladi —
    // ular bo'lmasa bu bizning faylimiz emas.
    if (!malumot.name) {
      ogohlantirishlar.push(`${fayl.yol}: no "name" — not an MCP server descriptor`)
      continue
    }

    const yozuv = registryYozuvniAylantir(malumot)
    if (!yozuv) {
      ogohlantirishlar.push(
        `${fayl.yol}: no launch method could be determined (missing packages/remotes or unknown type)`,
      )
      continue
    }

    // Bir repo'da bir nom ikki marta bo'lsa (masalan monorepo ichida
    // takrorlangan) birinchisi qoladi — baza UNIQUE indeksi baribir
    // ikkinchisini rad etardi, lekin bu yerda ogohlantirish beramiz.
    if (korilganNomlar.has(yozuv.nom)) {
      ogohlantirishlar.push(`${fayl.yol}: duplicate name "${yozuv.nom}" — skipped`)
      continue
    }
    korilganNomlar.add(yozuv.nom)
    serverlar.push(yozuv)
  }

  if (serverlar.length === 0 && ogohlantirishlar.length === 0) {
    ogohlantirishlar.push('No `server.json` found in the repository')
  }

  return { ref, sha, serverlar, ogohlantirishlar }
}
