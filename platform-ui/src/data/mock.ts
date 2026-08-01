// Mock data — demo mode. The numbers come from the project's real history
// (roadmap 2026-07-26: 247 clusters, 151 accepted, $0.037/post, approval 96%).
//
// THE TYPES now live in the @barpo/shared package (platform-shared/src/types.ts) —
// the backend uses the very same types. This file re-exports them, so imports like
// `import { Agent } from '../data/mock'` in the pages keep working. When the backend
// is wired up only the DATA is swapped out.

// Types used as annotations in this file
import type {
  Agent,
  AppManifest,
  AuditEntry,
  BuildPlan,
  LlmCall,
  ToolCard,
  WorkflowStep,
} from '@barpo/shared'

export type {
  Agent,
  AgentStatus,
  AppManifest,
  AuditEntry,
  AuditLevel,
  BuildPlan,
  BuildStep,
  ChatMessage,
  ChatSession,
  BuildSession,
  DeployOption,
  LlmCall,
  Skill,
  StatItem,
  ToolCard,
  Widget,
  WorkflowStep,
} from '@barpo/shared'

export const agents: Agent[] = [
  {
    id: 'ai-news-bot',
    name: 'ai-news-bot',
    desc: 'Collects AI news from 32 sources, ranks it, enriches it and publishes to a Telegram channel',
    status: 'running',
    schedule: 'Daily at 06:00 / 12:00 / 18:00 (Tashkent)',
    nextRun: 'Today 18:00',
    todayCost: 0.081,
    todayCalls: 214,
    model: 'opus-5 (writer) · gemini-flash (rank)',
    metrics: [
      { label: 'Clusters today', value: '247' },
      { label: 'Accepted / rejected', value: '151 / 96' },
      { label: 'Posts written', value: '5' },
      { label: 'Published', value: '4' },
    ],
  },
  {
    id: 'server-monitor',
    name: 'server-monitor',
    desc: 'Checks 5 servers over SSH; on trouble it explains the issue with an LLM and sends a Telegram alert',
    status: 'idle',
    schedule: 'Every 10 minutes',
    nextRun: 'in 4 minutes',
    todayCost: 0.003,
    todayCalls: 4,
    model: 'gemini-flash (diagnostics)',
    metrics: [
      { label: 'Checks today', value: '86' },
      { label: 'Alerts', value: '1' },
      { label: 'Diagnostic calls', value: '4' },
      { label: 'Average cost', value: '$0.0007' },
    ],
  },
]

export const workflowSteps: WorkflowStep[] = [
  { id: 'collector', name: 'Collector', desc: 'RSS + HN + Reddit', status: 'done', stat: '412 items', detail: 'Collected from 32 sources, 3 of them via Google News' },
  { id: 'dedup', name: 'Dedup', desc: 'Embedding + clustering', status: 'done', stat: '247 clusters', detail: 'Duplicates merged using a 7-day window' },
  { id: 'rank', name: 'Rank', desc: 'Scoring + spam filter', status: 'done', stat: '151 accepted', detail: '96 rejected (24 spam) · $0.047 · 0 errors' },
  { id: 'enricher', name: 'Enricher', desc: 'Web search + fetch', status: 'done', stat: '26 enriched', detail: '16 fetches, 10 Tavily searches · 62 → 4805 chars' },
  { id: 'writer', name: 'Writer', desc: 'Post in channel style', status: 'done', stat: '5 posts', detail: '840 chars on average · $0.037/post · opus-5' },
  { id: 'approval', name: 'Approval', desc: 'Human sign-off', status: 'running', stat: '4 ✓ · 1 pending', detail: 'Sent to the private chat, 1 post is awaiting an answer' },
  { id: 'publisher', name: 'Publisher', desc: 'Telegram channel', status: 'waiting', stat: '4 published', detail: 'The duplicate filter dropped 1 post automatically' },
]

// 7-day cost (USD) — broken down by agent
export const costDays = [
  { day: 'Mon', newsBot: 0.092, monitor: 0.004 },
  { day: 'Tue', newsBot: 0.078, monitor: 0.003 },
  { day: 'Wed', newsBot: 0.104, monitor: 0.006 },
  { day: 'Thu', newsBot: 0.083, monitor: 0.003 },
  { day: 'Fri', newsBot: 0.117, monitor: 0.004 },
  { day: 'Sat', newsBot: 0.069, monitor: 0.003 },
  { day: 'Sun', newsBot: 0.081, monitor: 0.003 },
]

export const modelCosts = [
  { model: 'claude-opus-5', task: 'Writer', cost: 1.82 },
  { model: 'gemini-3-flash', task: 'Rank + diagnostics', cost: 0.31 },
  { model: 'deepseek-v4', task: 'Language trial (candidate)', cost: 0.14 },
  { model: 'bge-m3 (local)', task: 'Embedding', cost: 0.0 },
]

export const llmCalls: LlmCall[] = [
  { time: '12:04:18', agent: 'ai-news-bot', model: 'claude-opus-5', task: 'writer · post #5', tokens: '3.1k → 412', cost: '$0.0371' },
  { time: '12:03:52', agent: 'ai-news-bot', model: 'claude-opus-5', task: 'writer · post #4', tokens: '2.8k → 388', cost: '$0.0344' },
  { time: '12:01:07', agent: 'ai-news-bot', model: 'gemini-3-flash', task: 'rank · 40 clusters', tokens: '18.2k → 1.4k', cost: '$0.0061' },
  { time: '12:00:41', agent: 'ai-news-bot', model: 'gemini-3-flash', task: 'rank · 40 clusters', tokens: '17.9k → 1.3k', cost: '$0.0059' },
  { time: '11:50:12', agent: 'server-monitor', model: 'gemini-3-flash', task: 'diagnostics · helsinki-1 disk', tokens: '2.2k → 310', cost: '$0.0007' },
  { time: '06:02:33', agent: 'ai-news-bot', model: 'gemini-3-flash', task: 'rank · 34 clusters', tokens: '15.1k → 1.2k', cost: '$0.0052' },
]

export const auditLog: AuditEntry[] = [
  { time: '12:06', actor: 'ai-news-bot', action: 'Post published', target: 't.me/channel/6', level: 'write', result: 'approved' },
  { time: '12:04', actor: 'firdavs', action: 'Post approved (✅)', target: 'post #4', level: 'write', result: 'OK' },
  { time: '11:50', actor: 'server-monitor', action: 'Disk usage read', target: 'helsinki-1', level: 'read', result: 'OK' },
  { time: '11:50', actor: 'server-monitor', action: 'Alert sent', target: 'admin chat', level: 'read', result: 'OK' },
  { time: '11:32', actor: 'claude-code', action: 'tmux session opened', target: 'frankfurt-1', level: 'write', result: 'approved' },
  { time: '11:31', actor: 'firdavs', action: 'Deploy request (via chat)', target: 'frankfurt-1', level: 'write', result: 'OK' },
  { time: '10:14', actor: 'ai-news-bot', action: 'Tavily search call', target: 'enricher', level: 'read', result: 'OK' },
  { time: '09:00', actor: 'ai-news-bot', action: 'Health report sent', target: 'admin chat', level: 'read', result: 'OK' },
  { time: '08:47', actor: 'skill:postgres-backup', action: 'DROP TABLE attempt blocked', target: 'db-01', level: 'dangerous', result: 'denied' },
  { time: '06:00', actor: 'ai-news-bot', action: 'Pipeline started', target: 'helsinki-1', level: 'read', result: 'OK' },
  { time: '05:55', actor: 'server-monitor', action: 'Restart proposal', target: 'nyc-1 · nginx', level: 'write', result: 'pending' },
  { time: '00:12', actor: 'berlin-1 daemon', action: 'Daily backup', target: 'sqlite → berlin-1', level: 'write', result: 'approved' },
]


// Canned chat replies (demo mode only — removed once the backend is wired up)
export interface CannedReply {
  match: string[]
  toolCard?: ToolCard
  text: string
  approval?: boolean
}

export const pendingPost = {
  title: 'Language trial results: small models can write too',
  body: "🔬 DeepSeek V4 and Gemini 3 Flash were tested on writing posts in the channel's style. Across a 20-post comparison Flash passed editorial review in 17/20 cases — at 14× lower cost than Opus 5. Next week the writer stage moves to Flash step by step, with an automatic rollback if quality drops.\n\n💰 Expected saving: ~$0.9/mo → $0.06/mo",
  cluster: 'cluster #291 · 3 sources',
}

export const cannedReplies: CannedReply[] = [
  {
    match: ['today', 'what did'],
    toolCard: {
      tool: 'bot.stats',
      args: '{ "period": "today" }',
      result: '247 clusters · 151 accepted · 5 posts · 4 published · $0.084',
    },
    text: "Your bot collected 412 items from 32 sources today, merged into 247 clusters. The rank stage accepted 151 of them (24 spam filtered out), the writer produced 5 posts — 4 went to the channel and 1 is awaiting approval. Total cost today: $0.084.",
  },
  {
    match: ['server', 'status'],
    toolCard: {
      tool: 'monitor.status',
      args: '{ "all": true }',
      result: '4 healthy · 1 warning (helsinki-1 disk 84%)',
    },
    text: 'Four of the five servers are fully healthy. On helsinki-1 the disk has reached 84% — mostly the models_cache folder (embedding models). I can prepare a cleanup command if you like; it sits at the "write" level, so it runs once you approve it.',
  },
  {
    match: ['approval', 'post'],
    toolCard: {
      tool: 'bot.pending',
      args: '{}',
      result: '1 post pending (cluster #291)',
    },
    text: 'One post is awaiting approval:',
    approval: true,
  },
  {
    match: ['cost', 'how much'],
    toolCard: {
      tool: 'llm.costs',
      args: '{ "period": "7 days" }',
      result: 'total $0.65 · most expensive: writer (opus-5)',
    },
    text: "$0.65 was spent over the last 7 days. The largest share is ai-news-bot's writer stage (claude-opus-5, $0.037/post). Once the language trial ends and the writer moves to a cheaper model, the monthly cost drops roughly 5×. Each app's cost is shown on its own page.",
  },
]

export const fallbackReply =
  'This is demo mode — the orchestrator is not connected yet, so only the prepared scenarios work. Try the suggestion buttons below: bot statistics, server status, posts awaiting approval or costs.'

export const botLogLines = [
  '06:00:01 [scheduler] pipeline started (daily run #212)',
  '06:00:02 [collector] 32 sources queued',
  '06:00:14 [collector] openai-blog: 403 → search fallback',
  '06:00:38 [collector] 412 items collected (9.2s)',
  '06:01:02 [dedup] embedding: 412 items → bge-m3 (local)',
  '06:01:47 [dedup] 247 clusters (7-day window)',
  '06:02:10 [rank] gemini-3-flash · batch 1/7',
  '06:04:55 [rank] 151 accepted, 96 rejected (24 spam) · $0.047',
  '06:05:12 [enricher] 26 clusters enriched (16 fetches, 10 searches)',
  '06:08:30 [writer] post #1 written (784 chars) · $0.036',
  '06:09:02 [writer] post #2 written (911 chars) · $0.039',
  '06:09:41 [writer] duplicate filter: cluster 264 dropped (matching model ID)',
  '06:10:15 [approval] 5 posts sent to the private chat',
  '11:58:00 [publisher] 4 posts published to the channel',
  '12:06:44 [health] approval rate: 96% (30-day)',
]

// ---------------------------------------------------------------------------
// App modules — the platform's core idea: every program that gets built comes with
// a manifest and "brings" its own dashboard into the UI. Widgets arrive as a schema
// (data) that the host UI renders dynamically — no frontend rebuild for a new app.
// ---------------------------------------------------------------------------

export const installedApps: AppManifest[] = [
  {
    id: 'ai-news-bot',
    icon: '📰',
    name: 'ai-news-bot',
    tagline: 'Collects and ranks AI news, then publishes it to a Telegram channel',
    version: 'v1.4.2',
    service: 'helsinki-1 · docker · uptime 31 days',
    status: 'running',
    widgets: [
      {
        type: 'stats',
        items: [
          { label: 'Clusters today', value: '247' },
          { label: 'Published', value: '4', hint: '1 awaiting approval' },
          { label: 'Approval rate', value: '96%', accent: 'var(--color-lazur)' },
          { label: 'Cost today', value: '$0.084', accent: 'var(--color-gold)' },
        ],
      },
      {
        type: 'table',
        title: 'Recent posts',
        columns: ['Time', 'Title', 'Status'],
        rows: [
          ['12:06', 'Gemini 3 Flash price dropped 40%', 'published ✓'],
          ['12:04', 'Language trial results: small models', 'awaiting approval'],
          ['11:59', 'OpenAI announced a new realtime API', 'published ✓'],
          ['11:58', 'Mistral released an open-weights model', 'published ✓'],
          ['11:58', 'Claude Fable 5 benchmark results', 'published ✓'],
        ],
      },
      {
        type: 'bars',
        title: 'Source types (412 items today)',
        suffix: '',
        items: [
          { label: 'RSS (official blogs)', value: 214 },
          { label: 'Hacker News', value: 102 },
          { label: 'Reddit', value: 71 },
          { label: 'Google News (fallback)', value: 25 },
        ],
      },
      { type: 'note', text: 'Next run: today 18:00 (Tashkent). Once the language trial ends the writer moves to a cheaper model.' },
    ],
  },
]

// The new app that gets built when the user says "build me one" in chat
const expenseBotManifest: AppManifest = {
  id: 'expense-bot',
  icon: '💸',
  name: 'expense-bot',
  tagline: 'Records daily expenses over Telegram and produces a monthly report',
  version: 'v0.1.0',
  service: 'frankfurt-1 · docker sandbox · just deployed',
  status: 'running',
  widgets: [
    {
      type: 'stats',
      items: [
        { label: 'Entries today', value: '3', hint: 'last one: 14:02' },
        { label: 'Total today', value: '128k', accent: 'var(--color-gold)' },
        { label: 'July total', value: '2.4M' },
        { label: 'Daily average', value: '89k' },
      ],
    },
    {
      type: 'bars',
      title: 'By category (July)',
      suffix: '%',
      items: [
        { label: 'Food', value: 34 },
        { label: 'Transport', value: 18 },
        { label: 'Utilities', value: 15 },
        { label: 'Electronics', value: 12 },
        { label: 'Other', value: 21 },
      ],
    },
    {
      type: 'table',
      title: 'Recent entries',
      columns: ['Time', 'Note', 'Category', 'Amount'],
      rows: [
        ['14:02', 'Lunch', 'Food', '45 000'],
        ['11:30', 'Yandex taxi', 'Transport', '28 000'],
        ['09:15', 'Coffee', 'Food', '55 000'],
      ],
    },
    {
      type: 'logs',
      title: 'Service logs',
      lines: [
        '14:05:12 [bot] webhook connected: @expense_demo_bot',
        '14:05:12 [db] sqlite ready: 3 tables, 0 migrations pending',
        '14:05:13 [report] monthly report cron: 1st of each month at 08:00',
        '14:05:13 [health] handshake with the platform daemon OK',
      ],
    },
    { type: 'note', text: 'Bot: @expense_demo_bot · /report — monthly breakdown, /export — CSV. The sandbox can only reach the Telegram API.' },
  ],
}

// ---------------------------------------------------------------------------
// Build plans — the platform can create different kinds of projects: bots, static
// sites, full-stack apps. Each plan: steps + (optional) deploy choice + a finished
// manifest. In the real version this streams in from the orchestrator.
// ---------------------------------------------------------------------------

const portfolioManifest: AppManifest = {
  id: 'portfolio-site',
  icon: '🌐',
  name: 'portfolio-site',
  tagline: 'A one-page portfolio landing — static, with a contact form',
  version: 'v1.0.0',
  service: 'frankfurt-1 · caddy static',
  status: 'running',
  widgets: [
    {
      type: 'stats',
      items: [
        { label: 'Lighthouse', value: '98', hint: 'perf · 100 a11y · 100 SEO', accent: 'var(--color-lazur)' },
        { label: 'Size', value: '84 KB', hint: '3 files, no libraries' },
        { label: 'Build time', value: '1.2s' },
        { label: 'Status', value: 'live', accent: 'var(--color-mint)' },
      ],
    },
    {
      type: 'git',
      repo: 'git.platform.local/portfolio-site',
      branch: 'main',
      commits: [
        { hash: '9c2d7ee', msg: 'chore: caddy deploy configuration', time: 'now' },
        { hash: '4be9d01', msg: 'feat: hero, services, contact form', time: '1 minute ago' },
        { hash: 'aa10f2c', msg: 'init: design tokens and skeleton', time: '2 minutes ago' },
      ],
    },
    { type: 'note', text: 'To change it, just say so in chat: "add a blog section to the portfolio site" — every change is committed to git and can be rolled back.' },
  ],
}

const crmManifest: AppManifest = {
  id: 'orders-crm',
  icon: '📦',
  name: 'orders-crm',
  tagline: 'FastAPI + React — an order management system (deployed from GitHub)',
  version: 'v2.3.1',
  service: 'frankfurt-1 + db-01 · docker',
  status: 'running',
  widgets: [
    {
      type: 'stats',
      items: [
        { label: 'API endpoints', value: '24' },
        { label: 'Tests', value: '61/61', accent: 'var(--color-mint)' },
        { label: 'Migrations', value: '12/12' },
        { label: 'Deploy time', value: '3m 12s' },
      ],
    },
    {
      type: 'deploy',
      url: 'https://crm.my-domain.com',
      kind: 'domain',
      server: 'frankfurt-1',
      ssl: "Let's Encrypt · auto-renewed",
      extra: 'backend :8000 (internal only) · frontend nginx static',
    },
    {
      type: 'git',
      repo: 'github.com/firdavs/orders-crm',
      branch: 'main',
      commits: [
        { hash: '8f4e2cd', msg: 'deploy: added the platform manifest', time: 'now' },
        { hash: 'b3c90f1', msg: 'feat: PDF export', time: 'yesterday' },
        { hash: 'e7d21aa', msg: 'fix: order filter date', time: '2 days ago' },
      ],
    },
    {
      type: 'table',
      title: 'Services',
      columns: ['Service', 'Status', 'Address'],
      rows: [
        ['backend (gunicorn)', 'running', 'frankfurt-1:8000'],
        ['frontend (nginx)', 'running', 'crm.my-domain.com'],
        ['postgres 16', 'running', 'db-01:5432'],
        ['redis (queue)', 'running', 'local'],
      ],
    },
    { type: 'note', text: 'Skill used: FastAPI Deploy v1.1. The next update is one sentence away: "redeploy the crm from main" — git pull, migrations, zero-downtime restart.' },
  ],
}

export const buildPlans: BuildPlan[] = [
  {
    id: 'portfolio-site',
    keywords: ['landing', 'site', 'website', 'web', 'portfolio'],
    intro: "Great — I've started writing the portfolio landing. It will be static (no libraries, fast), and the code is versioned in the platform's local git. Once it's ready I'll ask you where to publish it:",
    toolCard: {
      tool: 'builder.create',
      args: '{ "type": "static-site", "name": "portfolio-site" }',
      result: 'sandbox ready · git repo created · frankfurt-1',
    },
    steps: [
      { text: 'Requirements: one-page portfolio · static · contact form', kind: 'info' },
      { text: '● design: token palette + typography chosen', kind: 'tool' },
      { text: '● written: index.html · styles.css · app.js (84 KB, no libraries)', kind: 'tool' },
      { text: '● git: 3 commits (init → feat → deploy config)', kind: 'tool' },
      { text: '  ⎿ Lighthouse: 98 perf · 100 a11y · 100 SEO', kind: 'out' },
      { text: '✓ site ready — pick a deploy target', kind: 'done' },
    ],
    choice: {
      question: 'Where should I publish it?',
      options: [
        {
          label: '🌐 Connect the portfolio.com domain',
          steps: [
            { text: '● DNS: portfolio.com → frankfurt-1 (A record)', kind: 'tool' },
            { text: "● caddy: virtual host + Let's Encrypt SSL", kind: 'tool' },
            { text: '✓ live: https://portfolio.com', kind: 'done' },
          ],
          widget: {
            type: 'deploy',
            url: 'https://portfolio.com',
            kind: 'domain',
            server: 'frankfurt-1',
            ssl: "Let's Encrypt · auto-renewed",
            extra: 'caddy static · gzip + cache configured',
          },
        },
        {
          label: '🔌 Preview on a port (I want to look first)',
          steps: [
            { text: '● preview port opened: 8091 (only for your IP)', kind: 'tool' },
            { text: '✓ preview: http://frankfurt-1:8091', kind: 'done' },
          ],
          widget: {
            type: 'deploy',
            url: 'http://frankfurt-1:8091',
            kind: 'port',
            server: 'frankfurt-1',
            extra: 'To attach a domain later, just say: "connect the portfolio site to a domain"',
          },
        },
      ],
    },
    manifest: portfolioManifest,
  },
  {
    id: 'orders-crm',
    keywords: ['github', 'deploy', 'crm', 'python'],
    intro: "I cloned and analysed your GitHub project — FastAPI + React + Postgres. That's a big job, so I'll pull the FastAPI Deploy skill from the store (its permissions will be shown) and let it drive the whole chain:",
    toolCard: {
      tool: 'builder.deploy',
      args: '{ "source": "github.com/firdavs/orders-crm" }',
      result: 'clone OK · stack: FastAPI + React + Postgres',
    },
    steps: [
      { text: 'git clone github.com/firdavs/orders-crm · analysis', kind: 'info' },
      { text: '  ⎿ detected: FastAPI backend · React frontend · PostgreSQL · redis', kind: 'out' },
      { text: '● skill loaded: FastAPI Deploy v1.1 (from the store, permissions approved)', kind: 'tool' },
      { text: '● backend: venv · gunicorn · systemd — connected to postgres on db-01', kind: 'tool' },
      { text: '● frontend: bun run build → nginx static', kind: 'tool' },
      { text: '  ⎿ migrations 12/12 · tests 61/61 passed', kind: 'out' },
      { text: '● domain: crm.my-domain.com → SSL installed', kind: 'tool' },
      { text: '✓ live: https://crm.my-domain.com — all of it in the audit log', kind: 'done' },
    ],
    manifest: crmManifest,
  },
  {
    id: 'expense-bot',
    keywords: ['build a bot', 'make a bot', 'create a bot', 'tracker bot'],
    intro: "Got it. I've prepared a sandbox for the expense-tracking Telegram bot — Claude Code has started writing in the background. The process is live, and in Pro mode you can watch the tmux session too:",
    toolCard: {
      tool: 'builder.create',
      args: '{ "type": "telegram-bot", "name": "expense-bot" }',
      result: 'sandbox ready · frankfurt-1 · permission: Telegram API only',
    },
    steps: [
      { text: 'Requirements: Telegram bot · SQLite · monthly report · categories', kind: 'info' },
      { text: '● claude-code · tmux session opened (frankfurt-1, sandbox)', kind: 'tool' },
      { text: '  ⎿ skeleton written: bot/ db/ report/ — 14 files', kind: 'out' },
      { text: '  ⎿ tests: 18/18 passed', kind: 'out' },
      { text: '● docker image built: expense-bot:0.1.0 (42 MB)', kind: 'tool' },
      { text: '● deploy: frankfurt-1 · permission: Telegram API only (write level)', kind: 'tool' },
      { text: '● manifest registered: 5 widgets · adding to the sidebar', kind: 'tool' },
      { text: '✓ expense-bot is up — all of it in the audit log', kind: 'done' },
    ],
    manifest: expenseBotManifest,
  },
]

// Generic "build / create" wording with no matching plan — fall back to the bot plan
export const genericBuildWords = ['build', 'create', 'make', 'set up']

export const tmuxLines = [
  { text: '$ claude -p "analyse models_cache on helsinki-1"', kind: 'cmd' },
  { text: '● connecting to helsinki-1 over SSH...', kind: 'info' },
  { text: '● Bash(du -sh /opt/ai-news-bot/models_cache/*)', kind: 'tool' },
  { text: '  ⎿ 3.1G  bge-m3', kind: 'out' },
  { text: '  ⎿ 1.8G  bge-m3-unused-snapshot-0612', kind: 'out' },
  { text: '  ⎿ 0.4G  tokenizers', kind: 'out' },
  { text: '● Stale snapshot found: bge-m3-unused-snapshot-0612 (1.8G)', kind: 'info' },
  { text: '● Deleting it would bring the disk from 84% down to 61%.', kind: 'info' },
  { text: '● Deletion is at the "write" level — asking for approval...', kind: 'warn' },
  { text: '⏸ Awaiting human approval (from chat or right here)', kind: 'wait' },
]
