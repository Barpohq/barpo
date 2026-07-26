# Xavflar va tanqidiy tahlil

> Loyihani boshlashdan oldin unga qarshi eng kuchli argumentlar va ularga javoblar.
> Maqsad: ko'r-ko'rona optimizmdan saqlanish.

---

## Loyiha yo'nalishi o'zgarishi bilan bartaraf bo'lgan xavflar

Dastlabki g'oya (kommersion, hamma uchun SaaS platforma) quyidagi jiddiy xavflarga ega edi. Self-hosted, open-source, "o'zim uchun" yo'nalishi ularni bartaraf qildi:

| Xavf | Nega endi dolzarb emas |
|---|---|
| Provayderlar eng yaxshi funksiyalarni o'zlari qurib, bizni siqib chiqaradi | Biz bozor uchun kurashmaymiz; o'z ehtiyojim hal bo'lsa — maqsadga erishilgan. Ular yaxshi vosita chiqarsa, uni ham platformaga ulaymiz |
| "Hamma uchun mahsulot — hech kim uchun mahsulot" | Auditoriya aniq: men. Progressive disclosure — o'z qulayligim uchun, marketing uchun emas |
| Markazlashgan platforma = hakerlar uchun shirin nishon | Self-hosted: minglab foydalanuvchi serverlariga eshik yo'q, faqat o'z serverlarim |
| Biznes model noaniq, iqtisodiyot qarshi | Biznes yo'q. BYOK — o'z obunalarim va kalitlarim. Xarajat = o'zimning API sarfim |
| Store'da tovuq-tuxum muammosi | Store — katalog xolos, marketplace emas. Skill'larni asosan o'zim yozaman |
| Yuridik javobgarlik (AI mijoz serverini buzsa) | Mijoz yo'q. O'z serverim, o'z riskim, open-source litsenziyada "as is" |

## Dolzarb bo'lib qolgan xavflar

### X1. Scope creep — eng katta xavf

**Xavf:** "O'zim uchun" loyihalar chegarasiz kengayadi, chunki hech kim "yo'q" demaydi. Bot o'rniga platforma, platforma o'rniga ekotizim qurila boshlaydi va hech narsa tugamaydi.

**Mudofaa:**
- Roadmap'dagi qat'iy tartib: bot ishlamaguncha platforma kodi yozilmaydi
- Har modul faqat ikkinchi use case talab qilganda umumlashtiriladi
- "Anti-maqsadlar" ro'yxati (03-roadmap.md) — har yangi g'oya avval shu ro'yxat bilan tekshiriladi

### X2. Prompt injection — texnik jihatdan hal qilinmagan muammo

**Xavf:** Bot tashqi kontent (web sahifalar, RSS, Reddit postlar) bilan ishlaydi. Zararli sahifa ichida "avvalgi ko'rsatmalarni unut, X qil" turidagi matn bo'lishi mumkin. Platforma bosqichida bu jiddiyroq: AI server loglarini o'qiganda log ichiga yashiringan buyruq server boshqaruviga ta'sir qilishi mumkin.

**Mudofaa:**
- Bot bosqichida risk past: bot faqat post yozadi, hech qanday amal bajarmaydi + approval flow bor
- Tashqi kontent har doim "ma'lumot" sifatida, alohida belgilangan kontekstda uzatiladi
- Platforma bosqichida: xavfli amallar LLM qaroriga emas, inson tasdig'iga bog'langan — injection muvaffaqiyatli bo'lsa ham amal bajarilmaydi
- Bu muammo to'liq hal qilinmaydi — faqat zararni cheklash mumkin. Buni tan olib dizayn qilamiz

### X3. LLM stoxastikligi — "to'liq avtonom" hech qachon 100% ishonchli emas

**Xavf:** Bot eski yangilikni yangi deb chiqarishi, faktni noto'g'ri yozishi, uslubdan chiqib ketishi mumkin. Kanal obro'si — mening obro'im.

**Mudofaa:**
- 7 kunlik dedup oynasi + sana tekshiruvi
- Approval bosqichi majburiy va yetarlicha uzoq (95% mezoni)
- Auto rejimda ham har postda ❌ tugmasi — bir bosishda o'chirish + feedback
- Manba havolasi har doim postda — o'quvchi o'zi tekshira oladi

### X4. Texnik xizmat yuki (maintenance)

**Xavf:** Manbalar formati o'zgaradi, API'lar buziladi, provayderlar endpoint o'zgartiradi. "Avtonom" bot aslida doimiy kichik ta'mirlab turishni talab qiladi. 5 serverdagi agent daemonlar ham yangilanish talab qiladi.

**Mudofaa:**
- Health report + alerting: buzilish darhol ko'rinadi, jimgina o'lib qolmaydi
- Manba adapterlari mustaqil: bittasi buzilsa qolganlari ishlayveradi
- Konfiguratsiya kod emas (`yaml`) — ko'p tuzatishlar deploy'siz qilinadi
- Realistik kutish: haftasiga ~1 soat texnik xizmat — bu normal narx

### X5. Vaqt va motivatsiya

**Xavf:** Yakka developer loyihalarining aksariyati Faza 2–3 atrofida tashlab qo'yiladi. Ayniqsa platforma bosqichi (Faza 4–6) — oylab davom etadigan ish.

**Mudofaa:**
- Har faza mustaqil foydali: bot Faza 3'da tashlab qo'yilsa ham — ishlayotgan, foyda berayotgan mahsulot qoladi
- Eng katta motivatsiya dizayni: birinchi natija (kanalga avtomatik post) 2–3 haftada ko'rinadi
- Platforma "kerak bo'lganda" quriladi — motivatsiya real ehtiyojdan keladi, majburiyatdan emas

### X6. O'zbek tilida LLM sifati

**Xavf:** Agar kanal o'zbek tilida bo'lsa — ko'p modellar o'zbekchada zaif, postlar sun'iy yoki xato chiqishi mumkin.

**Mudofaa:**
- Faza 2'da maxsus til sinovi: bir xil yangilikni 3–4 modelga yozdirib taqqoslash
- Few-shot'da o'z postlarimdan namunalar — uslub va til sifatini ko'taradi
- Kerak bo'lsa gibrid: kontent inglizchada tahlil qilinadi, faqat yakuniy yozuv kuchli modelda o'zbekchada

### X7. Xarajat nazorati

**Xavf:** Har 2–4 soatda o'nlab klaster × LLM chaqiruvlar — e'tiborsiz qolsa oylik hisob kutilmagan bo'lishi mumkin. Platforma bosqichida agentlar bir-birini chaqirsa sarf 2–5x oshadi.

**Mudofaa:**
- LLM Router'da xarajat log birinchi kundan (Faza 0)
- Arzon/kuchli model taqsimoti: 90% ish arzon modelda
- Kunlik post limiti + rank threshold — chaqiruvlar soni tabiiy cheklangan
- Kunlik xarajat limiti: oshsa bot to'xtab alert yuboradi

---

## Ochiq savollar (hozircha javobsiz, keyin hal qilinadi)

1. ~~Kanal tili va auditoriya profili~~ — hal qilindi (Faza 2, `channel.yaml`)
2. X/Twitter manbasi: rasmiy API qimmat — qaysi alternativa barqaror ishlaydi?
3. ~~Ikkinchi use case qaysi bo'ladi?~~ — **server monitor agent** tanlandi
   (2026-07-26). Sabab: bot bilan eng ko'p modul bo'lishadi, ya'ni core
   ajratish uchun eng kuchli signal. Deploy agent kuchliroq og'riq, lekin
   Faza 5 ishini oldinga tortardi.
4. Agent daemon'ni noldan yozish vs Coolify/Dokploy kabi mavjud open-source
   yechimni moslashtirish? (Faza 5 da hal qilinadi — hozircha monitor SSH
   bilan ishlaydi, daemonsiz)
