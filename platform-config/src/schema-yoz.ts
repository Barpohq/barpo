// `schema.json` ni yangilaydi. Ishga tushirish:
//
//   bun run platform-config/src/schema-yoz.ts
//
// `sxema.ts` dagi `MAYDONLAR` o'zgargach shu skriptni qayta ishga tushirish
// kerak. `schema.test.ts` fayl eskirganini ushlaydi — ya'ni unutib bo'lmaydi.

import { writeFileSync } from 'node:fs'
import { schemaYasa } from './schema-yasa.ts'

const yol = new URL('../schema.json', import.meta.url).pathname
writeFileSync(yol, `${JSON.stringify(schemaYasa(), null, 2)}\n`)
console.log(`schema.json yangilandi: ${yol}`)
