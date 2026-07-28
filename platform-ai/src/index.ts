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
  oxirgiUserIndeksi,
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

// --- Loyiha konteksti: ish papkasidagi AGENTS.md / CLAUDE.md ---

export {
  KONTEKST_CHEGARASI,
  KONTEKST_FAYLLARI,
  kontekstniPromptga,
  loyihaKontekstiniOqi,
  type LoyihaKonteksti,
} from './loyiha-konteksti.ts'

// --- Skilllar: SKILL.md tahlili va promptga ulash ---

export {
  NOM_CHEGARASI,
  skillFayliniTahlil,
  TAVSIF_CHEGARASI,
  type SkillFayl,
} from './skill-fayl.ts'

export {
  SKILL_PAPKASI,
  SKILL_SONI_CHEGARASI,
  skilllarniOqi,
  skilllarniPromptga,
  type YuklanganSkill,
} from './skill-yuklash.ts'

// --- Kontekst: tool natijalari saqlanishi va siqish ---

export {
  eskilarniTashla,
  kesishNuqtasi,
  kontekstniQur,
  kontekstTokenlari,
  siq,
  siqishKerakmi,
  toolNatijalariniQisqart,
  type SaqlanganXabar,
  type SiqishNatijasi,
  type SiqishSozlamalari,
  type TarixSozlamalari,
} from './kontekst.ts'

// --- Tool hook'lari ---

export {
  keyinZanjiri,
  kuzatuvHooki,
  maxfiyniYashirHooki,
  oldinZanjiri,
  qoshimchaTaqiqHooki,
  uzunlikHooki,
  type KeyinNatijasi,
  type OldinNatijasi,
  type ToolChaqiruvKonteksti,
  type ToolHooki,
  type ToolNatijaKonteksti,
} from './hooklar.ts'

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
  rejimBoshqaruvchilarSoni,
  rejimBoshqaruvchisi,
  rejimBoshqaruvchisiniYop,
  rejimlarniTozala,
  type RejimKuzatuvchi,
  type RejimOzgarishi,
} from './rejim.ts'

export {
  ChegaralanganMuhit,
  STANDART_BUYRUQ_TIMEOUT_MS,
  type ChegaralanganMuhitSozlamalari,
} from './muhit.ts'

export {
  RUXSAT_KUTISH_MS,
  RuxsatBoshqaruvchi,
  ruxsatBoshqaruvchilarSoni,
  ruxsatBoshqaruvchisi,
  ruxsatBoshqaruvchisiniYop,
  ruxsatlarniTozala,
  type KlassifikatorKonteksti,
  type QarorKuzatuvchi,
  type RuxsatSorash,
  type SorovKuzatuvchi,
} from './ruxsat.ts'

export {
  REESTR_CHEGARASI,
  REESTR_TTL_MS,
  SessiyaReestri,
  type Yopiladigan,
} from './reestr.ts'

// --- Qidiruv tool'lari: grep / find / ls ---

export {
  chegaraniTekshir,
  FIND_CHEGARASI,
  globMosKeladimi,
  globniRegexpga,
  GREP_CHEGARASI,
  ichkarimi,
  ikkilikmi,
  LS_CHEGARASI,
  moslikTartibi,
  nisbiyYol,
  QATOR_CHEGARASI,
  qatorniTayyorla,
  rgKeshiniOrnat,
  rgMavjudmi,
  TASHLANADIGAN_PAPKALAR,
  yolTartibi,
  type ChegaraNatijasi,
  type GrepMosligi,
  type PapkaElementi,
  type QidiruvNatijasi,
} from './qidiruv-asos.ts'

export {
  ChegaraXatosi,
  findNode,
  findQidir,
  findRg,
  grepNode,
  grepQidir,
  grepRg,
  lsRoyxat,
  NaqshXatosi,
  type FindSozlamalari,
  type GrepSozlamalari,
  type LsSozlamalari,
} from './qidiruv-motor.ts'

export {
  findNatijasiniMatnga,
  findToolYarat,
  grepNatijasiniMatnga,
  grepToolYarat,
  lsNatijasiniMatnga,
  lsToolYarat,
  olchamniMatnga,
  QIDIRUV_PROMPT_QISMI,
  qidiruvToollari,
  qidiruvToollariXom,
  type FindToolKirishi,
  type GrepToolKirishi,
  type LsToolKirishi,
  type QidiruvTafsiloti,
  type QidiruvTooli,
} from './qidiruv-toollari.ts'
