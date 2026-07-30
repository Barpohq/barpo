// GitHub client — skill manbalarini skanerlash va yuklab olish.
//
// Ikki chaqiruv yetadi:
//   1) `git/trees?recursive=1` — repo'dagi HAMMA fayl bitta so'rovda.
//      Shundan `SKILL.md` larni ajratamiz. `contents` API bilan har papkani
//      alohida so'rash o'nlab so'rov degani (rate limit tez tugaydi).
//   2) `tarball` — o'rnatishda butun repo arxivi. Faqat kerakli papka
//      chiqariladi; qolgani tashlanadi.
//
// AUTENTIFIKATSIYA YO'Q: public repo uchun token shart emas. Rate limit
// token'siz soatiga 60 so'rov — bir foydalanuvchili platforma uchun yetarli.
// Limitga urilganda xato ANIQ ko'rsatiladi (jim ishlamay qolish emas).

const API = 'https://api.github.com'

/** Tarmoq so'rovi timeout'i — GitHub javob bermay qolsa sessiya osilib qolmasin */
const TIMEOUT_MS = 30_000

/**
 * Tarball hajmi chegarasi. `anthropics/skills` ~10MB, lekin begona repo
 * yuzlab megabayt bo'lishi mumkin — uni xotiraga yuklash serverni yiqitardi.
 */
export const MAKS_TARBALL_BAYT = 100 * 1024 * 1024

/** Bitta skill papkasi chegarasi (ombordagi yakuniy hajm) */
export const MAKS_SKILL_BAYT = 20 * 1024 * 1024

export interface GithubManzil {
  owner: string
  repo: string
  /** Bo'sh satr = standart branch */
  ref: string
}

/**
 * Foydalanuvchi kiritgan matndan repo manzilini ajratadi.
 *
 * Qabul qilinadi:
 *   https://github.com/anthropics/skills
 *   https://github.com/anthropics/skills/tree/main
 *   github.com/anthropics/skills.git
 *   anthropics/skills
 *
 * `null` — tanib bo'lmadi.
 */
export function manzilniAjrat(xom: string): GithubManzil | null {
  let matn = xom.trim()
  if (!matn) return null

  matn = matn.replace(/^git\+/, '').replace(/\.git$/, '')
  matn = matn.replace(/^https?:\/\//, '').replace(/^git@github\.com:/, 'github.com/')
  matn = matn.replace(/^(www\.)?github\.com\//, '')
  matn = matn.replace(/\/+$/, '')

  const bolaklar = matn.split('/').filter(Boolean)
  if (bolaklar.length < 2) return null

  const [owner, repo, ...qolgan] = bolaklar
  if (!owner || !repo) return null

  // Nom qoidasi: GitHub `[A-Za-z0-9._-]` ga ruxsat beradi. Nuqta kerak
  // (`repo.js` kabi nomlar bor), lekin FAQAT nuqtadan iborat bo'lak (`.`,
  // `..`) taqiqlanadi — u API URL'ida yo'l bo'lagi bo'lib siljitib
  // yuborardi (`/repos/../etc` → boshqa endpoint).
  const nomToger = (x: string) => /^[A-Za-z0-9._-]+$/.test(x) && !/^\.+$/.test(x)
  if (!nomToger(owner) || !nomToger(repo)) return null

  // `/tree/<ref>/...` yoki `/blob/<ref>/...`
  let ref = ''
  if ((qolgan[0] === 'tree' || qolgan[0] === 'blob') && qolgan[1]) {
    ref = qolgan.slice(1).join('/')
  }
  // Ref API URL'iga qo'shiladi (`/commits/<ref>`), shuning uchun `..`
  // bo'lagi taqiqlanadi — aks holda yo'l boshqa endpoint'ga siljib ketardi
  if (ref) {
    if (!/^[A-Za-z0-9._\/-]+$/.test(ref)) return null
    if (ref.split('/').some((b) => /^\.+$/.test(b))) return null
  }

  return { owner, repo, ref }
}

async function soraw(url: string): Promise<Response> {
  const javob = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'platforma-skills',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })

  if (javob.ok) return javob

  // Rate limit'ni alohida ajratamiz — foydalanuvchi nima qilishni bilsin
  if (javob.status === 403 || javob.status === 429) {
    const qoldi = javob.headers.get('x-ratelimit-remaining')
    if (qoldi === '0') {
      const tiklanish = javob.headers.get('x-ratelimit-reset')
      const vaqt = tiklanish
        ? new Date(Number(tiklanish) * 1000).toLocaleTimeString('uz-UZ')
        : "bir ozdan so'ng"
      throw new Error(`GitHub rate limit reached. Try again at ${vaqt}.`)
    }
  }
  if (javob.status === 404) {
    throw new Error('Repository not found. Check the URL (private repositories are not supported).')
  }

  throw new Error(`GitHub error: ${javob.status} ${javob.statusText}`)
}

/** Repo'ning standart branch'i va oxirgi commit SHA'si */
export async function repoMalumoti(m: GithubManzil): Promise<{ ref: string; sha: string }> {
  const ref = m.ref || (await (async () => {
    const javob = await soraw(`${API}/repos/${m.owner}/${m.repo}`)
    const malumot = (await javob.json()) as { default_branch?: string }
    return malumot.default_branch ?? 'main'
  })())

  const javob = await soraw(`${API}/repos/${m.owner}/${m.repo}/commits/${encodeURIComponent(ref)}`)
  const malumot = (await javob.json()) as { sha?: string }
  return { ref, sha: malumot.sha ?? '' }
}

export interface TopilganFayl {
  /** Repo ildizidan yo'l: `document-skills/pdf/SKILL.md` */
  yol: string
  /** Blob SHA — mazmunni olish uchun */
  sha: string
}

/**
 * Repo daraxtida naqshga mos fayllarni topadi.
 *
 * BITTA CHAQIRUVDA butun daraxt olinadi (`recursive=1`) va mahalliy
 * filtrlanadi — rate limit (60/soat, autentifikatsiyasiz) sababli har papka
 * uchun alohida so'rov yuborib bo'lmaydi.
 *
 * `truncated` bayrog'i: juda katta repo'da GitHub daraxtni kesib beradi.
 * Bunda topilganini qaytaramiz va chaqiruvchiga ogohlantirish beramiz —
 * bo'sh natijadan ko'ra qisman natija foydali.
 *
 * NAQSH PARAMETR: skilllar `SKILL.md` qidiradi, MCP marketi `server.json`.
 * Ikkalasi uchun bir xil daraxt so'rovi va bir xil `truncated` mantig'i
 * kerak, shuning uchun faqat filtr tashqariga chiqarilgan.
 */
export async function fayllarniTop(
  m: GithubManzil,
  ref: string,
  naqsh: RegExp,
): Promise<{ fayllar: TopilganFayl[]; kesilgan: boolean }> {
  const javob = await soraw(
    `${API}/repos/${m.owner}/${m.repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
  )
  const malumot = (await javob.json()) as {
    tree?: { path?: string; type?: string; sha?: string }[]
    truncated?: boolean
  }

  const fayllar: TopilganFayl[] = []
  for (const yozuv of malumot.tree ?? []) {
    if (yozuv.type !== 'blob' || !yozuv.path || !yozuv.sha) continue
    if (!naqsh.test(yozuv.path)) continue
    fayllar.push({ yol: yozuv.path, sha: yozuv.sha })
  }

  return { fayllar, kesilgan: malumot.truncated === true }
}

/** Papka ichida yoki ildizda joylashgan `SKILL.md` (katta-kichik harf farqsiz) */
const SKILL_NAQSHI = /(^|\/)SKILL\.md$/i

/** Repo'dagi hamma `SKILL.md` yo'llarini topadi */
export async function skillFayllariniTop(
  m: GithubManzil,
  ref: string,
): Promise<{ fayllar: TopilganFayl[]; kesilgan: boolean }> {
  return fayllarniTop(m, ref, SKILL_NAQSHI)
}

/** Bitta blob mazmuni — katalog skanerlashda `SKILL.md` frontmatter'i uchun */
export async function blobniOqi(m: GithubManzil, sha: string): Promise<string> {
  const javob = await soraw(`${API}/repos/${m.owner}/${m.repo}/git/blobs/${sha}`)
  const malumot = (await javob.json()) as { content?: string; encoding?: string }
  if (malumot.encoding !== 'base64' || !malumot.content) return ''
  return Buffer.from(malumot.content, 'base64').toString('utf8')
}

/**
 * Repo tarball'ini yuklab oladi (gzip ochilgan holda).
 *
 * Hajm ikki marta tekshiriladi: `Content-Length` sarlavhasi bo'yicha
 * oldindan, va yuklab olingandan keyin haqiqiy hajm bo'yicha — sarlavha
 * yolg'on bo'lishi mumkin.
 */
export async function tarballniOl(m: GithubManzil, ref: string): Promise<Uint8Array> {
  const javob = await fetch(
    `https://codeload.github.com/${m.owner}/${m.repo}/tar.gz/${encodeURIComponent(ref)}`,
    {
      headers: { 'User-Agent': 'platforma-skills' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    },
  )

  if (!javob.ok) {
    throw new Error(`Could not download the archive: ${javob.status} ${javob.statusText}`)
  }

  const uzunlik = javob.headers.get('content-length')
  if (uzunlik && Number(uzunlik) > MAKS_TARBALL_BAYT) {
    throw new Error(`Repository too large (${Math.round(Number(uzunlik) / 1024 / 1024)}MB)`)
  }

  const siqilgan = new Uint8Array(await javob.arrayBuffer())
  if (siqilgan.length > MAKS_TARBALL_BAYT) {
    throw new Error('Repository too large')
  }

  return Bun.gunzipSync(siqilgan)
}
