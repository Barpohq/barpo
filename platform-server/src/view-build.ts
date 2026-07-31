// Turns the JSX view written by the AI into JS the browser understands.
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ WHY COMPILATION HAPPENS ON THE SERVER. Two reasons:                  │
// │                                                                      │
// │  1) CATCHING ERRORS EARLY. If the AI writes code with a syntax       │
// │     error, it shows up IMMEDIATELY in the `appPublish` response and  │
// │     the model fixes it itself. Compiled in the browser, the error    │
// │     would only appear once the user opened the page — far too late.  │
// │                                                                      │
// │  2) KEEPING THE TRANSFORM COST OFF THE BROWSER. Otherwise every      │
// │     page load would have to fetch Babel/SWC and re-transform the JSX │
// │     over and over.                                                   │
// └──────────────────────────────────────────────────────────────────────┘
//
// THE CLASSIC JSX TRANSFORM (`React.createElement`) WAS CHOSEN DELIBERATELY.
// The modern `automatic` runtime adds an IMPORT from `react/jsx-runtime` — and
// inside the sandbox there is neither a module loader nor a network, so that
// import would never resolve. The classic transform relies only on the `React`
// global, which the sandbox HTML supplies itself.
//
// IMPORTS ARE FORBIDDEN OUTRIGHT. Any `import`/`require` fails at compile
// time — meaning the AI cannot depend on an external package. The reason: the
// sandbox has no network, so an imported module would not load anyway; raising
// the error here gives the AI a clear signal.
//
// ERROR ISOLATION (a user requirement): if compilation fails the manifest is
// NOT REJECTED — it is saved WITHOUT the `view` and the widgets keep working
// as before. In other words a mistake in the AI's code disables only the
// custom view, not the whole dashboard.

/** The result of a compilation */
export interface BuildResult {
  ok: boolean
  /** On success — the JS handed to the browser */
  code?: string
  /** A hash of the source code — for caching and auditing */
  hash?: string
  /** On failure — an explanation the AI can read */
  errors: string[]
}

/**
 * The compilation time limit (ms).
 *
 * `Bun.build` normally finishes in milliseconds. The limit is there for the
 * pathological case: very large or strangely shaped code must not hold the
 * build up for long and freeze the chat response.
 */
export const BUILD_TIMEOUT_MS = 10_000

/**
 * Makes JS safe to embed inside an inline `<script>`.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │ WHY THIS IS NECESSARY. The HTML parser closes a `<script>` block   │
 * │ at the FIRST `</script` it meets — even one inside a JS string.    │
 * │ And the sandbox inlines the entire bundle inside `srcdoc`.         │
 * │                                                                    │
 * │ This is not a theoretical risk: React's OWN code contains the      │
 * │ line                                                               │
 * │     Z.innerHTML = "<script></script>"                              │
 * │ and because of it the bundle was cut in half in the browser, with  │
 * │ the remainder rendering as page TEXT — `window.React` was never    │
 * │ defined at all.                                                    │
 * │                                                                    │
 * │ The AI's code may well contain such a string too, which is why the │
 * │ protection sits where the code is BUILT.                           │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * In a JS string `<\/script` evaluates to EXACTLY the same value as
 * `</script`, but the HTML parser does not read it as a closing tag.
 */
export function escapeForScript(js: string): string {
  return js.replace(/<\/(script)/gi, '<\\/$1')
}

/**
 * A short hash of the source code.
 *
 * There is NO cryptographic intent — it only answers the question "did the
 * code change?" (to bust the browser cache and to tell versions apart in the
 * audit log).
 */
export function codeHash(source: string): string {
  return Bun.hash(source).toString(16)
}

/**
 * Checks whether the code contains forbidden constructs.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │ THIS IS NOT A SECURITY CONTROL, IT IS AN ARCHITECTURAL RULE.       │
 * │                                                                    │
 * │ View code runs IN THE HOST PAGE (the sandbox was removed — see     │
 * │ `AiView.tsx`), which means `fetch` is technically POSSIBLE. But it │
 * │ must not be used: data arrives through `states` (`state-run.ts`),  │
 * │ and the view only DRAWS.                                           │
 * │                                                                    │
 * │ The reason is predictability: with a view written around `fetch`,  │
 * │ the platform could not control the refresh interval, the cache     │
 * │ would not apply, and several open tabs would repeat the same       │
 * │ request. `states`, by contrast, is cached and runs exactly once    │
 * │ per interval.                                                      │
 * │                                                                    │
 * │ So the check POINTS THE AI THE RIGHT WAY, it does not block a      │
 * │ threat. The security layer is the future classifier (the same      │
 * │ issue as `validateCode()` in `state-run.ts`).                      │
 * └────────────────────────────────────────────────────────────────────┘
 */
export function findForbidden(source: string): string[] {
  const errors: string[] = []

  const patterns: { pattern: RegExp; message: string }[] = [
    {
      // Imports are caught here rather than being left to the bundler.
      //
      // WHY: in Bun's plugin API `onLoad` can only return `contents` — there
      // is no way to surface our own error text through it. Leaving the import
      // to the bundler would give the model the internal message "onLoad
      // plugins must return..." and it would not know what to do with it.
      //
      // The word `import` is looked for at the start of a line, so that an
      // incidental occurrence inside text (like "do not use this import") is
      // not caught.
      //
      // DYNAMIC `import(...)` IS LISTED SEPARATELY: the bundler treats it as
      // an external dependency and lets it through without an error. The code
      // would then fail SILENTLY in the browser and the AI would never learn
      // the reason.
      pattern: /^\s*import\s|^\s*export\s+.*\bfrom\s|[^\w.]require\s*\(|[^\w.]import\s*\(/m,
      message:
        'The code contains `import`/`require` — those DO NOT WORK in view code ' +
        '(the code is not bundled and there is no module loader). React, hooks and ' +
        'the platform components are provided as GLOBALS: useState, useEffect, ' +
        'Card, StatTile and so on.',
    },
    {
      pattern: /\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b/,
      message:
        'View code MUST NOT reach the network — it only renders. ' +
        'If you need a changing value, add a `states` entry ' +
        '(it runs on the server on its own interval), and the result ' +
        'lands in `data` automatically.',
    },
    {
      pattern: /\b(localStorage|sessionStorage|indexedDB)\b|\bdocument\s*\.\s*cookie\b/,
      message:
        'Do not write to browser storage (localStorage, cookie) — the view must be ' +
        'stateless. Use `useState` for transient state.',
    },
  ]

  for (const { pattern, message } of patterns) {
    if (pattern.test(source)) errors.push(message)
  }

  return errors
}

/**
 * Turns a `Bun.build` error log into text the AI can read.
 *
 * The messages are SHORTENED: the full bundler output is long and contains
 * temporary paths — useless noise for the model.
 */
function logsToText(error: unknown): string[] {
  // Bun throws an `AggregateError` with the real reasons inside `errors`. The
  // shape depends on the version, so it is unwrapped carefully — falling over
  // here is absolutely not acceptable.
  const collected: string[] = []

  const add = (item: unknown) => {
    const text = typeof item === 'string' ? item : item instanceof Error ? item.message : String(item)
    const trimmed = text.trim()
    if (trimmed && !collected.includes(trimmed)) collected.push(trimmed)
  }

  if (error && typeof error === 'object' && 'errors' in error) {
    const inner = (error as { errors?: unknown }).errors
    if (Array.isArray(inner)) inner.slice(0, 10).forEach(add)
  }

  if (collected.length === 0) add(error)

  return collected.length > 0 ? collected : ['The code did not compile (reason unknown)']
}

/**
 * Turns JSX source into JS for the browser.
 *
 * IT DOES NOT THROW — the result comes back as `{ ok, errors }` (the same
 * philosophy as `manifest-validate.ts`). The caller drops the broken code and
 * saves the manifest without the `view`.
 */
export async function buildView(source: string): Promise<BuildResult> {
  // An empty source is NOT AN ERROR for the bundler — it happily builds an
  // empty module. But for a dashboard that is useless: the view would draw
  // nothing. So we stop it here and tell the AI plainly.
  if (source.trim().length === 0) {
    return { ok: false, errors: ['The view code is empty'] }
  }

  const forbidden = findForbidden(source)
  if (forbidden.length > 0) return { ok: false, errors: forbidden }

  const ENTRY = 'view.jsx'
  // The user's code is imported under this name (see the comment below)
  const COMPONENT = 'component.jsx'

  try {
    const build = await Promise.race([
      Bun.build({
        entrypoints: [ENTRY],
        target: 'browser',
        // ┌──────────────────────────────────────────────────────────┐
        // │ IIFE, NOT ESM. The code is handed to the browser through  │
        // │ `new Function(...)` (`AiView.tsx`), so there is no module │
        // │ context: the `export {}` in ESM output would raise        │
        // │ "Unexpected token 'export'".                              │
        // │                                                          │
        // │ An IIFE runs on its own and writes the result into        │
        // │ `__result__` — the wrapper then `return`s it.             │
        // └──────────────────────────────────────────────────────────┘
        format: 'iife',
        // Minification is DELIBERATELY off: when something goes wrong, the
        // line numbers in the browser console should line up with the code the
        // AI wrote (for auditing and for fixing it).
        minify: false,
        jsx: {
          runtime: 'classic',
          factory: 'React.createElement',
          fragment: 'React.Fragment',
          development: false,
        },
        plugins: [
          {
            name: 'in-memory-source',
            setup(build) {
              // The code is in memory, not on disk. There are two "files":
              //   ENTRY      — our wrapper (which writes to the global)
              //   COMPONENT  — the source written by the AI
              build.onResolve({ filter: /.*/ }, (arg) => {
                if (arg.path === ENTRY) return { path: ENTRY, namespace: 'view' }
                if (arg.path === COMPONENT || arg.path === `./${COMPONENT}`) {
                  return { path: COMPONENT, namespace: 'view' }
                }
                // Any other path is an attempted import.
                //
                // We normally NEVER GET HERE: `findForbidden` stops imports
                // earlier with an understandable message (Bun's `onLoad` API
                // does not let us return our own error text, which is why the
                // check lives there).
                //
                // This branch is a FALLBACK: if some shape the pattern missed
                // (a dynamic `import()`, say) reaches the bundler, it should
                // come back as an error rather than crash.
                return { path: arg.path, namespace: 'forbidden', external: true }
              })
              build.onLoad({ filter: /.*/, namespace: 'view' }, (arg) => {
                if (arg.path === ENTRY) {
                  // THE WRAPPER: it imports the AI's code and writes the
                  // component into `__result__`. The browser side runs the code
                  // inside `new Function` and returns that variable
                  // (`AiView.tsx`).
                  //
                  // `globalThis` IS DELIBERATELY NOT USED: a single page may
                  // hold several dashboards and they would overwrite each
                  // other's global.
                  return {
                    contents: [
                      `import * as mod from './${COMPONENT}'`,
                      '__result__ = mod.default || mod.View',
                    ].join('\n'),
                    loader: 'js',
                  }
                }
                return { contents: source, loader: 'jsx' }
              })
            },
          },
        ],
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Compilation took too long')), BUILD_TIMEOUT_MS),
      ),
    ])

    // Bun usually THROWS on an error, but `success: false` is possible too —
    // both routes are covered.
    if (!build.success) {
      return { ok: false, errors: build.logs.map((l) => String(l).trim()).filter(Boolean) }
    }

    const output = build.outputs[0]
    if (!output) return { ok: false, errors: ['The compilation produced no output'] }

    // Wrap the output into a shape `new Function` can run: the IIFE writes to
    // `__result__` and we return it.
    //
    // `</script` is escaped regardless: even though the code is not inlined
    // right now, it travels in a JSON response and may end up in HTML in
    // future — sanitising it once is safer (this bug has actually been seen in
    // the browser, see the comment on `escapeForScript`).
    const raw = escapeForScript(await output.text())
    const code = ['let __result__;', raw, 'return __result__;'].join('\n')
    return { ok: true, code, hash: codeHash(source), errors: [] }
  } catch (error) {
    return { ok: false, errors: logsToText(error) }
  }
}
