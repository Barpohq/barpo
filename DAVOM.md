# Qolgan joy — davom etish qo'llanmasi

_Oxirgi yangilanish: 2026-07-30. Boshqa kompyuterda davom etish uchun shu fayldan boshlang._

## Hozirgi holat

Mock demo'ni haqiqiy platformaga aylantirish jarayoni. Tanlangan yo'l: **haqiqiy
backend, Bun + TypeScript (Hono)**, AI qatlami `pi-agent-core` ustiga qurilgan
(pi — [earendil-works/pi](https://github.com/earendil-works/pi), terminal uchun
coding agent; biz shu g'oyalarni web uchun moslashtiramiz).

**Testlar:** 1559/1559 yashil (`bun test`). `platform-ui` `tsc --noEmit` toza;
`platform-server` da 5 ta eski xato qoldi (`isError` maydoni va test
`buyruqXom` — biriktirmalarga aloqasi yo'q, 9-bosqichda 36 dan 5 ga tushdi).

Ilgari qayd etilgan `muhit.test.ts` dagi 6 ta yiqilish TUZATILDI — sabab
`ChegaralanganMuhit` ish papkasini kanonizatsiya qilmasligi edi (macOS'da
`/var` → `/private/var` symlink, natijada ish papkasi ICHIDAGI fayl ham
"tashqarida" ko'rinardi). Bu skilllar uchun ham muhim: usiz agent har
`SKILL.md` o'qishda ruxsat so'rardi.

**Ish uslubi o'zgardi (2026-07-28):** "avval to'liq tizim, keyin sayqal"
rejasidan voz kechildi. Endi kerakli qism quriladi va ustida ko'ringan
xato/kamchiliklar tuzatib boriladi. Maqsad o'zgarmagan, yo'l o'zgardi —
pastdagi eski "Qolgan reja" endi majburiy tartib emas, g'oyalar zaxirasi.

### Paketlar

| Paket | Vazifa |
|---|---|
| `platform-shared` | umumiy tiplar + WS protokoli (discriminated union) |
| `platform-server` | Bun.serve + Hono + bun:sqlite (WAL), port **8787** |
| `platform-ai` | provider aniqlash, agent oqimi, tool'lar, xavfsizlik |
| `platform-config` | JSON + JSON Schema sozlamalar, global + loyiha qatlami |
| `platform-ui` | React + Vite, dev proxy `/api` va `/ws` → 8787 |

## Ishga tushirish

```bash
bun install
bun test                                     # 1559 test
bun run schema                               # config sxemasini qayta yasash
cd platform-server && bun run src/index.ts   # backend :8787
cd platform-ui && bun run dev                # UI
```

## Bajarilgan bosqichlar

1. ~~Poydevor: shared + server + proxy~~ ✅
2. ~~AI agent qatlami: tool'lar, ruxsat, model tanlash~~ ✅
3. ~~**Agent qatlamini pi darajasiga yetkazish**~~ ✅ (quyida)
4. ~~**Loyiha (project) mantig'i + background agentlar ko'rinishi**~~ ✅ (quyida)
5. ~~**Suhbatlar tarixi: sidebar ro'yxati + alohida sahifa**~~ ✅ (quyida)
6. ~~**Skilllar: GitHub manbadan o'rnatish va agentga ulash**~~ ✅ (quyida)
7. ~~**Serverlar: parolsiz SSH ulanish + jonli metrikalar**~~ ✅ (quyida)
8. ~~**Ishonchlilik: jim yo'qolgan xatolar + tool chaqiruvlarini saqlash**~~ ✅ (quyida)
9. ~~**Chatga fayl va rasm biriktirish (paste bilan)**~~ ✅ (quyida)

### 9-bosqichda nima qilindi (2026-07-30)

Chatga fayl va rasm biriktirish. Rasmni clipboard'dan `Ctrl+V` bilan qo'yish
ham ishlaydi — bu eng ko'p kerak bo'ladigan yo'l (screenshot olib darhol
tashlash).

**ASOSIY QAROR: rasm ham FAYL.** Rasm base64 bo'lib `prompt()` ga
uzatilmaydi. U ham oddiy fayl kabi diskka yoziladi, promptga faqat YO'L
tushadi, agent `read` bilan o'qiydi va o'shanda ko'radi.

Bu pi-coding-agent'ning o'z yechimi — kodi o'qib tekshirildi:
`interactive-mode.js:2071-2093` Ctrl+V rasmni `/tmp/pi-clipboard-<uuid>.png`
ga yozadi va editorga faqat yo'l matnini qo'yadi. `CHANGELOG.md:3847` da u
dastlab attachment edi, `:3832` (PR #442) bilan **ataylab** yo'lga
o'zgartirilgan. pi'ning attachment yo'li (CLI `@rasm.png`) esa base64'ni
JSONL'ga to'liq yozadi va har turn'da qayta yuboradi — pi bu muammoni hal
qilmagan, faqat interaktiv rejimda chetlab o'tgan.

Bizga bergani:
- fayl va rasm uchun **bitta kod yo'li**, ikki xil oqim yo'q;
- `agent.prompt(prompt, images)` ga tegish shart bo'lmadi;
- rasm kontekstga faqat agent xohlaganda kiradi va `toolResult` bo'lib
  compaction bilan tabiiy kesiladi;
- `read` tool'i **allaqachon** rasmni qaytaradi (`createReadTool()` magic
  bytes bilan aniqlaydi) — yangi kod kerak emas.

Narxi: bitta qo'shimcha turn (agent avval `read` qiladi).

**Papka:** `<ishPapkasi>/.platforma/sessiyalar/<sessionId>/fayllar/`. Sessiya
bo'yicha bo'linadi, chunki loyihali suhbatda ish papkasi umumiy. Shu sababli
`.platforma` **qidiruvdan chiqarildi** (`TASHLANADIGAN_PAPKALAR`) — aks holda
agent `grep` qilganda begona suhbatlarning fayllari chiqardi. Ongli yon
ta'sir: skilllar va xotira ham `grep` dan chiqdi (promptga baribir tushadi).
Aniq yo'l berilsa ro'yxat chetlab o'tiladi, ya'ni biriktirma oqimi ishlaydi.

**Yo'lda topilgan va tuzatilgan IKKI MAVJUD XATO:**

1. `agent.ts:660` `afterToolCall` natijani o'zgartirganda `content` ni
   butunlay `[{type:'text'}]` bilan almashtirardi va **rasm blokini jimgina
   yo'q qilardi**. `uzunlikHooki`/`maxfiyniYashirHooki` deyarli har natijadan
   o'tadi, ya'ni bu tuzatishsiz butun funksiya ishlamas edi — xato xabarisiz.
   Endi `matnsizBloklar()` rasm bloklarini saqlaydi.

2. `kontekst.ts:215` `taxminiyTokenlar` `JSON.stringify(...).length / 4`
   qilardi va base64'ni to'liq sanardi: 5 MB rasm ~1.7 million "token".
   `kesishNuqtasi` u holda yaqin tarixni butunlay xulosaga yuborardi. Endi
   pi'ning `estimateTokens` ishlatiladi (rasm = fiksirlangan 4800 belgi).

**Xavfsizlik qarorlari:**
- Tur **magic bytes** bo'yicha (`biriktirma.ts`), kengaytmaga va mijoz bergan
  `content-type` ga ishonilmaydi: `.png` deb atalgan ZIP fayl bo'lib tushadi.
  SVG ataylab rasm emas (XML → skript vektori).
- `GET /api/chat/biriktirma/:id`: rasm → haqiqiy mime + `inline`; fayl →
  **har doim** `application/octet-stream` + `attachment`. Aks holda
  `text/html` deb yuklangan fayl saqlangan XSS bo'lardi.
- Nom sanitizatsiyasi allowlist prinsipida (`yuklamaNomi`): `../`, NUL, shell
  metabelgilari to'plamga umuman kirmaydi. Kengaytma esa saqlanadi
  (`loyihaSlugi` uni yo'q qilardi, shuning uchun qayta ishlatilmadi).
- Prompt eslatmasi **`chat_messages.text` ga yozilmaydi**, faqat `prompt()`
  matniga. Klassifikator aynan `text` ni oladi — fayl nomi u yerga tushsa
  injection vektori bo'lardi.
- Vision qorovuli `/chat/send` da (model aynan shu yerda qulflanadi): rasm +
  vision'siz model → 400, xabar **yozilmaydi**. Jimgina o'tkazib yuborilsa
  agent "rasmda hech narsa yo'q" degan xato xulosaga kelardi.

**Yangi fayllar:** `platform-server/src/biriktirma.ts` (magic bytes),
`platform-server/src/chat-yuborish.ts` (REST va WS uchun umumiy mantiq),
`platform-server/src/migrations/012-biriktirmalar.ts`,
`platform-ui/src/components/BiriktirmaChipi.tsx`, va 4 ta test fayli.

**Yon foyda — refactor:** `xabarniQabulQil()` ajratilishi bilan `/chat/send`
va WS `chat.send` endi **bir xil** mantiqdan o'tadi. Ilgari model qulfi
tekshiruvi ikki nusxada edi. `tsc` xatolari 36 dan 5 ga tushdi.

**Ma'lum qarz:** LLM javobidagi `![](http://tashqi/x.png)` xom `<img>` bo'lib
chiqadi (`Markdown.tsx` da `img` komponenti yo'q) — tashqi so'rov ketadi.
Biriktirmadan mustaqil mavjud xavf, lekin rasm mavzusiga tegishli: `img`
komponenti qo'shib faqat `/api/chat/biriktirma/` bilan boshlanadigan `src` ga
ruxsat berish kerak.

### 8-bosqichda nima qilindi (2026-07-29)

Uchta jimgina ma'lumot yo'qotuvchi xato tuzatildi. Hammasi bir sinfdan:
javob oqimi buzilganda iz qolmasdi.

**1. Provider xatosi yutilardi.** pi-agent-core provider xatosini
`prompt()` dan TASHLAMAYDI — uni oxirgi assistant xabariga
`stopReason: 'error'` bo'lib yozib qo'yadi. `agentOqimi` buni tekshirmasdi,
ya'ni oqim MUVAFFAQIYATLI hisoblanardi: matn bo'sh, tool yo'q, xato yo'q.
Foydalanuvchi uchun bu "chat boshlandi va darhol tugadi, hech narsa
bo'lmadi". Bazaga ham hech narsa tushmasdi (`orchestrator.ts` bo'sh javobni
yozmasdi) — ya'ni savol tarixda yolg'iz qolardi.

Haqiqiy misollar (foydalanuvchi bazasidan): OpenRouter `400 Reasoning is
mandatory for this endpoint`, Codex `invalidated oauth token`.

Endi `oqimXatosi()` (`agent.ts`) buni ushlaydi va `chat.error` bo'lib
chiqadi; saqlash sharti ham kengaytirildi (matn/tool/kontekst — uchtadan
biri bo'lsa yoziladi).

**2. Tool chaqiruvlari faqat oqim OXIRIDA saqlanardi.** Yangi
`tool_chaqiruvlar` jadvali (009-migratsiya): har chaqiruv AVVAL bazaga
yoziladi, KEYIN UI'ga tarqatiladi. Ruxsat QANDAY berilgani ham saqlanadi —
auto klassifikator / foydalanuvchi / "har doim" / rad / muddat / bekor /
qat'iy taqiq (`RuxsatManbasi`). Tool kartasida shu qator ko'rinadi.
`xabarlarOqi` kartalarni shu jadvaldan oladi, xabari yozilmay qolgan
chaqiruvlar uchun esa sun'iy javob quradi — yetim yozuv ko'rinmay ketmasin.

**3. Ruxsat so'rovi bekor qilishni ko'rmasdi.** `sora()` abort signalini
tinglamasdi, ya'ni "To'xtatish" bosilgan oqim shu yerda 5 DAQIQA osilib
turardi. Ikki oqibati bor edi: (a) eski karta UI'da tirik qolib, bosilsa
foydalanuvchi to'xtatgan buyruq BAJARILARDI; (b) muddat tugagach qaror
KEYINGI oqimning kartasiga yozilib, "kim ruxsat berdi" izi yolg'on
bo'lardi. Endi signal tinglanadi va qaror `sorovId` bo'yicha aynan
so'ragan chaqiruvga bog'lanadi (`sorovningTooli`).

Yon tuzatishlar: ruxsat kartasi endi oqayotgan xabar ICHIDA emas, suhbat
oxirida alohida turadi (ilgari xabar hali qo'shilmagan bo'lsa karta umuman
chizilmasdi); `GET /api/chat/sessions/:id/ruxsatlar` — yo'qolgan
`chat.permission` ni tiklash uchun; rejim serverga ikkala qiymatda ham
yuboriladi.

⚠︎ **Migratsiya raqami 8 ATAYLAB tashlab ketilgan** — ba'zi mahalliy
bazalarda 8-raqam ostida tashlab yuborilgan tajriba (`command_runs`)
yozilgan. 009 uni `DROP TABLE IF EXISTS` bilan tozalaydi.

### 7-bosqichda nima qilindi (2026-07-29)

Mock `Servers.tsx` haqiqiy SSH boshqaruviga almashtirildi. Server qo'shish =
parolsiz ulanishni O'RNATISH: platforma kaliti serverning root useriga
joylanadi, keyin platformada ham, terminalda ham `ssh <nom>` parolsiz ishlaydi.

**Model (007-migratsiya):** bazada faqat ULANISH ma'lumoti (name/host/port/
username) — jonli holat (cpu/ram/disk/uptime) har so'rovda SSH orqali o'qiladi
va SAQLANMAYDI: eskirgan qiymat "ishonchli ko'ringan yolg'on" bo'lardi. Eski
mock jadval DROP qilindi, serverlar seed'i olib tashlandi.

**Uch qismli SSH sxemasi (`platform-server/src/ssh.ts`):**

1. **Platforma kaliti** — `~/.platforma/ssh/id_ed25519`, foydalanuvchi
   shaxsiy kalitidan ATAYLAB alohida (bekor qilish = serverdan bitta shu
   kalitni o'chirish). Bir marta `ssh-keygen` bilan yaratiladi, parolsiz.
2. **Boshqariladigan config** — `~/.platforma/ssh/config`, har saqlashda
   bazadagi ro'yxatdan TO'LIQ qayta yoziladi (haqiqat manbai baza — skilllar
   papkasi bilan bir xil qoida). `~/.ssh/config` ga faqat bitta `Include`
   qatori, AYNAN BOSHIGA: OpenSSH'da `Include` biror `Host` blokidan keyin
   kelsa o'sha blokka tegishli bo'lib qolib global ishlamaydi.
3. **Kalit joylash** — ikki yo'l, tartibi muhim: avval foydalanuvchining
   mavjud kalitlari bilan BatchMode urinish (kirsa parol umuman kerak emas),
   bo'lmasa formadagi bir martalik parol `sshpass -e` orqali (SSHPASS env —
   argv'da ko'rinmaydi, bazaga YOZILMAYDI, javob qaytishi bilan yo'qoladi).

**Muhim mayda qarorlar:**

- `UserKnownHostsFile` platforma papkasida + `StrictHostKeyChecking
  accept-new` — birinchi ulanishda interaktiv prompt server jarayonida
  osilib qolardi; foydalanuvchi known_hosts'iga ham tegilmaydi.
- Platforma ulanishlari `-F <boshqariladigan config>` bilan — foydalanuvchi
  shaxsiy sozlamalari (ProxyJump va h.k.) platformaga aralashmaydi.
- POST tartibi: avval kalit joylash, KEYIN baza — ulanmasa bazada
  "ishlamaydigan server" yozuvi qolmaydi (502 + aniq sabab).
- `metrikaOl` hech qachon throw qilmaydi — UI karta xato holatini ko'rsatadi,
  HTTP 200. Metrika bitta ssh chaqiruvida KEY=value qatorlar bilan keladi,
  parser tartibga bog'lanmagan, yetishmagan qator maydonni bo'sh qoldiradi.
- O'chirishda kalit serverning o'zida QOLADI (o'chirilayotgan server aynan
  ulanmayotgan bo'lishi mumkin) — UI buni tasdiq modalida ochiq aytadi.
- Nom/host/username qat'iy allowlist regex bilan — ular ssh_config fayliga
  va buyruq qatoriga tushadi, nazoratsiz matn kirmasligi shart.
- Barcha tashqi buyruqlar `BuyruqBajaruvchi` interfeysi orqali —
  `bajaruvchiOrnat()` bilan testlar soxta bajaruvchi qo'yadi (`dbOrnat`
  uslubi). Yo'llar `PLATFORMA_SSH` / `PLATFORMA_USER_SSH_CONFIG` env bilan
  ko'chiriladi. JS tomonda 20s timeout — ConnectTimeout'dan tashqari.

**Sinalgan:** 34 yangi test (ssh.test.ts, serverlar.test.ts) + jonli smoke:
alohida port/baza/papka bilan backend ko'tarilib, haqiqiy ssh-keygen kalit
yaratdi, ulanib bo'lmaydigan hostga POST 10s da aniq 502 qaytardi, baza toza
qoldi. Haqiqiy serverga ulanish hali sinalmagan (qo'l ostida server yo'q edi).

**Qoldirilgan:** o'chirishda serverdan kalitni olib tashlash (best-effort),
WS orqali metrika oqimi (hozir har ochilishda bir marta so'raladi), agent
tool'larini server ustida ishlatish (`ssh <nom> <buyruq>` allaqachon ishlaydi,
lekin agent qatlamiga ulanmagan).

### 6-bosqichda nima qilindi (2026-07-28)

Mock skill do'koni haqiqiy `SKILL.md` tizimiga almashtirildi. Registr yo'q —
istalgan GitHub repo ulanadi (`anthropics/skills` sinovda 18 skill berdi).

**Uch qatlamli model** (`006-skilllar` migratsiyasi):

| Jadval | Nima |
|---|---|
| `skill_manbalari` | ulangan repo (owner/repo/ref, commit SHA) |
| `skilllar` | repo'da topilgan `SKILL.md` — KATALOG, diskda hali yo'q |
| `skill_ornatish` | qamrov: `global` yoki `loyiha` + `project_id` |

Bir skill bir vaqtda global VA bir necha loyihada bo'lishi mumkin —
shuning uchun o'rnatish alohida jadval, `skilllar` ichidagi ustun emas.
Sinxronlash UPSERT bilan: repo qayta skanerlanganda skill `id` o'zgarmaydi,
ya'ni o'rnatishlar yo'qolmaydi.

**Disk oqimi:**

```
GitHub tarball → OMBOR ~/.platforma/skills-ombor/<manbaId>/<skillId>/
                        ↓ sessiya boshida NUSXA
                 <ishPapkasi>/.platforma/skills/<nom>/
                        ↓ o'qiladi
                 system prompt: <available_skills> ro'yxati
```

- **Nusxa, symlink EMAS.** `muhit.ts` `canonicalPath` bilan tekshiradi —
  symlink ochilib, ombor ish papkasidan tashqarida chiqardi va model har
  `SKILL.md` o'qiganda ruxsat modali chiqardi. Nusxa bilan chegara kodiga
  umuman tegilmaydi. Sinovda tasdiqlandi: **0 ruxsat so'rovi**.
- `.platforma/skills/` — **boshqariladigan papka**. Haqiqat manbai baza;
  har oqim boshida sinxronlanadi (ortiqchasi o'chadi, yetishmagani
  nusxalanadi). Qo'lda qo'yilgan narsa keyingi sessiyada yo'qoladi.

**Agentga ulanish — pi'dagi kabi progressive disclosure:** promptga faqat
nom+tavsif+yo'l tushadi (`<available_skills>`), to'liq matnni model `read`
bilan o'zi oladi. pi'da alohida `Skill` tool yo'q — bizda ham.

**Yangi fayllar:** `platform-ai/src/skill-fayl.ts` (frontmatter tahlili,
o'z minimal YAML parseri — `yaml` paketi pi'ning transitiv bog'liqligi,
unga tayanmadik), `skill-yuklash.ts` (o'qish + promptga ulash),
`platform-server/src/github.ts`, `tar.ts` (zip-slip himoyasi),
`skill-ombor.ts`, `routes/skills.ts`.

**Parser: blok skalarlari SHART.** `anthropics/skills` dagi `claude-api`
`description: |-` shaklini ishlatadi (ko'p qatorli YAML blok). Usiz tavsif
`|-` degan ikki belgi bo'lib qolardi — skill yuklanardi, lekin model uni
qachon ishlatishni bilmasdi. `|`, `>` va `-`/`+` chomping qo'llab-quvvatlanadi.

**UI: kartalar bir xil balandlikda.** Tavsif uzunligi juda farq qiladi
(204 dan 1025 belgigacha) — `line-clamp-4` bilan qisqartiriladi, to'liq
matn "Batafsil" modalida (fayl yo'li, litsenziya, tool'lar, qamrov,
ogohlantirishlar bilan).

**Qidiruv NOM va TAVSIF bo'yicha.** Foydalanuvchi skill nomini emas,
vazifasini eslaydi — "word" yozib `docx` topilishi kerak (nomida "word"
yo'q). So'zlar alohida `AND` bilan tekshiriladi, tartib muhim emas.
Yonida holat filtri (o'rnatilgan/o'rnatilmagan) va manba filtri (2+ repo
ulanganda ko'rinadi).

**GitHub rate limit:** token'siz 60 so'rov/soat. Katalog skanerlashda har
`SKILL.md` uchun bitta blob so'rovi ketadi, ya'ni 2-3 marta skanerlasa
limit tugaydi. Xato aniq ko'rsatiladi (qachon tiklanishi bilan) — jim
ishlamay qolmaydi.

**Qoldirilgan:** `allowed-tools` MAJBURLANMAYDI — modalda ko'rsatiladi,
xolos (pi'da ham implementatsiya qilinmagan). Private repo (token yo'q),
GitLab, mahalliy papkadan o'rnatish.

### 5-bosqichda nima qilindi (2026-07-28)

4-bosqichda "qoldirilgan" deb belgilangan **sessiyalar ro'yxati UI'si**
yopildi — eski chatlarni ochish endi mumkin.

**Server:**

- `GET /chat/sessions` endi `xabarlarSoni` ham qaytaradi (LEFT JOIN) — UI
  "bo'sh suhbat" ni ajratadi.
- `PATCH /chat/sessions/:id` — faqat sarlavha (model/loyiha qulflangan).
  `updated_at` GA TEGMAYDI: ro'yxat oxirgi faollik bo'yicha saralanadi,
  qayta nomlash suhbatni tepaga ko'tarmasligi kerak.
- `DELETE /chat/sessions/:id` — xabarlar CASCADE bilan ketadi. Oqim
  ketayotgan bo'lsa avval `abort()` qilinadi.
- `orchestrator.ts`: javob saqlashdan oldin sessiya borligi tekshiriladi.
  Bu MAJBURIY — `abort()` sinxron emas, oqim `finally` dan keyingi
  `xabarYoz()` ga baribir yetib keladi va foreign key xatosi tashlardi
  (u yerda ushlanmaydi).

**UI:**

- Sidebar'da "Chat" endi accordion: ichida oxirgi 5 suhbat, **holatidan
  qat'i nazar**, ishlayotganlari `OqimIndikatori` bilan. Ochiq/yopiq holat
  `localStorage` da (default — yopiq).
- Eski "Jonli oqimlar" bo'limi OLIB TASHLANDI — endi takrorlanish bo'lardi.
  Yopiq accordion yonida jonli nuqta, umumiy soni Agentlar badge'ida.
- `pages/Suhbatlar.tsx` — qidiruv, loyiha filtri, sana guruhlash, inline
  qayta nomlash, tasdiq modali bilan o'chirish.
- `useSuhbatlar()` App'da BIR MARTA chaqiriladi va props orqali beriladi:
  sidebar va sahifa bitta manbani ko'rsin (aks holda o'chirish faqat
  bittasida ko'rinardi).
- `Chat.tsx`: `boshlangichSessiya` → `ochiqSessiya`. Ilgari suhbat faqat
  sahifa ochilishida tiklanardi; endi prop o'zgarganda qayta yuklanadi,
  ya'ni ochiq chat turganda boshqasiga o'tish mumkin.

**Sinalgan:** brauzerda to'liq zanjir (accordion → suhbat ochish → boshqasiga
o'tish → refresh → yangi suhbat), qayta nomlash va o'chirish server bilan
tasdiqlab.

### 4-bosqichda nima qilindi (2026-07-28)

**Background agentlar ko'rinishi** — server allaqachon fon rejimida ishlardi
(orchestrator fire-and-forget), ko'rinish qatlami qo'shildi:

- `chat.status` WS eventi (`ishlayapti` / `ruxsat-kutmoqda` / `tugadi` /
  `xato`) — ataylab sessiya bo'yicha FILTRLANMAYDI (`eventSessiyasi()` →
  null), sidebar hamma sessiyani ko'rsin.
- `GET /chat/running` — sahifa ochilgandagi boshlang'ich holat.
- UI: App sidebar'da "Jonli oqimlar" bo'limi, `Agents.tsx` real ma'lumotga
  ulandi ("To'xtatish" tugmasi bilan), Chat'da "Fonda" chizig'i.
- Eng muhim holat — `ruxsat-kutmoqda`: orqa fondagi agent ruxsat so'rasa
  foydalanuvchi badge orqali ko'radi (aks holda 30 daq TTL'da bekor bo'lardi).

**Loyiha (project) mantig'i** — workspace tushunchasi:

- 005-migratsiya: `projects` jadvali + `chat_sessions.project_id` (NULL =
  oddiy chat). `routes/projects.ts`: GET/POST.
- Papkani faqat platforma yaratadi: `~/.platforma/loyihalar/<slug>/`
  (`PLATFORMA_LOYIHALAR` env bilan ko'chiriladi). Slug — allowlist
  `[a-zA-Z0-9_-]`.
- Loyihali sessiyaning agent tool'lari loyiha papkasida ishlaydi — bir
  loyihaning hamma chatlari BITTA papkada (parallel to'qnashuv — qabul
  qilingan risk, qulf yo'q). Chegara `muhit.ts` dagi oddiy sessiya bilan
  bir xil.
- Loyiha papkasidagi `AGENTS.md` (ustun) yoki `CLAUDE.md` agent system
  promptiga qo'shiladi (16k belgi limiti). Klassifikatorga BORMAYDI —
  testlar bilan majburlangan (`loyiha-konteksti`, hujum matni bilan).
- UI: Chat'da `LoyihaTanlagich` (inline yangi loyiha yaratish bilan),
  sessiya boshlangach qulflanadi.

**Qoldirilgan:** loyihani o'chirish (papka taqdiri — tasdiq talab qiladi),
alohida Projects sahifasi, mavjud tashqi papkaga ulanish.
(~~sessiyalar ro'yxati UI'si~~ — 5-bosqichda yopildi.)

### 3-bosqichda nima qilindi

**Kritik tuzatishlar:**

- **Tool natijalari tarixda saqlanadi.** Ilgari agent har turn xotirasini
  yo'qotardi — "faylni o'qi" dan keyin "versiyani ayt" desa, faylni qayta
  o'qishga majbur edi. `AgentMessage[]` endi bazada
  (`chat_messages.agent_messages`, 004-migratsiya).
- **Kontekst siqish.** Uzun suhbat context window'ga sig'may qolib sessiya
  butunlay ishlamay qolardi. Endi LLM xulosasi + zaxira kesish.
- **WS sessiya izolyatsiyasi.** Ikki brauzer oynasi bir-birining
  `chat.delta`/`chat.permission` eventlarini olardi.
- **Xotira sizmasi.** Ruxsat/rejim boshqaruvchilari abadiy qolardi —
  endi TTL (30 daq) + LRU (500) bilan tozalanadi.
- **Yo'qolgan foydalanuvchi xabari.** "To'xtatish" bosib darhol yangi xabar
  yuborilsa, poyga holati tufayli xabar jimgina yo'qolardi.

**Yangi imkoniyatlar:**

- `grep` / `find` / `ls` tool'lari — `rg` bo'lsa undan, bo'lmasa Node
  backend. **Ikkalasi aynan bir xil natija beradi** (test bilan majburlangan).
- Hook tizimi: `oldin` (bloklash) va `keyin` (natijani o'zgartirish).
- Config qatlami: `~/.platforma/config.json` + loyihadagi
  `.platforma/config.json`, JSON Schema bilan.

## G'oyalar zaxirasi (eski reja — endi majburiy tartib emas)

1. **UI sahifalarni API'ga ulash** — `Audit.tsx` hali mock ma'lumot
   ishlatadi (`Skills.tsx` 6-bosqichda, `Servers.tsx` 7-bosqichda ulandi).
2. **`allowed-tools` ni majburlash** — hozir faqat ko'rsatiladi. Bizning
   ruxsat qatlamimiz buni ko'tara oladi (pi'da yo'q edi).
3. **Config web UI** — JSON Schema'dan forma avtomatik quriladi.
4. **Docker izolyatsiyasi** — `ExecutionEnv` ni Docker exec ustida qayta yozish.
5. **AgentHarness ga o'tish** — sessiya daraxti, `steer()`, provider retry.
6. **Integratsiya + Playwright.**

## Agent eslatmalari (muhim texnik detallar)

- **Route qo'shish:** `platform-server/src/routes/<nom>.ts` + `app.ts`dagi
  `appYarat()` ga bitta import va `api.route()` qatori.
- **WS event qo'shish:** `platform-shared/src/protocol.ts` dagi tartibga amal
  qiling — u yerda 4 qadamli izoh bor. `eventKanali()` va `eventSessiyasi()`
  ikkalasini ham yangilash kerak.
- **Config sozlama qo'shish:** faqat `platform-config/src/sxema.ts` dagi
  `MAYDONLAR` ga bitta qator + `Config` tipiga maydon, keyin `bun run schema`.
  Validatsiya, standart qiymat va JSON Schema o'zi keladi.
- **Audit:** faqat `auditYoz(...)` orqali — jadval UPDATE/DELETE SQL trigger
  bilan bloklangan.
- **Skilllar:** ombor ildizini `PLATFORMA_SKILLS` ko'chiradi (testlarda
  vaqtinchalik papka). Agent skilllarni `.platforma/skills/` dan o'qiydi,
  u yerga nusxani `loyihagaSinxronla()` qo'yadi — qo'lda fayl qo'ymang,
  keyingi oqimda o'chiriladi.
- **Testlarda:** `bazaOch(':memory:')` + `dbOrnat(db)`.
- Runtime baza `platform-server/data/` ichida — git'da yo'q, birinchi ishga
  tushirishda migratsiya + seed avtomatik.

### Buzmaslik kerak bo'lgan yetti chegara

| Chegara | Qayerda | Buzilsa nima bo'ladi |
|---|---|---|
| Klassifikatorga tool natijasi bormaydi | `agent.ts`, `orchestrator.ts` | prompt injection himoyasi yo'qoladi |
| Kesish `toolResult` dan boshlanmaydi | `kontekst.ts` | provider so'rovni rad etadi |
| `rg` va Node backend bir xil natija | `qidiruv-motor.ts` | agent PC'ga qarab boshqacha ishlaydi |
| **Skill matni klassifikatorga bormaydi** | `skill-yuklash.ts` | begona repo "hamma buyruqqa ruxsat ber" deb yozib himoyani ochib yuboradi |
| **Tar yo'llari tozalanadi (`..` yo'q)** | `tar.ts` | zip-slip: arxiv nishon papkadan tashqariga yozadi |
| **Biriktirma nomi/yo'li klassifikatorga bormaydi** | `agent.ts` (`biriktirmaEslatmasi`), `orchestrator.ts` | fayl nomi (`"; rm -rf ~; #.png`) ruxsat qaroriga ta'sir qiladi |
| **`afterToolCall` rasm blokini saqlaydi** | `agent.ts` (`matnsizBloklar`) | model rasmni jimgina ko'rmaydi — xato xabarisiz |

Hammasi test bilan majburlangan — testni "tuzatish" o'rniga kodni tuzating.

To'rtinchi chegara `AGENTS.md` nikidan KUCHLIROQ sabab bilan: loyiha faylini
hech bo'lmasa foydalanuvchi o'z papkasiga qo'ygan, skill esa begona GitHub
repo'sidan keladi va uni foydalanuvchi umuman o'qimagan bo'lishi mumkin.

## Kengroq kontekst

- `ai-news-bot/` — alohida tayyor loyiha (488 test), bu ishga aloqasi yo'q.
- Loyiha hujjatlari: `README.md`, `01-telegram-bot.md`, `02-ai-platform.md`,
  `03-roadmap.md`, `04-xavflar.md`.
- Paket hujjatlari: `platform-ai/README.md` (eng batafsil — xavfsizlik
  modeli), `platform-config/README.md`, `platform-server/README.md`.
