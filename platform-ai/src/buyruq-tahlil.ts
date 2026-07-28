// Bash buyrug'ini tahlil qilib, ruxsat kerakmi yo'qmi deb hal qiladi.
//
// MUHIM CHEKLOV: bu statik tahlil — HIMOYA QATLAMI, sandbox EMAS.
// Yetarlicha ijodkor buyruq uni chetlab o'tishi mumkin, masalan:
//   echo cm0gLXJm | base64 -d | sh
// Shu sababli:
//   1) noma'lum buyruqlar ham ruxsat so'raydi (oq ro'yxat modeli),
//   2) `sh`, `eval`, `base64` kabi "yashirish vositalari" xavfli sanaladi,
//   3) haqiqiy izolyatsiya keyingi bosqichda Docker bilan qo'shiladi
//      (ExecutionEnv interfeysi shu uchun almashtiriladigan qoldirilgan).
//
// KEYINGI BOSQICH: noma'lum buyruqlarni AI klassifikatoriga yuborish —
// "bu buyruq foydalanuvchi maqsadiga mos keladimi?". Kengaytma nuqtasi:
// `BuyruqTahlilSozlamalari.notanishTekshiruvchi`. Hozircha u berilmasa
// noma'lum buyruq ruxsat so'raydi.

export type BuyruqToifasi = 'taqiqlangan' | 'xavfsiz' | 'xavfli' | 'notanish'

export interface BuyruqBahosi {
  toifa: BuyruqToifasi
  /** Ruxsat so'ralsa foydalanuvchiga ko'rsatiladigan sabab */
  sabab?: string
  /** "Har doim ruxsat" tanlansa eslab qolinadigan naqsh */
  naqsh: string
}

/**
 * QAT'IY TAQIQ — hech qanday sharoitda avtomatik bajarilmaydi.
 *
 * Bu ro'yxat klassifikatordan ham, "har doim ruxsat" naqshidan ham, auto
 * rejimdan ham ustun turadi. Sabab: qolgan hamma himoya ehtimoliy (LLM
 * aldanishi, naqsh chetlab o'tilishi mumkin), bu esa qat'iy.
 *
 * Ro'yxat ataylab QISQA: faqat qaytarib bo'lmaydigan, butun tizimni buzadigan
 * amallar. Har qo'shimcha element foydalanuvchining haqiqiy ishini to'sish
 * ehtimolini oshiradi, shuning uchun "ehtimol xavfli" narsalar bu yerda emas —
 * ular `XAVFLI_BUYRUQLAR` da, ruxsat so'rash orqali hal bo'ladi.
 */
interface TaqiqQoidasi {
  naqsh: RegExp
  sabab: string
  /**
   * Naqsh butun buyruqqa qo'llanadimi (bo'laklarga ajratmasdan).
   * Fork bomba kabi sintaksislar uchun kerak — ular `;` va `|` ni o'z ichiga
   * oladi, shuning uchun bo'laklashtiruvchi ularni parchalab yuboradi.
   */
  butunBuyruq?: boolean
}

const TAQIQLANGAN: TaqiqQoidasi[] = [
  // Ildiz yoki uy papkasini rekursiv o'chirish.
  // `[rR]` bayroqda bo'lishi shart; nishon aynan `/`, `~` yoki `$HOME`.
  {
    naqsh: /\brm\s+(?:-\S+\s+)*-\S*[rR]\S*\s+(?:\/|~\/?|\$HOME\/?)\s*$/,
    sabab: "ildiz yoki uy papkasidagi hamma narsani o'chiradi",
  },
  // Disk formatlash — buyruq NOMI sifatida (grep mkfs ... emas)
  { naqsh: /(?:^|\s)(?:\/\S+\/)?mkfs(?:\.\w+)?\s/, sabab: 'fayl tizimini formatlaydi' },
  // Diskka xom yozish
  { naqsh: /\bdd\b[^|;&]*\bof=\/dev\/(?:sd|nvme|hd|disk)/, sabab: 'diskka xom yozadi' },
  { naqsh: />\s*\/dev\/(?:sd|nvme|hd|disk)\w/, sabab: 'diskka xom yozadi' },
  { naqsh: /\bdd\s+if=\/dev\/(?:zero|random|urandom)[^|;&]*\bof=\//, sabab: 'diskni tozalaydi' },
  // Fork bomba — butun buyruqda, chunki o'zida `;` va `|` bor
  {
    naqsh: /:\s*\(\s*\)\s*\{\s*:?\s*\|\s*:?\s*&?\s*\}\s*;?\s*:/,
    sabab: 'fork bomba — tizimni qotiradi',
    butunBuyruq: true,
  },
]

/**
 * Buyruq NOMI sifatida kelganda taqiqlanadigan dasturlar.
 *
 * Naqsh emas, nom bo'yicha tekshiriladi — `grep reboot /var/log` yoki
 * `echo "shutdown"` da bu so'zlar argument, buyruq emas.
 */
const TAQIQLANGAN_NOMLAR = new Map<string, string>([
  ['shutdown', "kompyuterni o'chiradi"],
  ['poweroff', "kompyuterni o'chiradi"],
  ['halt', "kompyuterni to'xtatadi"],
  ['reboot', 'kompyuterni qayta yuklaydi'],
  ['mkfs', 'fayl tizimini formatlaydi'],
])

/**
 * Buyruq qat'iy taqiq ro'yxatiga tushadimi.
 *
 * Ikki bosqich: butun buyruq (fork bomba kabi sintaksislar uchun), keyin
 * har bir bo'lak alohida (`ls && rm -rf /` ushlanishi uchun).
 */
export function taqiqlanganmi(buyruq: string): { taqiq: boolean; sabab?: string } {
  for (const { naqsh, sabab, butunBuyruq } of TAQIQLANGAN) {
    if (butunBuyruq && naqsh.test(buyruq)) return { taqiq: true, sabab }
  }

  for (const bolak of buyruqniBolaklarga(buyruq)) {
    // Tirnoq ichidagi matn buyruq emas: `echo "reboot"` o'tishi kerak
    const toza = tirnoqlarniOlibTashla(bolak)

    // Buyruq nomi bo'yicha: `reboot` — ha, `grep reboot fayl` — yo'q.
    // `sudo reboot` ham ushlanishi kerak, shuning uchun imtiyoz o'ramini
    // ochamiz. `mkfs.ext4` kabi kengaytmali variantlar ham hisobga olinadi.
    const nomSababi = nomTaqiqlanganmi(toza)
    if (nomSababi) return { taqiq: true, sabab: nomSababi }

    for (const { naqsh, sabab, butunBuyruq } of TAQIQLANGAN) {
      if (butunBuyruq) continue
      if (naqsh.test(toza)) return { taqiq: true, sabab }
    }
  }
  return { taqiq: false }
}

/**
 * `git <kichik>` dagi kichik buyruqni ajratadi.
 * Global bayroqlar (`-C yol`, `--no-pager`) tashlab yuboriladi.
 */
function gitKichikBuyrugi(bolak: string): string | undefined {
  const sozlar = bolak.split(/\s+/).filter(Boolean)
  const gitIndeksi = sozlar.findIndex((s) => (s.split('/').pop() ?? s) === 'git')
  if (gitIndeksi < 0) return undefined

  for (let i = gitIndeksi + 1; i < sozlar.length; i += 1) {
    const soz = sozlar[i]!
    if (soz.startsWith('-')) {
      // `-C <yol>` va `-c <sozlama>` qiymat oladi
      if (soz === '-C' || soz === '-c') i += 1
      continue
    }
    return soz
  }
  return undefined
}

/**
 * Bo'lakdagi buyruq nomi taqiqlangan ro'yxatdami.
 * `sudo`/`doas` o'rami ochiladi: `sudo reboot` ham ushlanadi.
 */
function nomTaqiqlanganmi(bolak: string): string | undefined {
  let joriy = bolak
  // Imtiyoz o'ramlari — ketma-ket kelishi mumkin (`sudo doas reboot`)
  for (let i = 0; i < 3; i += 1) {
    const nom = buyruqNomi(joriy)
    if (!nom) return undefined

    const asosiy = nom.split('.')[0] ?? nom
    const sabab = TAQIQLANGAN_NOMLAR.get(nom) ?? TAQIQLANGAN_NOMLAR.get(asosiy)
    if (sabab) return sabab

    if (nom !== 'sudo' && nom !== 'doas' && nom !== 'su') return undefined
    // O'ramni olib tashlab, keyingi so'zdan davom etamiz
    const sozlar = joriy.split(/\s+/).filter(Boolean)
    const indeks = sozlar.findIndex((s) => (s.split('/').pop() ?? s) === nom)
    if (indeks < 0) return undefined
    joriy = sozlar.slice(indeks + 1).join(' ')
    if (!joriy) return undefined
  }
  return undefined
}

/**
 * Tirnoq ichidagi matnni bo'sh joyga almashtiradi.
 * `echo "reboot"` → `echo        ` — matn buyruq deb qaralmasin.
 * Uzunlik saqlanadi, shunda `^`/`\s` moslashuvi buzilmaydi.
 */
function tirnoqlarniOlibTashla(bolak: string): string {
  return bolak.replace(/(["'])(?:\\.|(?!\1)[^\\])*\1/g, (m) => ' '.repeat(m.length))
}

/**
 * Ish papkasi ichida erkin ishlatilishi mumkin bo'lgan buyruqlar.
 * Faqat o'qish yoki loyiha ichida xavfsiz o'zgartirish qiladiganlar.
 */
const XAVFSIZ_BUYRUQLAR = new Set([
  // Fayl tizimini o'qish
  'ls', 'pwd', 'cat', 'head', 'tail', 'less', 'more', 'file', 'stat', 'wc',
  'find', 'grep', 'rg', 'ag', 'fd', 'tree', 'du', 'df', 'realpath', 'basename', 'dirname',
  'diff', 'cmp', 'sort', 'uniq', 'cut', 'tr', 'awk', 'sed', 'jq', 'yq',
  'echo', 'printf', 'date', 'which', 'type', 'whoami', 'id', 'env', 'uname',
  // Loyiha vositalari.
  // `git` bu yerda yo'q — u kontekstga bog'liq: `git status` zararsiz,
  // `git push` esa tashqariga chiqadi va foydalanuvchi chegarasi ("push
  // qilma") aynan shunga tegishli bo'ladi. Xavfsiz git kichik buyruqlari
  // pastda alohida ro'yxatda.
  'node', 'bun', 'npm', 'npx', 'pnpm', 'yarn', 'deno',
  'python', 'python3', 'pip', 'pip3', 'uv', 'poetry',
  'go', 'cargo', 'rustc', 'java', 'mvn', 'gradle',
  'tsc', 'eslint', 'oxlint', 'prettier', 'biome', 'vitest', 'jest',
  'make', 'cmake',
  // Papka yaratish (o'chirish EMAS)
  'mkdir', 'touch', 'cp', 'mv',
])

/**
 * Har doim ruxsat so'raydigan buyruqlar. Ikki turkum:
 *   - buzuvchi (rm, dd, mkfs, shred)
 *   - tizim/imtiyoz (sudo, su, chown, systemctl, kill)
 *   - tarmoq va yashirish (curl, wget, sh, eval, base64, nc)
 */
const XAVFLI_BUYRUQLAR = new Map<string, string>([
  ['rm', "fayl o'chiradi"],
  ['rmdir', "papka o'chiradi"],
  ['shred', "faylni qaytarib bo'lmaydigan qilib o'chiradi"],
  ['dd', 'disk darajasida yozadi'],
  ['mkfs', 'fayl tizimini formatlaydi'],
  ['fdisk', "disk bo'limlarini o'zgartiradi"],
  ['mount', 'fayl tizimi ulaydi'],
  ['umount', 'fayl tizimi uzadi'],
  ['sudo', 'administrator huquqi bilan bajaradi'],
  ['su', 'boshqa foydalanuvchiga o\'tadi'],
  ['doas', 'administrator huquqi bilan bajaradi'],
  ['chown', 'fayl egasini o\'zgartiradi'],
  ['chmod', 'fayl ruxsatlarini o\'zgartiradi'],
  ['chgrp', 'fayl guruhini o\'zgartiradi'],
  ['systemctl', 'tizim xizmatlarini boshqaradi'],
  ['service', 'tizim xizmatlarini boshqaradi'],
  ['launchctl', 'tizim xizmatlarini boshqaradi'],
  ['kill', 'jarayonni to\'xtatadi'],
  ['killall', 'jarayonlarni to\'xtatadi'],
  ['pkill', 'jarayonlarni to\'xtatadi'],
  ['shutdown', 'kompyuterni o\'chiradi'],
  ['reboot', 'kompyuterni qayta yuklaydi'],
  ['halt', 'kompyuterni to\'xtatadi'],
  ['curl', 'tarmoqqa chiqadi'],
  ['wget', 'tarmoqdan yuklab oladi'],
  ['nc', 'tarmoq ulanishi ochadi'],
  ['ncat', 'tarmoq ulanishi ochadi'],
  ['ssh', 'masofaviy serverga ulanadi'],
  ['scp', 'masofaviy server bilan fayl almashadi'],
  ['rsync', 'fayllarni ko\'chiradi/sinxronlaydi'],
  ['ftp', 'tarmoqqa chiqadi'],
  ['telnet', 'tarmoqqa chiqadi'],
  ['sh', 'ixtiyoriy skript bajaradi'],
  ['bash', 'ixtiyoriy skript bajaradi'],
  ['zsh', 'ixtiyoriy skript bajaradi'],
  ['eval', 'ixtiyoriy kod bajaradi'],
  ['exec', 'jarayonni almashtiradi'],
  ['source', 'ixtiyoriy skript yuklaydi'],
  ['base64', 'buyruqni yashirish uchun ishlatilishi mumkin'],
  ['xxd', 'buyruqni yashirish uchun ishlatilishi mumkin'],
  ['docker', 'konteynerlarni boshqaradi'],
  ['podman', 'konteynerlarni boshqaradi'],
  ['kubectl', 'klasterni boshqaradi'],
  ['crontab', 'rejalashtirilgan vazifa qo\'shadi'],
  ['at', 'rejalashtirilgan vazifa qo\'shadi'],
])

/**
 * Ish papkasidan chiqmaydigan, o'qish yoki mahalliy git amallari.
 *
 * Qolgan git kichik buyruqlari (`push`, `remote`, `clean`, `reset --hard`,
 * `checkout --`) ATAYLAB ro'yxatda emas: ular yo tashqariga chiqadi, yo
 * qaytarib bo'lmaydigan. Ular ruxsat so'raydi yoki auto rejimda
 * klassifikatorga boradi — foydalanuvchining "push qilma" chegarasi
 * aynan shu yerda ishlaydi.
 */
const XAVFSIZ_GIT = new Set([
  'status', 'log', 'diff', 'show', 'branch', 'blame', 'shortlog',
  'ls-files', 'rev-parse', 'describe', 'tag', 'config',
  'add', 'commit', 'stash', 'switch', 'restore', 'fetch',
])

/** Buyruq oldidagi `VAR=qiymat` prefikslari va `env` o'ramlari tashlab yuboriladi */
const OZGARUVCHI_PREFIKS = /^[A-Za-z_][A-Za-z0-9_]*=/

export interface BuyruqTahlilSozlamalari {
  /** Ish papkasi — undan tashqaridagi yo'llar ruxsat so'raydi */
  ishPapkasi: string
}

/**
 * Buyruqni bo'laklarga ajratadi: `;`, `&&`, `||`, `|`, va yangi qator.
 * Qavs ichidagi almashtirishlar (`$(...)`, backtick) alohida bo'lak sifatida
 * qaytadi — ular ham tekshirilishi kerak.
 */
export function buyruqniBolaklarga(buyruq: string): string[] {
  const bolaklar: string[] = []
  let joriy = ''
  let i = 0
  let qosaTirnoq = false
  let bittaTirnoq = false

  const yakunla = () => {
    const t = joriy.trim()
    if (t) bolaklar.push(t)
    joriy = ''
  }

  while (i < buyruq.length) {
    const c = buyruq[i]!
    const keyingi = buyruq[i + 1]

    // Bitta tirnoq ichida hech narsa kengaytirilmaydi
    if (bittaTirnoq) {
      if (c === "'") bittaTirnoq = false
      joriy += c
      i += 1
      continue
    }
    if (c === "'") {
      bittaTirnoq = true
      joriy += c
      i += 1
      continue
    }
    if (c === '"') {
      qosaTirnoq = !qosaTirnoq
      joriy += c
      i += 1
      continue
    }
    // Ekranlangan belgi
    if (c === '\\' && keyingi !== undefined) {
      joriy += c + keyingi
      i += 2
      continue
    }

    // $(...) va `...` — ichki buyruq, alohida bo'lak
    if (!qosaTirnoq || c === '$' || c === '`') {
      if (c === '$' && keyingi === '(') {
        const yopilish = qavsniTop(buyruq, i + 1)
        if (yopilish > 0) {
          bolaklar.push(...buyruqniBolaklarga(buyruq.slice(i + 2, yopilish)))
          i = yopilish + 1
          continue
        }
      }
      if (c === '`') {
        const yopilish = buyruq.indexOf('`', i + 1)
        if (yopilish > 0) {
          bolaklar.push(...buyruqniBolaklarga(buyruq.slice(i + 1, yopilish)))
          i = yopilish + 1
          continue
        }
      }
    }

    if (qosaTirnoq) {
      joriy += c
      i += 1
      continue
    }

    // Ajratuvchilar
    if (c === ';' || c === '\n' || c === '&' || c === '|') {
      yakunla()
      // `&&` va `||` ikki belgili
      i += (c === '&' && keyingi === '&') || (c === '|' && keyingi === '|') ? 2 : 1
      continue
    }

    joriy += c
    i += 1
  }
  yakunla()
  return bolaklar
}

function qavsniTop(matn: string, ochilishIndeksi: number): number {
  let chuqurlik = 0
  for (let i = ochilishIndeksi; i < matn.length; i += 1) {
    if (matn[i] === '(') chuqurlik += 1
    else if (matn[i] === ')') {
      chuqurlik -= 1
      if (chuqurlik === 0) return i
    }
  }
  return -1
}

/** Bo'lakdan buyruq nomini ajratadi (VAR=x prefikslarini tashlab) */
export function buyruqNomi(bolak: string): string {
  const sozlar = bolak.split(/\s+/).filter(Boolean)
  let i = 0
  while (i < sozlar.length && OZGARUVCHI_PREFIKS.test(sozlar[i]!)) i += 1
  // `env FOO=bar cmd` va `command cmd` o'ramlarini ochamiz
  while (i < sozlar.length && (sozlar[i] === 'env' || sozlar[i] === 'command' || sozlar[i] === 'nohup')) {
    i += 1
    while (i < sozlar.length && OZGARUVCHI_PREFIKS.test(sozlar[i]!)) i += 1
  }
  const nom = sozlar[i] ?? ''
  // To'liq yo'l bilan berilgan bo'lsa oxirgi qismini olamiz: /bin/rm → rm
  const oxirgi = nom.split('/').pop() ?? nom
  return oxirgi.replace(/^['"]|['"]$/g, '')
}

/**
 * Bo'lakdagi argumentlarda ish papkasidan tashqaridagi yo'l bormi.
 * Ehtiyotkor: shubhali bo'lsa "bor" deb hisoblaydi.
 */
function tashqiYolBormi(bolak: string, ishPapkasi: string): string | null {
  const sozlar = bolak.split(/\s+/).filter(Boolean)
  for (const xomSoz of sozlar) {
    const soz = xomSoz.replace(/^['"]|['"]$/g, '')
    if (!soz) continue

    // Uy papkasi
    if (soz === '~' || soz.startsWith('~/')) return soz
    // Absolut yo'l — ish papkasi ichidami?
    if (soz.startsWith('/')) {
      if (soz === ishPapkasi || soz.startsWith(`${ishPapkasi}/`)) continue
      return soz
    }
    // Nisbiy yo'lda yuqoriga chiqish
    if (soz === '..' || soz.startsWith('../') || soz.includes('/../')) return soz
  }
  return null
}

/**
 * Buyruqni baholaydi. Bir nechta bo'lak bo'lsa ENG XAVFLISI qaytadi —
 * `ls && rm -rf x` xavfli sanaladi.
 */
export function buyruqniBahola(buyruq: string, sozlama: BuyruqTahlilSozlamalari): BuyruqBahosi {
  // 0) Qat'iy taqiq — boshqa hamma tekshiruvdan oldin va ustun
  const taqiq = taqiqlanganmi(buyruq)
  if (taqiq.taqiq) {
    return { toifa: 'taqiqlangan', sabab: taqiq.sabab, naqsh: '' }
  }

  const bolaklar = buyruqniBolaklarga(buyruq)
  if (bolaklar.length === 0) {
    return { toifa: 'xavfsiz', naqsh: '' }
  }

  let notanish: BuyruqBahosi | null = null

  for (const bolak of bolaklar) {
    const nom = buyruqNomi(bolak)
    if (!nom) continue

    const naqsh = naqshYasa(nom, bolak)

    // 1) Xavfli ro'yxat — darhol qaytadi
    const xavfliSabab = XAVFLI_BUYRUQLAR.get(nom)
    if (xavfliSabab) {
      return { toifa: 'xavfli', sabab: `\`${nom}\` — ${xavfliSabab}`, naqsh }
    }

    // 2) `cd` bilan ish papkasidan chiqish
    if (nom === 'cd') {
      const nishon = bolak.split(/\s+/).filter(Boolean)[1] ?? ''
      if (nishon && (nishon.startsWith('/') || nishon.startsWith('~') || nishon.startsWith('..'))) {
        const tashqi = tashqiYolBormi(bolak, sozlama.ishPapkasi)
        if (tashqi) {
          return {
            toifa: 'xavfli',
            sabab: `ish papkasidan tashqariga chiqadi: ${tashqi}`,
            naqsh,
          }
        }
      }
      continue
    }

    // 3) Argumentlarda tashqi yo'l
    const tashqi = tashqiYolBormi(bolak, sozlama.ishPapkasi)
    if (tashqi) {
      return {
        toifa: 'xavfli',
        sabab: `ish papkasidan tashqaridagi yo'l: ${tashqi}`,
        naqsh,
      }
    }

    // 3b) git — kichik buyruqqa qarab hal qilinadi
    if (nom === 'git') {
      const kichik = gitKichikBuyrugi(bolak)
      if (kichik && XAVFSIZ_GIT.has(kichik)) continue
      return {
        toifa: 'xavfli',
        sabab: kichik
          ? `\`git ${kichik}\` — tashqariga chiqadi yoki qaytarib bo'lmaydi`
          : 'git kichik buyrug\'i aniqlanmadi',
        naqsh,
      }
    }

    // 4) Oq ro'yxatda yo'q — notanish (birinchisini eslab qolamiz)
    if (!XAVFSIZ_BUYRUQLAR.has(nom) && !notanish) {
      notanish = {
        toifa: 'notanish',
        sabab: `\`${nom}\` tanish buyruqlar ro'yxatida yo'q`,
        naqsh,
      }
    }
  }

  if (notanish) return notanish
  return { toifa: 'xavfsiz', naqsh: naqshYasa(buyruqNomi(bolaklar[0]!), bolaklar[0]!) }
}

/**
 * "Har doim ruxsat" uchun naqsh: buyruq nomi + birinchi argument.
 * Ataylab tor — `git` emas, `git push`. Aks holda bitta tasdiq juda ko'p
 * narsaga yo'l ochib yuborardi.
 */
function naqshYasa(nom: string, bolak: string): string {
  const sozlar = bolak.split(/\s+/).filter(Boolean)
  const nomIndeksi = sozlar.findIndex((s) => (s.split('/').pop() ?? s).replace(/^['"]|['"]$/g, '') === nom)
  const keyingi = nomIndeksi >= 0 ? sozlar[nomIndeksi + 1] : undefined
  // Bayroq yoki yo'l bo'lsa naqshga qo'shmaymiz — ular har safar o'zgaradi
  if (keyingi && !keyingi.startsWith('-') && !keyingi.includes('/') && /^[\w.:@-]+$/.test(keyingi)) {
    return `${nom} ${keyingi}`
  }
  return nom
}

/** Testlar va diagnostika uchun ro'yxatlarni ko'rish */
export const buyruqRoyxatlari = {
  xavfsiz: XAVFSIZ_BUYRUQLAR,
  xavfli: XAVFLI_BUYRUQLAR,
}
