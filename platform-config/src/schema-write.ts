// Updates `schema.json`. Run it with:
//
//   bun run platform-config/src/schema-write.ts
//
// This script has to be re-run whenever `FIELDS` in `schema.ts` changes.
// `schema.test.ts` catches a stale file — so it cannot be forgotten.

import { writeFileSync } from 'node:fs'
import { buildSchema } from './schema-build.ts'

const path = new URL('../schema.json', import.meta.url).pathname
writeFileSync(path, `${JSON.stringify(buildSchema(), null, 2)}\n`)
console.log(`schema.json updated: ${path}`)
