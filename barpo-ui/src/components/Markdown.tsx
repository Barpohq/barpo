// Rendering assistant replies as markdown.
//
// react-markdown never puts raw HTML into the DOM (rehype-raw is not wired
// up), so tags like `<script>` in an LLM reply stay plain text — no XSS. The
// GFM plugin adds tables, strikethrough and checkbox lists.
//
// The style of every tag is given here: the project has no Tailwind `prose`
// plugin, and even with one the colours would have to be wired to the
// `index.css` tokens by hand.

import { Children, cloneElement, isValidElement, memo, useState } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

/** Code block — with a language label and a copy button */
function CodeBlock({ language, code }: { language: string | null; code: string }) {
  const [copied, setCopied] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {
      // No clipboard permission (e.g. opened over plain HTTP) — fail quietly,
      // the user can still select the text by hand
    }
  }

  return (
    <div className="my-3 overflow-hidden rounded-lg border border-line bg-bg">
      <div className="flex items-center justify-between border-b border-line px-3 py-1.5">
        <span className="font-mono text-[11px] text-faint">{language ?? 'text'}</span>
        <button
          onClick={() => void copy()}
          className="font-mono text-[11px] text-faint transition hover:text-lazur"
        >
          {copied ? '✓ copied' : 'copy'}
        </button>
      </div>
      <pre className="thin-scroll overflow-x-auto px-3 py-2.5">
        <code className="font-mono text-[12.5px] leading-relaxed">{code}</code>
      </pre>
    </div>
  )
}

// `code` is called both for inline (`like this`) and for block (```like
// this```) code. react-markdown 10 removed the `inline` prop, so we mark being
// a child of `pre` ourselves: the `pre` component below clones its children
// with a `block` flag.
const components: Components = {
  code({ className, children, ...rest }) {
    const code = String(children).replace(/\n$/, '')
    const isBlock = (rest as { 'data-block'?: boolean })['data-block'] === true

    if (!isBlock) {
      const { 'data-block': _dropped, ...clean } = rest as Record<string, unknown>
      return (
        <code
          className="rounded bg-panel2 px-1.5 py-0.5 font-mono text-[0.875em] text-lazur"
          {...clean}
        >
          {children}
        </code>
      )
    }
    const language = /language-(\w+)/.exec(className ?? '')?.[1] ?? null
    return <CodeBlock language={language} code={code} />
  },

  // The `pre` wrapper already lives inside CodeBlock — here we only flag the
  // child as "you are in a block"
  pre: ({ children }) => (
    <>
      {Children.map(children, (child) =>
        isValidElement(child) ? cloneElement(child, { 'data-block': true } as never) : child,
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

  // The marker type is set on the list tag, not on `li` — otherwise `ol`
  // items would get bullets too. `task-list-item` is a GFM checkbox item: an
  // `input` arrives instead of its marker, hence no marker.
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

  // A wide table must not scroll the page sideways — it scrolls in its own
  // container
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
 * During streaming this re-parses on every delta — `memo` prevents redoing the
 * work for identical text (for example when another message updates).
 */
export default memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="text-[15px] break-words">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  )
})
