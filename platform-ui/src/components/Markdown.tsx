// Assistant javoblarini markdown sifatida ko'rsatish.
//
// react-markdown DOM'ga xom HTML qo'ymaydi (rehype-raw ulanmagan), shuning
// uchun LLM javobidagi `<script>` kabi teglar oddiy matn bo'lib qoladi — XSS
// yo'q. GFM plagini jadval, strikethrough va checkbox ro'yxatlarini qo'shadi.
//
// Har bir teg uslubi shu yerda beriladi: Tailwind'ning `prose` plagini
// loyihada yo'q, va bo'lgan taqdirda ham ranglar `index.css` tokenlariga
// qo'lda bog'lanishi kerak edi.

import { Children, cloneElement, isValidElement, memo, useState } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

/** Kod bloki — til yorlig'i va nusxalash tugmasi bilan */
function KodBloki({ til, kod }: { til: string | null; kod: string }) {
  const [nusxalandi, setNusxalandi] = useState(false)

  async function nusxala() {
    try {
      await navigator.clipboard.writeText(kod)
      setNusxalandi(true)
      setTimeout(() => setNusxalandi(false), 1600)
    } catch {
      // Clipboard ruxsati yo'q (masalan HTTP orqali ochilgan) — jim o'tamiz,
      // foydalanuvchi matnni qo'lda belgilab olaveradi
    }
  }

  return (
    <div className="my-3 overflow-hidden rounded-lg border border-line bg-bg">
      <div className="flex items-center justify-between border-b border-line px-3 py-1.5">
        <span className="font-mono text-[11px] text-faint">{til ?? 'matn'}</span>
        <button
          onClick={() => void nusxala()}
          className="font-mono text-[11px] text-faint transition hover:text-lazur"
        >
          {nusxalandi ? '✓ nusxalandi' : 'nusxalash'}
        </button>
      </div>
      <pre className="thin-scroll overflow-x-auto px-3 py-2.5">
        <code className="font-mono text-[12.5px] leading-relaxed">{kod}</code>
      </pre>
    </div>
  )
}

// `code` hem inline (`shunday`), hem blok (```shunday```) uchun chaqiriladi.
// react-markdown 10'da `inline` propi olib tashlangan, shuning uchun `pre`
// bolasi ekanini o'zimiz belgilaymiz: quyidagi `pre` komponenti bolalarini
// `blok` bayrog'i bilan klonlaydi.
const komponentlar: Components = {
  code({ className, children, ...qolgan }) {
    const kod = String(children).replace(/\n$/, '')
    const blokmi = (qolgan as { 'data-blok'?: boolean })['data-blok'] === true

    if (!blokmi) {
      const { 'data-blok': _ajratilgan, ...toza } = qolgan as Record<string, unknown>
      return (
        <code
          className="rounded bg-panel2 px-1.5 py-0.5 font-mono text-[0.875em] text-lazur"
          {...toza}
        >
          {children}
        </code>
      )
    }
    const til = /language-(\w+)/.exec(className ?? '')?.[1] ?? null
    return <KodBloki til={til} kod={kod} />
  },

  // `pre` o'rami KodBloki ichida allaqachon bor — bu yerda faqat bolasiga
  // "sen blokdasan" deb belgi qo'yamiz
  pre: ({ children }) => (
    <>
      {Children.map(children, (bola) =>
        isValidElement(bola) ? cloneElement(bola, { 'data-blok': true } as never) : bola,
      )}
    </>
  ),

  p: ({ children }) => <p className="my-2.5 leading-relaxed first:mt-0 last:mb-0">{children}</p>,

  h1: ({ children }) => (
    <h1 className="font-display mt-5 mb-2 text-xl font-semibold first:mt-0">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="font-display mt-5 mb-2 text-lg font-semibold first:mt-0">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="font-display mt-4 mb-1.5 text-base font-semibold first:mt-0">{children}</h3>
  ),
  h4: ({ children }) => (
    <h4 className="mt-4 mb-1.5 text-[15px] font-semibold text-muted first:mt-0">{children}</h4>
  ),

  strong: ({ children }) => <strong className="font-semibold text-ink">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  del: ({ children }) => <del className="text-faint line-through">{children}</del>,

  // Marker turi ro'yxat tegida beriladi, `li`da emas — aks holda `ol` bandlari
  // ham nuqta oladi. `task-list-item` GFM checkbox bandi: markeri o'rniga
  // `input` keladi, shuning uchun markersiz.
  ul: ({ children }) => (
    <ul className="my-2.5 ml-5 list-disc space-y-1 marker:text-faint">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="my-2.5 ml-5 list-decimal space-y-1 marker:text-faint">{children}</ol>
  ),
  li: ({ children, className }) => (
    <li className={/task-list-item/.test(className ?? '') ? '-ml-5 list-none' : 'pl-1'}>
      {children}
    </li>
  ),

  blockquote: ({ children }) => (
    <blockquote className="my-3 border-l-2 border-lazur-dim pl-3 text-muted italic">
      {children}
    </blockquote>
  ),

  a: ({ children, href }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="text-lazur underline decoration-lazur-dim underline-offset-2 transition hover:decoration-lazur"
    >
      {children}
    </a>
  ),

  hr: () => <hr className="my-4 border-line" />,

  // Keng jadval sahifani gorizontal siljitmasin — o'z konteynerida aylansin
  table: ({ children }) => (
    <div className="thin-scroll my-3 overflow-x-auto rounded-lg border border-line">
      <table className="w-full border-collapse text-[13.5px]">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-panel">{children}</thead>,
  th: ({ children }) => (
    <th className="border-b border-line px-3 py-2 text-left font-semibold">{children}</th>
  ),
  td: ({ children }) => <td className="border-b border-line px-3 py-2 text-muted">{children}</td>,

  input: ({ checked, type }) =>
    type === 'checkbox' ? (
      <span className="mr-1.5 inline-block text-lazur" aria-hidden>
        {checked ? '☑' : '☐'}
      </span>
    ) : null,
}

/**
 * Oqim davomida har delta'da qayta parse qilinadi — `memo` bir xil matn uchun
 * qayta ishlashning oldini oladi (masalan boshqa xabar yangilanganda).
 */
export default memo(function Markdown({ matn }: { matn: string }) {
  return (
    <div className="text-[15px] break-words">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={komponentlar}>
        {matn}
      </ReactMarkdown>
    </div>
  )
})
