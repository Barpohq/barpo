// @platforma/ai — platformaning AI qatlami.
//
// Server bu paketdan faqat ikkita narsani ishlatadi:
//   modellarniAniqla()  — PC'da qaysi providerlar ishlatishga tayyor
//   suhbatOqimi()       — tanlangan model bilan streaming javob
//
// Barcha provider tafsilotlari (kalitlar, OAuth, Ollama) shu paket ichida
// qoladi — server ularni bilmaydi. Keyingi bosqichda tool'lar ham shu yerga
// qo'shiladi.

export {
  keshdagiNatija,
  keshniTozala,
  modellarniAniqla,
  modelsKolleksiyasi,
  STANDART_KREDENSIAL_YOLI,
  type AniqlashNatijasi,
  type AniqlashSozlamalari,
} from './aniqlash.ts'

export { FaylKredensialOmbori, XotiraKredensialOmbori } from './kredensial.ts'

export {
  claudeCodeAuth,
  codexAuth,
  mahalliyAuthlar,
  type MahalliyNatija,
  type MahalliyTopilma,
} from './mahalliy-auth.ts'

export {
  OLLAMA_ID,
  OLLAMA_MANBA,
  ollamaManzili,
  ollamaModellari,
  ollamaProvider,
} from './ollama.ts'

export {
  STANDART_SISTEM_PROMPT,
  suhbatOqimi,
  type Sarflov,
  type SuhbatHodisasi,
  type SuhbatSozlamalari,
  type SuhbatXabari,
} from './suhbat.ts'

// --- Tool ishlatadigan agent qatlami ---

export {
  AGENT_SISTEM_PROMPT,
  agentOqimi,
  klassifikatorTarixi,
  type AgentHodisasi,
  type AgentSozlamalari,
} from './agent.ts'

export {
  buyruqNomi,
  buyruqRoyxatlari,
  buyruqniBahola,
  buyruqniBolaklarga,
  taqiqlanganmi,
  type BuyruqBahosi,
  type BuyruqToifasi,
} from './buyruq-tahlil.ts'

export { chegaraMi, chegaralarniAjrat } from './chegara.ts'

export {
  amalniBahola,
  KLASSIFIKATOR_PROMPT,
  KLASSIFIKATOR_TIMEOUT_MS,
  klassifikatorModeliniTanla,
  sorovniMatnga,
  type KlassifikatorNatijasi,
  type KlassifikatorSorovi,
  type KlassifikatorXabari,
} from './klassifikator.ts'

export {
  JAMI_BLOK_CHEGARASI,
  KETMA_KET_BLOK_CHEGARASI,
  RejimBoshqaruvchi,
  rejimBoshqaruvchisi,
  rejimBoshqaruvchisiniYop,
  rejimlarniTozala,
  type RejimKuzatuvchi,
  type RejimOzgarishi,
} from './rejim.ts'

export { ChegaralanganMuhit, type ChegaralanganMuhitSozlamalari } from './muhit.ts'

export {
  RUXSAT_KUTISH_MS,
  RuxsatBoshqaruvchi,
  ruxsatBoshqaruvchisi,
  ruxsatBoshqaruvchisiniYop,
  ruxsatlarniTozala,
  type KlassifikatorKonteksti,
  type QarorKuzatuvchi,
  type RuxsatSorash,
  type SorovKuzatuvchi,
} from './ruxsat.ts'
