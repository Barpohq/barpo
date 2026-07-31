import type { Migration } from './index.ts'

// Renames the two BUILT-IN SOURCE IDENTIFIERS that `013-english-rename.ts`
// left in Uzbek.
//
// WHY A SEPARATE MIGRATION. 013 translated the schema — table names, columns,
// CHECK values — but these two are stored VALUES that the TypeScript layer
// compares against by exact string:
//
//   `builtin-skills.ts`  BUILTIN_REPO       'standart-skilllar' → 'builtin-skills'
//                        BUILTIN_SOURCE_URL 'platforma://standart' → 'platforma://builtin'
//   `mcp-builtin.ts`     BUILTIN_MCP_SOURCE 'platforma-standart' → 'platforma-builtin'
//
// Both are duplicate-detection keys: `createSkillSource` matches on
// `(owner, repo, ref)` and `createMcpSource` on `(kind, source_name, ref)`.
// Changing the constant WITHOUT rewriting the stored rows would make the
// lookup miss on the next start-up, and a SECOND builtin source row would be
// created next to the old one — the user would see every builtin skill and MCP
// server twice.
//
// The `url` column is rewritten as well: it is what the UI displays, so
// leaving it would show `platforma://standart` under an otherwise English
// interface.
//
// Narrow WHERE clauses on purpose: only the rows the platform itself created
// are touched. A source the user happened to name `platforma-standart` by hand
// is not ours to rename — hence the `kind = 'builtin'` guard.

export const migration: Migration = {
  number: 14,
  name: 'builtin-source-rename',
  sql: `
    UPDATE skill_sources
       SET repo = 'builtin-skills',
           url  = 'platforma://builtin'
     WHERE owner = 'platforma'
       AND repo  = 'standart-skilllar';

    UPDATE mcp_sources
       SET source_name = 'platforma-builtin'
     WHERE kind        = 'builtin'
       AND source_name = 'platforma-standart';
  `,
}
