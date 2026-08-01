import type { Migration } from './index.ts'

// The platform got its public name — Barpo — and the stored builtin-source
// identifiers carry the old working title ("platforma") inside them.
//
// Same story as `014-builtin-source-rename.ts`: these are stored VALUES the
// TypeScript layer compares against by exact string:
//
//   `builtin-skills.ts`  BUILTIN_OWNER      'platforma' → 'barpo'
//                        BUILTIN_SOURCE_URL 'platforma://builtin' → 'barpo://builtin'
//   `mcp-builtin.ts`     BUILTIN_MCP_SOURCE 'platforma-builtin' → 'barpo-builtin'
//
// Both are duplicate-detection keys (`createSkillSource` matches on
// `(owner, repo, ref)`, `createMcpSource` on `(kind, source_name, ref)`).
// Changing the constants WITHOUT rewriting the stored rows would make the
// lookup miss on the next start-up and every builtin skill and MCP server
// would appear twice.
//
// The `url` column is what the UI shows, so it is rewritten too.
//
// Narrow WHERE clauses on purpose: the `kind = 'builtin'` guard keeps us from
// touching a source the user happened to name like ours by hand.

export const migration: Migration = {
  number: 18,
  name: 'barpo-rename',
  sql: `
    UPDATE skill_sources
       SET owner = 'barpo',
           url   = 'barpo://builtin'
     WHERE kind  = 'builtin'
       AND owner = 'platforma';

    UPDATE mcp_sources
       SET source_name = 'barpo-builtin'
     WHERE kind        = 'builtin'
       AND source_name = 'platforma-builtin';
  `,
}
