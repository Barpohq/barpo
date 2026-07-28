// Oxirgi tanlangan modelni brauzerda eslab qolish.
//
// Alohida faylda, chunki komponent faylidan funksiya eksport qilinsa
// React Fast Refresh ishlamay qoladi (oxlint shuni ogohlantiradi).

const SAQLASH_KALITI = 'platforma:model'

export interface SaqlanganModel {
  provider: string
  model: string
}

export function saqlangandanOqi(): SaqlanganModel | null {
  try {
    const xom = localStorage.getItem(SAQLASH_KALITI)
    if (!xom) return null
    const q = JSON.parse(xom) as { provider?: unknown; model?: unknown }
    if (typeof q.provider === 'string' && typeof q.model === 'string') {
      return { provider: q.provider, model: q.model }
    }
  } catch {
    // buzuq qiymat yoki localStorage o'chirilgan — e'tiborsiz
  }
  return null
}

export function modelniSaqla(tanlov: SaqlanganModel): void {
  try {
    localStorage.setItem(SAQLASH_KALITI, JSON.stringify(tanlov))
  } catch {
    // localStorage o'chirilgan bo'lishi mumkin — kritik emas
  }
}
