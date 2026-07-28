// Sana formatlash — suhbatlar ro'yxati uchun.
//
// Sof funksiyalar: "hozir" tashqaridan beriladi (`hozirgi` argumenti), shuning
// uchun test qilinadi va vaqt o'tishiga bog'liq emas.

/** Bir kun, millisekundda */
const KUN = 24 * 60 * 60 * 1000

/**
 * Suhbat qaysi guruhga tushadi.
 *
 * KALENDAR kuni bo'yicha, "24 soat ichida" emas: kecha 23:00 dagi suhbat
 * bugun 01:00 da ham "Kecha" bo'lib qolishi kerak, "Bugun" emas.
 */
export type SanaGuruhi = 'Bugun' | 'Kecha' | 'Shu hafta' | 'Bu oy' | 'Eskiroq'

/** Kunning boshlanishi (mahalliy vaqt zonasi bo'yicha) */
function kunBoshi(sana: Date): number {
  return new Date(sana.getFullYear(), sana.getMonth(), sana.getDate()).getTime()
}

export function sanaGuruhi(iso: string, hozirgi: Date = new Date()): SanaGuruhi {
  const sana = new Date(iso)
  // Buzuq sana ro'yxatni yiqitmasin — eng pastki guruhga tushadi
  if (Number.isNaN(sana.getTime())) return 'Eskiroq'

  // Farq KUN'larda: ikkala sana ham kun boshiga keltirilgani uchun bu har
  // doim butun son (yozgi vaqt o'tishlarida yaxlitlash to'g'rilaydi).
  const kunlar = Math.round((kunBoshi(hozirgi) - kunBoshi(sana)) / KUN)
  // Kelajakdagi sana (soat noto'g'ri qo'yilgan bo'lsa) — "Bugun" deb qaraymiz
  if (kunlar <= 0) return 'Bugun'
  if (kunlar === 1) return 'Kecha'
  if (kunlar < 7) return 'Shu hafta'
  if (kunlar < 30) return 'Bu oy'
  return 'Eskiroq'
}

/** Guruhlar ro'yxatda shu tartibda ko'rinadi */
export const GURUH_TARTIBI: SanaGuruhi[] = ['Bugun', 'Kecha', 'Shu hafta', 'Bu oy', 'Eskiroq']

/**
 * Qisqa nisbiy vaqt: "hozir", "5 daq", "3 soat", "12 iyul".
 *
 * Ro'yxatda har qatorning o'ng chekkasida turadi — shuning uchun imkon
 * qadar qisqa.
 */
export function qisqaVaqt(iso: string, hozirgi: Date = new Date()): string {
  const sana = new Date(iso)
  if (Number.isNaN(sana.getTime())) return ''

  const daqiqa = Math.floor((hozirgi.getTime() - sana.getTime()) / 60000)
  if (daqiqa < 1) return 'hozir'
  if (daqiqa < 60) return `${daqiqa} daq`

  const soat = Math.floor(daqiqa / 60)
  if (soat < 24) return `${soat} soat`

  const kun = Math.floor(soat / 24)
  if (kun < 7) return `${kun} kun`

  // Bir haftadan oshgach aniq sana o'qish osonroq: "12 iyul"
  const oylar = [
    'yanv', 'fev', 'mart', 'apr', 'may', 'iyun',
    'iyul', 'avg', 'sent', 'okt', 'noyab', 'dek',
  ]
  const oy = oylar[sana.getMonth()] ?? ''
  // Boshqa yil bo'lsa yilni ham ko'rsatamiz
  return sana.getFullYear() === hozirgi.getFullYear()
    ? `${sana.getDate()} ${oy}`
    : `${sana.getDate()} ${oy} ${sana.getFullYear()}`
}
