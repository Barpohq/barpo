/// <reference types="vite/client" />

/**
 * The platform version, injected at build time by `vite.config.ts` from the
 * workspace root package.json. Shown in the header — so a release bump is
 * enough and no UI file has to be edited.
 */
declare const __APP_VERSION__: string
