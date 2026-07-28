// Suhbatlar ro'yxatini boshqaruvchi hook — sidebar va "Suhbatlar" sahifasi
// uchun yagona manba.
//
// `useIshlayotganlar()` dan farqi: u FAQAT hozir oqim ketayotganlarni
// kuzatadi (jonli indikator uchun), bu esa BARCHA suhbatlarni beradi —
// tugaganini ham, hech qachon boshlanmaganini ham.
//
// Yangilanish siyosati: ro'yxat REST'dan olinadi, keyin `chat.status`
// eventlari kelganda qayta so'raladi. Nega qayta so'rov, nega eventdan
// qurmaymiz? Sarlavha, xabarlar soni va tartib serverda hisoblanadi —
// ularni mijozda takror hisoblash ikki manbani ushlab turishni talab
// qilardi. `chat.status` esa kamdan-kam keladi (oqim boshlanishi/tugashi),
// ya'ni so'rov soni kichik.
//
// `chat.status` ATAYLAB sessiya bo'yicha filtrlanmaydi (protocol.ts dagi
// `eventSessiyasi()` ga q.) — shuning uchun bitta suhbat ochiq bo'lsa ham
// boshqa suhbatlarning tugagani bu yerga yetib keladi.

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChatSession } from '@platforma/shared'
import { sessiyalarOl } from './api'
import { ws } from './ws'

export interface SuhbatlarHolati {
  /** Barcha suhbatlar, oxirgi faollik bo'yicha (yangisi birinchi) */
  suhbatlar: ChatSession[]
  /** Birinchi yuklash tugadimi */
  yuklanmoqda: boolean
  /** Ro'yxat umuman yuklanmadi (server yetib bo'lmaydi) */
  xato: boolean
  /** Ro'yxatni qo'lda qayta so'rash — o'chirish/tahrirdan keyin */
  yangila: () => void
  /**
   * Ro'yxatni serverni kutmasdan mahalliy o'zgartirish.
   *
   * O'chirish va qayta nomlashda ishlatiladi: so'rov javobi kelguncha UI
   * qotib turmasin. Server javobidan keyin `yangila()` baribir chaqiriladi.
   */
  ozgart: (yangilagich: (oldingi: ChatSession[]) => ChatSession[]) => void
}

/** Ketma-ket kelgan `chat.status` eventlari bitta so'rovga yig'iladi (ms) */
const YIGISH_KECHIKISHI = 300

export function useSuhbatlar(): SuhbatlarHolati {
  const [suhbatlar, setSuhbatlar] = useState<ChatSession[]>([])
  const [yuklanmoqda, setYuklanmoqda] = useState(true)
  const [xato, setXato] = useState(false)
  /** Komponent yopilganidan keyin state yozilmasligi uchun */
  const tirikRef = useRef(true)
  const taymerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const yangila = useCallback(() => {
    sessiyalarOl()
      .then((royxat) => {
        if (!tirikRef.current) return
        setSuhbatlar(royxat)
        setXato(false)
      })
      .catch(() => {
        if (tirikRef.current) setXato(true)
      })
      .finally(() => {
        if (tirikRef.current) setYuklanmoqda(false)
      })
  }, [])

  useEffect(() => {
    tirikRef.current = true
    ws.ulan()
    const obunaBekor = ws.obuna(['chat'])

    // Oqim boshlanishi/tugashi ro'yxatni o'zgartiradi: yangi suhbat paydo
    // bo'ladi yoki tartib va sarlavha yangilanadi. Eventlar ketma-ket
    // kelishi mumkin (bir necha sessiya bir vaqtda tugasa), shuning uchun
    // qisqa kechikish bilan bitta so'rovga yig'amiz.
    const kuzatBekor = ws.kuzat((event) => {
      if (event.type !== 'chat.status') return
      if (taymerRef.current) return
      taymerRef.current = setTimeout(() => {
        taymerRef.current = null
        yangila()
      }, YIGISH_KECHIKISHI)
    })

    yangila()

    return () => {
      tirikRef.current = false
      if (taymerRef.current) {
        clearTimeout(taymerRef.current)
        taymerRef.current = null
      }
      obunaBekor()
      kuzatBekor()
    }
  }, [yangila])

  return { suhbatlar, yuklanmoqda, xato, yangila, ozgart: setSuhbatlar }
}
