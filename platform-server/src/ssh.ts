// SSH qatlami — serverlarga parolsiz ulanishning butun mexanikasi.
//
// Model:
//
//   1) PLATFORMA KALITI — ~/.platforma/ssh/id_ed25519 (+ .pub). Foydalanuvchi
//      shaxsiy kalitidan ATAYLAB alohida: platformani bekor qilish = serverdan
//      bitta shu kalitni o'chirish, shaxsiy kalitga tegilmaydi.
//
//   2) BOSHQARILADIGAN CONFIG — ~/.platforma/ssh/config. Har server uchun
//      Host bloki (alias, host, port, user, kalit). ~/.ssh/config ga faqat
//      BITTA `Include` qatori qo'shiladi — foydalanuvchi fayliga boshqa
//      tegilmaydi. Shu tufayli terminaldagi `ssh <server-nomi>` ham ishlaydi.
//
//   3) KALIT JOYLASH — birinchi ulanishda root'ning authorized_keys'iga
//      ochiq kalit qo'shiladi. Ikki yo'l: foydalanuvchining mavjud kaliti
//      allaqachon kirsa (BatchMode), parol umuman kerak emas; aks holda
//      bir martalik parol sshpass orqali beriladi (SSHPASS env — argv'da
//      ko'rinmaydi, bazaga YOZILMAYDI).
//
// Barcha tashqi buyruqlar `BuyruqBajaruvchi` orqali o'tadi — testlar uni
// soxta bajaruvchi bilan almashtiradi (dbOrnat bilan bir xil uslub).

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Server, ServerMetrika } from '@platforma/shared'

// ---------------------------------------------------------------------------
// Buyruq bajaruvchi (testlarda almashtiriladi)
// ---------------------------------------------------------------------------

export interface BuyruqNatija {
  kod: number
  stdout: string
  stderr: string
}

/**
 * Buyruq bajarish imkoniyatlari.
 *
 * `stdin` — MAXFIY MA'LUMOT UZATISH YO'LI. Token argumentga tushsa u
 * serverdagi `ps` chiqishida va shell tarixida ko'rinardi; stdin esa faqat
 * jarayonning o'ziga boradi (`ssh.envYoz()` shuni ishlatadi).
 *
 * `timeoutMs` — standart chegarani ko'chirish uchun: `docker restart` +
 * healthcheck 20 soniyaga sig'maydi (`amal-bajar.ts`).
 */
export interface BuyruqImkoniyat {
  env?: Record<string, string>
  stdin?: string
  timeoutMs?: number
}

export type BuyruqBajaruvchi = (
  argv: string[],
  imkoniyat?: BuyruqImkoniyat,
) => Promise<BuyruqNatija>

/** SSH sessiyasi osilib qolmasin — ConnectTimeout'dan tashqari JS tomonda ham chegara */
const BUYRUQ_TIMEOUT_MS = 20_000

const standartBajaruvchi: BuyruqBajaruvchi = async (argv, imkoniyat) => {
  const stdin = imkoniyat?.stdin

  const proc = Bun.spawn(argv, {
    env: { ...process.env, ...imkoniyat?.env },
    stdout: 'pipe',
    stderr: 'pipe',
    // Berilmasa `ignore` — avvalgi xulq saqlanadi (jarayon stdin kutib
    // osilib qolmasin).
    stdin: stdin === undefined ? 'ignore' : 'pipe',
  })

  // Yozishni DARHOL boshlaymiz, `await` qilmasdan: katta stdin va to'lgan
  // quvur holatida yozishni kutib turib chiqishni o'qimasak, ikki tomon
  // bir-birini kutib deadlock bo'lardi.
  if (stdin !== undefined) {
    const yozish = (async () => {
      try {
        proc.stdin!.write(stdin)
        await proc.stdin!.end()
      } catch {
        // Jarayon stdin'ni o'qimasdan yopilgan bo'lishi mumkin (EPIPE) —
        // bu buyruq natijasini bekor qilmaydi, chiqish kodi o'zi aytadi.
      }
    })()
    // Yutilgan xato bo'lmasin
    void yozish
  }

  const soat = setTimeout(() => proc.kill(), imkoniyat?.timeoutMs ?? BUYRUQ_TIMEOUT_MS)
  try {
    const [stdout, stderr, kod] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    return { kod, stdout, stderr }
  } finally {
    clearTimeout(soat)
  }
}

let bajaruvchi: BuyruqBajaruvchi = standartBajaruvchi

/** Testlar uchun: soxta bajaruvchi o'rnatish (null — standartga qaytarish) */
export function bajaruvchiOrnat(b: BuyruqBajaruvchi | null): void {
  bajaruvchi = b ?? standartBajaruvchi
}

/**
 * Joriy bajaruvchi orqali buyruq ishga tushiradi.
 *
 * `ilova-ssh.ts` uchun ochilgan: u ham SOXTA bajaruvchidan o'tishi kerak,
 * aks holda ilova amallari testlarida haqiqiy `ssh` chaqirilardi. Modul
 * ichidagi `bajaruvchi` o'zgaruvchisiga to'g'ridan murojaat qilish import
 * paytida nusxa olib qolardi (`bajaruvchiOrnat` keyin ishlamasdi).
 */
export function sshBajar(
  argv: string[],
  imkoniyat?: BuyruqImkoniyat,
): Promise<BuyruqNatija> {
  return bajaruvchi(argv, imkoniyat)
}

// ---------------------------------------------------------------------------
// Yo'llar
// ---------------------------------------------------------------------------

/** Platforma SSH papkasi (kalit + config + known_hosts). Testlarda env bilan ko'chiriladi. */
export function sshIldizi(): string {
  const env = process.env.PLATFORMA_SSH?.trim()
  if (env) return env
  return join(homedir(), '.platforma', 'ssh')
}

/** Foydalanuvchining ~/.ssh/config fayli. Testlarda env bilan ko'chiriladi. */
export function userSshConfigYoli(): string {
  const env = process.env.PLATFORMA_USER_SSH_CONFIG?.trim()
  if (env) return env
  return join(homedir(), '.ssh', 'config')
}

export function kalitYoli(): string {
  return join(sshIldizi(), 'id_ed25519')
}

export function boshqarilganConfigYoli(): string {
  return join(sshIldizi(), 'config')
}

function knownHostsYoli(): string {
  return join(sshIldizi(), 'known_hosts')
}

// ---------------------------------------------------------------------------
// Kalit
// ---------------------------------------------------------------------------

/**
 * Platforma kalit juftligini kafolatlaydi va OCHIQ kalit matnini qaytaradi.
 * Kalit bir marta yaratiladi, parolsiz (`-N ''`) — usiz "parolsiz ulanish"
 * degan maqsadning o'zi yo'qqa chiqadi.
 */
export async function kalitTaminla(): Promise<string> {
  const maxfiy = kalitYoli()
  const ochiq = `${maxfiy}.pub`

  mkdirSync(sshIldizi(), { recursive: true, mode: 0o700 })

  if (!existsSync(ochiq)) {
    const n = await bajaruvchi([
      'ssh-keygen',
      '-t', 'ed25519',
      '-N', '',
      '-C', 'platforma',
      '-f', maxfiy,
      '-q',
    ])
    if (n.kod !== 0) {
      throw new Error(`ssh-keygen xatosi: ${n.stderr.trim() || n.stdout.trim()}`)
    }
  }

  return readFileSync(ochiq, 'utf-8').trim()
}

// ---------------------------------------------------------------------------
// Config fayllar
// ---------------------------------------------------------------------------

/**
 * Boshqariladigan config'ni bazadagi serverlar ro'yxatidan TO'LIQ qayta yozadi.
 * Haqiqat manbai baza — faylni qo'lda tahrirlash keyingi yozuvda yo'qoladi
 * (skilllardagi `.platforma/skills/` bilan bir xil qoida).
 *
 * `UserKnownHostsFile` + `accept-new` shu yerda: birinchi ulanishda host
 * kaliti so'ralmaydi (interaktiv prompt serverda osilib qolardi) va
 * foydalanuvchining ~/.ssh/known_hosts'iga ham tegilmaydi.
 */
export function boshqarilganConfigYoz(serverlar: Server[]): void {
  mkdirSync(sshIldizi(), { recursive: true, mode: 0o700 })

  const bosh =
    '# Platforma boshqaradigan fayl — QO\'LDA TAHRIRLAMANG.\n' +
    '# Har saqlashda bazadagi serverlar ro\'yxatidan to\'liq qayta yoziladi.\n'

  const bloklar = serverlar.map((s) =>
    [
      `Host ${s.name}`,
      `  HostName ${s.host}`,
      `  User ${s.username}`,
      `  Port ${s.port}`,
      `  IdentityFile ${kalitYoli()}`,
      '  IdentitiesOnly yes',
      `  UserKnownHostsFile ${knownHostsYoli()}`,
      '  StrictHostKeyChecking accept-new',
    ].join('\n'),
  )

  writeFileSync(boshqarilganConfigYoli(), `${bosh}\n${bloklar.join('\n\n')}\n`, { mode: 0o600 })
}

/**
 * ~/.ssh/config boshiga `Include` qatorini qo'shadi (bir marta).
 *
 * AYNAN BOSHIGA: OpenSSH'da `Include` biror `Host` blokidan KEYIN kelsa,
 * o'sha blokning ichiga tegishli bo'lib qoladi va global ishlamaydi.
 * Mavjud tarkib o'zgarishsiz pastda qoladi.
 */
export function includeTaminla(): void {
  const yol = userSshConfigYoli()
  const qator = `Include ${boshqarilganConfigYoli()}`

  const mavjud = existsSync(yol) ? readFileSync(yol, 'utf-8') : ''
  if (mavjud.split('\n').some((q) => q.trim() === qator)) return

  mkdirSync(dirname(yol), { recursive: true, mode: 0o700 })
  const izoh = '# Platforma serverlari (avtomatik qo\'shilgan qator)\n'
  writeFileSync(yol, `${izoh}${qator}\n\n${mavjud}`)
  chmodSync(yol, 0o600)
}

// ---------------------------------------------------------------------------
// Kalitni serverga joylash
// ---------------------------------------------------------------------------

/** Umumiy ssh opsiyalari — joylash bosqichida server hali config'da yo'q */
function ulanishOpsiyalari(port: number): string[] {
  return [
    '-o', 'ConnectTimeout=10',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', `UserKnownHostsFile=${knownHostsYoli()}`,
    '-p', String(port),
  ]
}

/**
 * Ochiq kalitni masofadagi userning authorized_keys'iga qo'shadigan skript.
 * Idempotent: kalit bor bo'lsa qayta yozilmaydi (grep -qxF).
 * Kalit matni ed25519 uchun faqat [A-Za-z0-9+/= -] belgilardan iborat —
 * bitta qo'shtirnoq ichida xavfsiz.
 */
function joylashSkripti(ochiqKalit: string): string {
  return (
    'mkdir -p ~/.ssh && chmod 700 ~/.ssh && ' +
    'touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && ' +
    `{ grep -qxF '${ochiqKalit}' ~/.ssh/authorized_keys || echo '${ochiqKalit}' >> ~/.ssh/authorized_keys; }`
  )
}

export interface JoylashManzil {
  host: string
  port: number
  username: string
}

/**
 * Platforma ochiq kalitini serverga joylaydi.
 *
 * Tartib:
 *   1) parolsiz urinish — foydalanuvchining mavjud kalitlari (ssh-agent,
 *      ~/.ssh/id_*) allaqachon kira olsa, parol umuman kerak emas;
 *   2) parol berilgan bo'lsa — sshpass orqali bir martalik autentifikatsiya.
 *
 * Muvaffaqiyatsiz bo'lsa foydalanuvchiga ko'rsatiladigan aniq xato tashlaydi.
 */
export async function kalitJoyla(manzil: JoylashManzil, parol?: string): Promise<void> {
  const ochiqKalit = await kalitTaminla()
  const skript = joylashSkripti(ochiqKalit)
  const nishon = `${manzil.username}@${manzil.host}`

  // 1) Mavjud kalitlar bilan urinish. BatchMode — parol so'ramasin (prompt
  // server jarayonida javobsiz osilib qolardi).
  const kalitBilan = await bajaruvchi([
    'ssh',
    '-o', 'BatchMode=yes',
    ...ulanishOpsiyalari(manzil.port),
    nishon,
    skript,
  ])
  if (kalitBilan.kod === 0) return

  if (!parol) {
    throw new Error(
      `Mavjud SSH kalitlaringiz bilan ${nishon} ga kirib bo'lmadi. ` +
        `Parol kiriting yoki kalitingizni serverga oldindan joylang. ` +
        `(ssh: ${kalitBilan.stderr.trim().split('\n').pop() ?? 'nomalum xato'})`,
    )
  }

  // 2) Parol bilan — sshpass talab qilinadi.
  if (!Bun.which('sshpass')) {
    throw new Error(
      "Parol bilan ulanish uchun 'sshpass' o'rnatilgan bo'lishi kerak " +
        '(brew install sshpass yoki apt install sshpass).',
    )
  }

  // Parol SSHPASS env orqali (-e): argv'da ko'rinmaydi, `ps` ham ko'rmaydi.
  const parolBilan = await bajaruvchi(
    [
      'sshpass',
      '-e',
      'ssh',
      '-o', 'NumberOfPasswordPrompts=1',
      '-o', 'PubkeyAuthentication=no',
      ...ulanishOpsiyalari(manzil.port),
      nishon,
      skript,
    ],
    { env: { SSHPASS: parol } },
  )
  if (parolBilan.kod !== 0) {
    const sabab = parolBilan.stderr.trim().split('\n').pop() ?? ''
    if (parolBilan.kod === 5 || /denied/i.test(sabab)) {
      throw new Error(`Parol noto'g'ri yoki ${nishon} parol bilan kirishga ruxsat bermaydi.`)
    }
    throw new Error(`${nishon} ga ulanib bo'lmadi: ${sabab || `chiqish kodi ${parolBilan.kod}`}`)
  }
}

// ---------------------------------------------------------------------------
// Tekshirish va metrika
// ---------------------------------------------------------------------------

/**
 * Boshqariladigan config orqali parolsiz ulanishni tasdiqlaydi.
 * `-F` bilan FAQAT platforma config'i o'qiladi — foydalanuvchining shaxsiy
 * sozlamalari (ProxyJump va h.k.) platforma xulq-atvoriga aralashmaydi.
 */
export async function ulanishniTekshir(nom: string): Promise<void> {
  const n = await bajaruvchi([
    'ssh',
    '-F', boshqarilganConfigYoli(),
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=8',
    nom,
    'true',
  ])
  if (n.kod !== 0) {
    throw new Error(n.stderr.trim().split('\n').pop() ?? `ssh chiqish kodi ${n.kod}`)
  }
}

/**
 * Bitta SSH chaqiruvi bilan hamma metrika. Chiqish qatorlari KEY=value
 * ko'rinishida — parser tartibga bog'lanmaydi, yetishmagan qator metrika
 * maydonini shunchaki bo'sh qoldiradi.
 */
const METRIKA_SKRIPTI = [
  `echo "UPTIME=$(uptime -p 2>/dev/null || uptime)"`,
  `echo "LOAD=$(cut -d' ' -f1 /proc/loadavg 2>/dev/null)"`,
  `echo "NPROC=$(nproc 2>/dev/null || echo 1)"`,
  `free -b 2>/dev/null | awk '/^Mem:/{print "RAM="$2" "$3}'`,
  `df -kP / 2>/dev/null | awk 'NR==2{print "DISK="$2" "$3}'`,
].join('; ')

/** "up 3 days, 4 hours" → "3 kun 4 soat" — inglizcha chiqishni tarjima qiladi */
function uptimeTarjima(xom: string): string {
  return xom
    .replace(/^up\s+/, '')
    .replace(/(\d+)\s+weeks?/g, '$1 hafta')
    .replace(/(\d+)\s+days?/g, '$1 kun')
    .replace(/(\d+)\s+hours?/g, '$1 soat')
    .replace(/(\d+)\s+minutes?/g, '$1 daqiqa')
    .replace(/,/g, '')
    .trim()
}

function foiz(band: number, jami: number): number | undefined {
  if (!Number.isFinite(band) || !Number.isFinite(jami) || jami <= 0) return undefined
  return Math.min(100, Math.max(0, Math.round((band / jami) * 100)))
}

/** METRIKA_SKRIPTI chiqishini ServerMetrika'ga aylantiradi (testlar uchun alohida) */
export function metrikaTahlil(stdout: string): ServerMetrika {
  const q = new Map<string, string>()
  for (const qator of stdout.split('\n')) {
    const i = qator.indexOf('=')
    if (i > 0) q.set(qator.slice(0, i), qator.slice(i + 1).trim())
  }

  const m: ServerMetrika = { holat: 'ulangan' }

  const uptime = q.get('UPTIME')
  if (uptime) m.uptime = uptimeTarjima(uptime)

  const load = Number(q.get('LOAD'))
  const nproc = Number(q.get('NPROC'))
  if (Number.isFinite(load) && Number.isFinite(nproc) && nproc > 0) {
    m.cpu = Math.min(100, Math.max(0, Math.round((load / nproc) * 100)))
  }

  const ram = q.get('RAM')?.split(' ').map(Number)
  if (ram?.length === 2) m.ram = foiz(ram[1]!, ram[0]!)

  const disk = q.get('DISK')?.split(' ').map(Number)
  if (disk?.length === 2) m.disk = foiz(disk[1]!, disk[0]!)

  return m
}

/** Serverning jonli holatini o'qiydi. Ulanib bo'lmasa holat='xato' qaytadi (throw EMAS). */
export async function metrikaOl(nom: string): Promise<ServerMetrika> {
  let n: BuyruqNatija
  try {
    n = await bajaruvchi([
      'ssh',
      '-F', boshqarilganConfigYoli(),
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=8',
      nom,
      METRIKA_SKRIPTI,
    ])
  } catch (xato) {
    return { holat: 'xato', xato: xato instanceof Error ? xato.message : String(xato) }
  }

  if (n.kod !== 0) {
    return {
      holat: 'xato',
      xato: n.stderr.trim().split('\n').pop() ?? `ssh chiqish kodi ${n.kod}`,
    }
  }

  return metrikaTahlil(n.stdout)
}
