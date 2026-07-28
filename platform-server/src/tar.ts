// Minimal tar o'quvchi — GitHub tarball'idan skill papkasini chiqarish uchun.
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ NEGA TASHQI `tar` EMAS: zip-slip. Arxiv ichidagi yo'l                │
// │ `../../../.ssh/authorized_keys` bo'lsa, `tar -x` uni nishon papkadan │
// │ TASHQARIGA yozadi. Arxiv begona GitHub repo'sidan keladi, ya'ni bu   │
// │ nazariy xavf emas.                                                   │
// │                                                                      │
// │ GNU tar da `--strip-components` bor, lekin himoya bayroqlari         │
// │ platformaga qarab farq qiladi (bsdtar va GNU tar bir xil emas), va   │
// │ subprocess chiqishini tahlil qilish ishonchsiz. Formatning o'zi      │
// │ juda sodda — 512 baytli blok sarlavha + ma'lumot — shuning uchun     │
// │ o'qishni o'zimiz qilamiz va HAR yo'lni o'zimiz tekshiramiz.          │
// └──────────────────────────────────────────────────────────────────────┘
//
// Qo'llab-quvvatlanadi: oddiy fayl (`0`), papka (`5`), GNU uzun nom
// (`L`), PAX kengaytmasi (`x`/`g` — o'tkazib yuboriladi). Symlink (`1`,`2`)
// ATAYLAB TASHLANADI: skill papkasidagi symlink chegaradan chiqib ketish
// yo'li bo'lardi (`muhit.ts` canonicalPath bilan ushlaydi, lekin bu yerga
// umuman yozmaslik tuzukroq).

const BLOK = 512

export interface TarFayl {
  /** Arxiv ichidagi tozalangan yo'l — `..` va absolut yo'lsiz */
  yol: string
  mazmun: Uint8Array
}

/** Sakkizlik sonli maydon (oxirida NUL yoki bo'shliq bo'lishi mumkin) */
function sakkizlik(bayt: Uint8Array): number {
  let matn = ''
  for (const b of bayt) {
    if (b === 0 || b === 0x20) break
    matn += String.fromCharCode(b)
  }
  const son = parseInt(matn, 8)
  return Number.isFinite(son) ? son : 0
}

function matnMaydon(bayt: Uint8Array): string {
  let oxir = bayt.indexOf(0)
  if (oxir === -1) oxir = bayt.length
  return new TextDecoder().decode(bayt.subarray(0, oxir))
}

/**
 * Yo'lni xavfsiz shaklga keltiradi.
 *
 * `null` qaytsa — yo'l XAVFLI va fayl butunlay tashlanishi kerak:
 * absolut yo'l, `..` bo'lagi, yoki Windows disk prefiksi.
 */
export function yolniTozala(xom: string): string | null {
  // Teskari chiziq ham ajratuvchi deb qaraladi: `..\..\x` ni o'tkazib
  // yubormaslik uchun
  const normal = xom.replace(/\\/g, '/')

  if (normal.startsWith('/') || /^[a-zA-Z]:/.test(normal)) return null

  const bolaklar: string[] = []
  for (const b of normal.split('/')) {
    if (b === '' || b === '.') continue
    if (b === '..') return null
    // NUL va boshqaruv belgilari fayl nomida bo'lmasligi kerak
    if (/[\0]/.test(b)) return null
    bolaklar.push(b)
  }

  return bolaklar.length > 0 ? bolaklar.join('/') : null
}

/**
 * Tar arxivini o'qiydi. Xavfli yo'lli yozuvlar JIM TASHLANADI (xato emas):
 * bitta buzuq yozuv uchun butun skill'ni yo'qotmaymiz.
 *
 * `maksJamiBayt` — chiqarilgan ma'lumot chegarasi (zip bomb himoyasi).
 * Oshsa xato tashlanadi — bu allaqachon normal arxiv emas.
 */
export function tarOqi(xom: Uint8Array, maksJamiBayt: number): TarFayl[] {
  const natija: TarFayl[] = []
  let jami = 0
  let ofset = 0
  // GNU `L` yozuvi keyingi fayl uchun uzun nom beradi
  let kutilayotganNom: string | null = null

  while (ofset + BLOK <= xom.length) {
    const sarlavha = xom.subarray(ofset, ofset + BLOK)

    // Ikkita ketma-ket bo'sh blok — arxiv oxiri
    if (sarlavha.every((b) => b === 0)) break

    const nom = matnMaydon(sarlavha.subarray(0, 100))
    const hajm = sakkizlik(sarlavha.subarray(124, 136))
    const tur = String.fromCharCode(sarlavha[156] ?? 0)
    // `prefix` maydoni (USTAR): uzun yo'llar shu yerda bo'linadi
    const prefiks = matnMaydon(sarlavha.subarray(345, 500))

    ofset += BLOK
    const malumot = xom.subarray(ofset, ofset + hajm)
    // Ma'lumot 512 ga to'ldiriladi
    ofset += Math.ceil(hajm / BLOK) * BLOK

    if (tur === 'L') {
      // GNU uzun nom — keyingi yozuvga tegishli
      kutilayotganNom = matnMaydon(malumot)
      continue
    }
    if (tur === 'x' || tur === 'g') continue // PAX metadata
    if (tur !== '0' && tur !== '\0') continue // faqat oddiy fayl

    const toliqNom = kutilayotganNom ?? (prefiks ? `${prefiks}/${nom}` : nom)
    kutilayotganNom = null

    const tozaYol = yolniTozala(toliqNom)
    if (!tozaYol) continue

    jami += hajm
    if (jami > maksJamiBayt) {
      throw new Error(`Arxiv juda katta: ${maksJamiBayt} bayt chegarasi oshdi`)
    }

    natija.push({ yol: tozaYol, mazmun: new Uint8Array(malumot) })
  }

  return natija
}
