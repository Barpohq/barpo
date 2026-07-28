// @platforma/config — platformaning sozlamalar qatlami.
//
// Ishlatish:
//
//   import { config } from '@platforma/config'
//   const { config: sozlama, ogohlantirishlar } = config({ ishPapkasi })
//   sozlama.agent.siqish.zaxiraTokenlar   // → 16384
//
// Config o'qish HECH QACHON xato tashlamaydi: fayl yo'q, buzuq yoki noto'g'ri
// qiymatli bo'lsa standart qiymatlar ishlaydi va sabab `ogohlantirishlar` ga
// tushadi. Platforma har doim ishga tushadi.

export {
  MAYDONLAR,
  type Config,
  type MaydonTarifi,
  type MaydonTuri,
  type QismanConfig,
} from './sxema.ts'

export {
  configlarniBirlashtir,
  configniTekshir,
  maydonniTekshir,
  standartConfig,
  yoldanOqi,
  yolgaYoz,
  type ConfigOgohlantirish,
  type TekshiruvNatijasi,
} from './tekshir.ts'

export {
  CONFIG_FAYLI,
  LOYIHA_PAPKASI,
  config,
  configniOqi,
  configniYangila,
  faylniOqi,
  globalConfigPapkasi,
  loyihaChekloviniQoll,
  type ConfigNatijasi,
  type OqishSozlamalari,
} from './oqish.ts'

export { schemaYasa } from './schema-yasa.ts'
