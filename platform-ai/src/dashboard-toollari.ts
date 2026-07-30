// `appPublish` tool'i — agent dinamik dashboard chiqaradigan YAGONA yo'l.
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ ASOSIY QOIDA: AGENT API YOZMAYDI.                                    │
// │                                                                      │
// │ Dashboard uchun agentga endpoint yozdirish jozibali ko'rinadi        │
// │ ("o'zi route qo'shsin"), lekin bu ikki narsani buzardi:              │
// │   1) Har dashboard serverga YANGI KOD qo'shardi — ya'ni AI xatosi    │
// │      butun platformani yiqitishi mumkin bo'lardi.                    │
// │   2) O'sha kod bazaga va ichki tarmoqqa to'liq kirish olardi.        │
// │                                                                      │
// │ Shuning uchun oqim TESKARI: agent MA'LUMOTNI shu tool'ga beradi,     │
// │ platforma esa uni saqlaydi va ko'rsatadi. Yozish nuqtasi bitta,      │
// │ tekshiruv ham bitta joyda.                                           │
// └──────────────────────────────────────────────────────────────────────┘
//
// UCH TURDAGI KOD, IKKI JOYDA BAJARILADI:
//
//   `view`        — JSX. Brauzerda, host React daraxtida render bo'ladi
//                   (`AiKorinish.tsx`). Asosan CHIZADI; boshqaruv bo'lsa
//                   `ui.saqla`/`ui.amal` orqali O'Z ilovasiga yozadi.
//
//   `states`      — server JS. Platforma jarayonida, interval bo'yicha
//                   qayta-qayta bajariladi (`state-bajar.ts`). AYNAN SHU
//                   qatlam ma'lumot yig'adi.
//
//   `sozlamalar`  — server JS. Foydalanuvchi bosganda BIR MARTA
//   va `amallar`    bajariladi (`amal-bajar.ts`) va auditga tushadi.
//
// Hammasi platformaning huquqi bilan ishlaydi — bu ONGLI qaror. Keyingi
// bosqichda bir xil klassifikator tekshiradi (prompt injection himoyasi);
// ulanish nuqtalari `state-bajar.ts` dagi `kodniTekshir()`, `amal-bajar.ts`
// dagi `amalKodiniTekshir()` va `view-qurish.ts` dagi
// `taqiqlanganlarniTop()`.
//
// FOYDALANUVCHI KIRISHI — BOSHQARUV QATLAMINING YANGI XAVFI. `states` da
// kirish YO'Q edi, `sozlamalar` da BOR (token, konteyner nomi). Shuning
// uchun kodga `exec` berilmaydi: u tor `ssh` obyektini oladi
// (`ilova-ssh.ts`), u esa argv massivini majburlaydi va sirni stdin orqali
// uzatadi. Ya'ni AI NIMA qilishni aytadi, QANDAY bajarilishini platforma
// biladi.
//
// QATLAM CHEGARASI — `server-toollari.ts` dagi bilan bir xil inversiya.
// Manifestlar SQLite'da, ya'ni `platform-server` da. `@platforma/ai` esa
// serverga BOG'LIQ EMAS, shuning uchun saqlash funksiyasi tashqaridan
// beriladi (`DashboardManbasi`). Bu fayl bazani ham, `repo.ts` ni ham
// bilmaydi.
//
// NEGA RUXSAT SO'RAMAYDI. Tool foydalanuvchining O'Z platformasida, uning
// O'ZI so'ragan dashboardni chiqaradi — bu `write` tool'i bilan bir xil
// toifadagi amal emas: fayl tizimiga tegmaydi, buyruq bajarmaydi, tarmoqqa
// chiqmaydi. Natija darhol ko'rinadi va qaytarib olsa bo'ladi (qayta
// publish). Har chiqarish uchun modal ko'rsatish "ruxsat charchog'i" ga
// olib kelardi.

import { Type, type Static } from 'typebox'
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core'
import type { QidiruvTooli } from './qidiruv-toollari.ts'

/**
 * Saqlash natijasi — chaqiruvchi (server) shu shaklda javob beradi.
 *
 * Xato TASHLASH o'rniga natija QAYTARILADI: agentga xatoni MATN sifatida
 * ko'rsatish kerak, shunda u o'zi tuzatib qayta urinadi. Tashlangan xato
 * esa tool chaqiruvini uzib, modelga tushunarsiz holat qoldirardi.
 */
export interface DashboardNatijasi {
  ok: boolean
  /** Rad etilgan bo'lsa — sabablar. Agent shu matnni o'qib tuzatadi. */
  xatolar?: string[]
  /** Qabul qilindi, lekin biror qism tashlandi/o'zgartirildi */
  ogohlantirishlar?: string[]
  /** Yangi ilova yaratildimi yoki mavjudi yangilandimi */
  yangi?: boolean
}

/**
 * Manifestni saqlaydigan manba (chaqiruvchi tomondan beriladi).
 *
 * Kirish ATAYLAB `unknown`: tekshiruv chegarada — server tomonida —
 * bo'ladi (`manifestniTekshir`). Agar bu yerda tiplansa, model yuborgan
 * xom JSON'ni tool ichida kastlashga majbur bo'lardik va tekshiruv ikki
 * joyda takrorlanardi.
 */
export type DashboardManbasi = (manifest: unknown) => DashboardNatijasi | Promise<DashboardNatijasi>

/** UI va loglar uchun tafsilot — tool kartasida ko'rinadi */
export interface DashboardTafsiloti {
  appId: string
  ok: boolean
  vidjetlar: number
  kodBor: boolean
  /** Sozlama maydonlari soni — 0 bo'lsa forma yo'q */
  sozlamalar: number
  /** Amal tugmalari soni */
  amallar: number
}

/**
 * Vidjet sxemasi ATAYLAB `Type.Any()` bilan ochiq qoldirilgan.
 *
 * Sabab: `Widget` — 7 variantli diskriminatsiyalangan union. Uni JSON
 * Schema'da to'liq yozish tool tavsifini bir necha yuz qatorga cho'zardi va
 * har so'rovda kontekstga tushardi. Buning o'rniga shakl SKILL faylida
 * misollar bilan tushuntiriladi (progressive disclosure — model kerak
 * bo'lganda o'qiydi), tekshiruv esa `manifest-tekshir.ts` da qat'iy
 * bajariladi. Ya'ni erkinlik sxemada, qat'iylik chegarada.
 */
const appPublishSxemasi = Type.Object({
  id: Type.String({
    description:
      'Stable app id: lowercase letters, digits and dashes only (e.g. "ai-news-bot"). ' +
      'Publishing again with the same id REPLACES the previous dashboard.',
  }),
  name: Type.String({ description: 'Display name shown as the page title' }),
  icon: Type.Optional(Type.String({ description: 'A single emoji shown next to the name' })),
  tagline: Type.Optional(Type.String({ description: 'One-line description under the title' })),
  version: Type.Optional(Type.String({ description: 'Version label, e.g. "v1.4.2"' })),
  service: Type.Optional(
    Type.String({ description: 'Runtime line, e.g. "helsinki-1 · docker · uptime 31 kun"' }),
  ),
  status: Type.Optional(
    Type.Union([Type.Literal('running'), Type.Literal('idle')], {
      description: 'Status dot next to the title',
    }),
  ),
  widgets: Type.Optional(
    Type.Array(Type.Any(), {
      description:
        'Built-in widgets rendered by the platform. Each item is an object with a "type" field: ' +
        'stats | bars | table | logs | note | deploy | git. ' +
        'Read the dashboard skill for the exact shape of each type.',
    }),
  ),
  data: Type.Optional(
    Type.Object(
      {},
      {
        additionalProperties: true,
        description:
          'Values the dashboard shows, as a one-time snapshot. They arrive as the `data` prop ' +
          'and NEVER change again — for anything that updates over time use `states` instead. ' +
          'Never write an API or a fetch: the view only renders.',
      },
    ),
  ),
  states: Type.Optional(
    Type.Array(
      Type.Object({
        nom: Type.String({
          description:
            'State key: lowercase letters, digits and underscore (e.g. "cpu", "disk_usage"). ' +
            'The value lands in `data[nom]`.',
        }),
        kod: Type.String({
          description:
            'Server-side JS: `module.exports = async function () { return {...} }`. ' +
            'Runs in the platform process — `require("child_process")`, `fs` and the network are ' +
            'available. Return the values themselves, NOT a rendered layout.',
        }),
        interval: Type.Optional(
          Type.Number({
            description:
              'Refresh interval in seconds. Omit for values that never change. ' +
              'Pick per state: a CPU reading may need 5, a disk total 30 or more. ' +
              'Minimum enforced is 3.',
          }),
        ),
      }),
      {
        description:
          'LIVE data sources, each refreshed on its OWN interval. Use these whenever a value ' +
          'changes over time — otherwise the dashboard shows a frozen snapshot forever. ' +
          'You do NOT write an endpoint: the platform already serves them at ' +
          '/api/apps/:id/state/:nom and the page polls that.',
      },
    ),
  ),
  view: Type.Optional(
    Type.String({
      description:
        'OPTIONAL custom view as JSX source. Must `export default function View({ data, ui }) {...}`. ' +
        'Platform components arrive as `ui` (ui.Card, ui.StatTile, ui.StatusDot) and Tailwind classes ' +
        'work, so the page matches the rest of the UI. React hooks are available directly ' +
        '(useState, useEffect, ...) — no imports. The view only RENDERS: no fetch, no storage; ' +
        'changing values belong in `states`. When the app has `sozlamalar` or `amallar`, the view ' +
        'additionally gets `ui.amal(nom)` and `ui.saqla({...})` to trigger them — those are the ' +
        'ONLY way it may write anything. Use this only when the built-in widgets cannot ' +
        'express the layout — widgets are more robust.',
    }),
  ),
  sozlamalar: Type.Optional(
    Type.Object(
      {
        maydonlar: Type.Array(Type.Any(), {
          description:
            'Form fields. Each: { kalit, turi, yorliq, izoh?, majburiy?, standart?, variantlar?, ' +
            'naqsh?, naqshIzohi? }. `turi` is one of: matn | sir | raqam | tanlov | kalit | kopMatn. ' +
            'Use `sir` for tokens and passwords — the platform never shows or returns them. ' +
            'Add `naqsh` (a regex string) whenever the value has a known format, e.g. a Telegram ' +
            'token: "^\\\\d+:[A-Za-z0-9_-]+$". Read the dashboard skill for the exact shape.',
        }),
        yoz: Type.String({
          description:
            'Server-side JS that writes the values to the APP ITSELF on its server: ' +
            '`module.exports = async function ({ qiymatlar, ssh }) { ... }`. ' +
            'Use `ssh(serverNomi)` to reach the server, then `envYoz(path, {KEY: value})` to update ' +
            'its config and `buyruq([...])` to restart it. NEVER build a shell string — ' +
            '`buyruq` takes an ARGV ARRAY, and `envYoz` sends values over stdin so tokens never ' +
            'appear in `ps`. Only keys the user actually changed arrive in `qiymatlar`.',
        }),
        oqi: Type.Optional(
          Type.String({
            description:
              'OPTIONAL server-side JS returning the CURRENT values so the form opens filled in: ' +
              '`module.exports = async function ({ ssh }) { return { rejim: "polling" } }`. ' +
              'For a SECRET field return a BOOLEAN, not the value — `{ token: Boolean(cfg.TOKEN) }`. ' +
              'That tells the platform to show "already set" without the token ever reaching the ' +
              'browser. If you return the secret itself the platform drops it.',
          }),
        ),
      },
      {
        description:
          'A settings FORM for this app. The platform renders it from this schema and writes the ' +
          'values to the app on its server — NOT to the platform database. This is how the user ' +
          'supplies a bot token, an admin id or a mode. You write no endpoint and no UI: the ' +
          'platform already serves PUT /api/apps/:id/sozlama.',
      },
    ),
  ),
  amallar: Type.Optional(
    Type.Array(Type.Any(), {
      description:
        'Buttons the user can press: restart, stop, clear cache. Each item is an object: ' +
        '{ nom, yorliq, izoh?, xavf?, tasdiq?, kod, yangila? }. `nom` is lowercase a-z0-9_ (it ' +
        'becomes a URL path). `kod` is server-side JS: ' +
        '`module.exports = async function ({ ssh, sozlama }) { ... return { xabar: "done" } }` — ' +
        'the returned `xabar` is shown to the user. Set `tasdiq: true` for anything the user ' +
        'should confirm first, and `xavf: "xavfli"` for destructive actions. List state names in ' +
        '`yangila` to refresh them right after the action (e.g. a status tile after a restart). ' +
        'Use `ssh(serverNomi).buyruq([...])` with an ARGV ARRAY — never a shell string.',
    }),
  ),
})

export type AppPublishKirishi = Static<typeof appPublishSxemasi>

/**
 * Natijani model o'qiydigan matnga aylantiradi.
 *
 * Rad etilganda xatolar RO'YXAT bo'lib beriladi va oxirida aniq harakat
 * ko'rsatiladi — model "nima qilay?" holatida qolmasin.
 */
export function natijaniMatnga(appId: string, n: DashboardNatijasi): string {
  if (!n.ok) {
    return [
      `Dashboard "${appId}" was REJECTED and nothing was saved.`,
      '',
      'Problems:',
      ...(n.xatolar ?? ['unknown error']).map((x) => `  - ${x}`),
      '',
      'Fix these and call appPublish again.',
    ].join('\n')
  }

  const qatorlar = [
    n.yangi
      ? `Dashboard "${appId}" published. It now appears in the sidebar under "Ilovalar".`
      : `Dashboard "${appId}" updated.`,
  ]

  if (n.ogohlantirishlar?.length) {
    qatorlar.push(
      '',
      'Accepted, but some parts were dropped or adjusted:',
      ...n.ogohlantirishlar.map((o) => `  - ${o}`),
      '',
      'Publish again if you want to correct them.',
    )
  }

  return qatorlar.join('\n')
}

/**
 * `appPublish` tool'ini yaratadi.
 *
 * Kontekst (`env.cwd`) BU TOOLGA KERAK EMAS — manifest ish papkasiga
 * bog'liq emas. Lekin `QidiruvTooli` shakli saqlanadi, chunki
 * `toollarniTayyorla()` hamma tool'ni bir xil o'ramdan o'tkazadi.
 */
export function appPublishToolYarat(
  manba: DashboardManbasi,
): QidiruvTooli<AppPublishKirishi, DashboardTafsiloti> {
  return {
    name: 'appPublish',
    label: 'appPublish',
    description: [
      'Publish or update a dashboard page for an app on this platform.',
      'The dashboard appears in the sidebar under "Ilovalar" and is rendered by the platform itself.',
      '',
      'You do NOT write an API, a route, or a server file for this — you pass the DATA here and the',
      'platform renders it. Publishing again with the same id replaces the previous version.',
      '',
      'Two ways to describe the page, and they can be combined:',
      '  - `widgets`: built-in blocks (stats, bars, table, logs, note, deploy, git) — robust, preferred.',
      '  - `view`: your own JSX, for layouts the widgets cannot express. It receives `data` plus',
      '    `ui` (platform components) and can use Tailwind classes. It only renders — no fetching.',
      '',
      'LIVE DATA: values passed in `data` are frozen forever. For anything that changes over time',
      '(CPU, memory, queue depth, last run) add a `states` entry instead — server-side code with its',
      'OWN refresh interval. Give each value the interval it actually needs: a CPU reading may want 5',
      'seconds while a disk total is fine at 60. You still write no endpoint — the platform serves',
      'them and the page polls automatically.',
      '',
      'CONTROL: a dashboard can also be a control panel.',
      '  - `sozlamalar`: a settings form (bot token, admin id, mode). The values are written to the',
      '    APP ITSELF on its server — a token lives in the app\'s own config, not in the platform.',
      '  - `amallar`: buttons the user presses (restart, stop). Each runs server-side code.',
      'Both take an `ssh` helper: `ssh(serverNomi).buyruq([...])` takes an ARGV ARRAY and',
      '`ssh(...).envYoz(path, {KEY: val})` sends values over stdin. NEVER assemble a shell string —',
      'user-supplied values would become commands, and a token would show up in `ps`.',
      '`buyruq` THROWS when the command fails, so you do not check the exit code — just return your',
      'success message after it. Use `buyruqXom` when a non-zero exit is an answer, not a failure.',
      '',
      'Read the dashboard skill before your first call — it has the exact widget shapes, the form',
      'field types and full examples.',
    ].join('\n'),
    parameters: appPublishSxemasi,
    async execute(
      _toolCallId: string,
      params: AppPublishKirishi,
    ): Promise<AgentToolResult<DashboardTafsiloti>> {
      // `view` tool sathida SATR (JSX manbasi), manifestda esa OBYEKT
      // (`{ kod, xash }`). Aylantirish shu yerda: modeldan ichma-ich obyekt
      // so'rash uni adashtiradi, kontrakt esa xashsiz to'liq bo'lmaydi.
      // Xashni server kompilyatsiya paytida qo'yadi.
      const manifest: Record<string, unknown> = { ...params }
      if (typeof params.view === 'string' && params.view.trim().length > 0) {
        manifest.view = { kod: params.view, xash: '' }
      } else {
        delete manifest.view
      }

      const natija = await manba(manifest)
      const vidjetlar = Array.isArray(params.widgets) ? params.widgets.length : 0

      return {
        content: [{ type: 'text', text: natijaniMatnga(params.id, natija) }],
        details: {
          appId: params.id,
          ok: natija.ok,
          vidjetlar,
          kodBor: typeof params.view === 'string' && params.view.trim().length > 0,
          sozlamalar: Array.isArray(params.sozlamalar?.maydonlar)
            ? params.sozlamalar.maydonlar.length
            : 0,
          amallar: Array.isArray(params.amallar) ? params.amallar.length : 0,
        },
        // Rad etilgan chaqiruv model uchun XATO bo'lib ko'rinishi kerak,
        // aks holda u "bajarildi" deb o'ylab davom etardi.
        isError: !natija.ok,
      }
    },
  }
}

/**
 * Dashboard tool'lari — kontekst biriktirilmagan xom shakl.
 *
 * Manba berilmagan bo'lsa BO'SH ro'yxat qaytadi: tool umuman e'lon
 * qilinmaydi, ya'ni agent uning borligini bilmaydi. (`serverToollariXom()`
 * bilan bir xil mantiq.)
 */
export function dashboardToollariXom(manba?: DashboardManbasi): QidiruvTooli<never>[] {
  if (!manba) return []
  return [appPublishToolYarat(manba)] as unknown as QidiruvTooli<never>[]
}

/**
 * Dashboard tool'lari — kontekst biriktirilgan shakl (testlar va to'g'ridan
 * ishlatish uchun; `agent.ts` xom shaklni o'zi o'raydi).
 */
export function dashboardToollari(manba?: DashboardManbasi): AgentTool<never>[] {
  return dashboardToollariXom(manba).map((tool) => ({
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: tool.parameters,
    execute: (toolCallId: string, params: never, signal?: AbortSignal, onUpdate?: never) =>
      tool.execute(toolCallId, params, signal, onUpdate, { env: { cwd: '' } }),
  })) as unknown as AgentTool<never>[]
}

/**
 * `AGENT_SISTEM_PROMPT` ga qo'shiladigan qism.
 *
 * `SERVER_PROMPT_QISMI` bilan bir xil sabab: tool xulqi va uni tavsiflovchi
 * matn BIR FAYLDA tursin.
 *
 * Prompt SHARTLI qo'shiladi (`agent.ts`): manba yo'q bo'lsa tool ham yo'q.
 */
export const DASHBOARD_PROMPT_QISMI = {
  royxat: [
    '- appPublish: publish or update an app dashboard page on this platform, including its',
    '  settings form and control buttons',
  ],
  qoida: [
    'When the user asks for a dashboard, a status page, or a UI for an app, use `appPublish` —',
    'do NOT write an HTTP endpoint, a route file, or a frontend file for it. The platform renders',
    'what you pass to the tool.',
    'Pass the values themselves in `data`; a custom `view` receives them as props and must not',
    'fetch anything — it only renders. Prefer the built-in widgets, and reach for `view` only',
    'when the layout genuinely needs it.',
    'Anything that changes over time belongs in `states` (server-side code, per-state refresh',
    'interval) — values in `data` alone never update again.',
    'When you deploy something the user will need to configure or control (a bot token, a restart',
    'button), publish `sozlamalar` and `amallar` along with the dashboard — that is what makes the',
    'page usable instead of just readable.',
    'Settings values are written to the DEPLOYED APP on its own server, never stored in the',
    'platform: the app reads its token from its own config, so that is where it must go.',
    'In `yoz`, `oqi` and `amallar[].kod`, reach the server ONLY through the provided `ssh` helper',
    'and pass commands as an ARGV ARRAY (`["docker","restart","bot"]`). Never assemble a shell',
    'string and never interpolate a user-supplied value into one — use `ssh(...).envYoz()` for',
    'config values so tokens travel over stdin instead of the command line.',
    'Never return a secret field from `oqi`.',
    'If a dashboard skill is installed, read it before the first call.',
  ],
} as const
