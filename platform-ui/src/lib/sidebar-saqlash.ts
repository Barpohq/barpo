// Sidebar'dagi Chat accordion'ining ochiq/yopiq holati.
//
// Brauzerda saqlanadi: foydalanuvchi ro'yxatni ochib qo'ysa, keyingi
// tashrifda ham ochiq turishi kerak. Boshlang'ich qiymat — YOPIQ: sidebar
// birinchi ko'rinishda ixcham bo'lsin.

const SAQLASH_KALITI = 'platforma:sidebar-suhbatlar'

export function suhbatlarOchiqmi(): boolean {
  try {
    return localStorage.getItem(SAQLASH_KALITI) === '1'
  } catch {
    // localStorage o'chirilgan — yopiq holatda qolamiz
    return false
  }
}

export function suhbatlarHolatiniSaqla(ochiq: boolean): void {
  try {
    localStorage.setItem(SAQLASH_KALITI, ochiq ? '1' : '0')
  } catch {
    // localStorage o'chirilgan bo'lishi mumkin — kritik emas
  }
}
