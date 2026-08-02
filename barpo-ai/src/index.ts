// @barpo/ai — the platform's AI layer.
//
// The server uses only two things from this package:
//   detectModels()       — which providers on this machine are ready to use
//   conversationStream() — a streaming reply from the selected model
//
// All the provider details (keys, OAuth, Ollama) stay inside this package —
// the server does not know about them. In the next stage the tools will be
// added here as well.

export {
  cachedResult,
  setCache,
  clearCache,
  detectModels,
  modelsCollection,
  EXPIRY_MARGIN,
  DEFAULT_CREDENTIALS_PATH,
  type DetectResult,
  type DetectOptions,
} from './detect.ts'

export { writeToCodex, type SyncResult } from './source-sync.ts'

export { FileCredentialStore, MemoryCredentialStore } from './credentials.ts'

export {
  claudeCodeAuth,
  codexAuth,
  localAuths,
  type LocalAuthResult,
  type LocalAuthFound,
} from './local-auth.ts'

export {
  OLLAMA_ID,
  OLLAMA_SOURCE,
  ollamaBaseUrl,
  ollamaModels,
  ollamaProvider,
} from './ollama.ts'

export {
  DEFAULT_SYSTEM_PROMPT,
  conversationStream,
  type Usage,
  type ConversationEvent,
  type ConversationOptions,
  type ConversationMessage,
} from './conversation.ts'

// --- The tool-using agent layer ---

export {
  AGENT_SYSTEM_PROMPT,
  agentStream,
  attachmentNote,
  classifierHistory,
  nonTextBlocks,
  lastUserIndex,
  type AgentEvent,
  type AgentOptions,
  type McpProvider,
} from './agent.ts'

export {
  commandName,
  commandLists,
  assessCommand,
  splitCommand,
  isForbidden,
  type CommandAssessment,
  type CommandCategory,
} from './command-analysis.ts'

export { isConstraint, extractConstraints } from './constraints.ts'

// --- Project context: the AGENTS.md / CLAUDE.md in the working directory ---

export {
  CONTEXT_LIMIT,
  CONTEXT_FILES,
  contextToPrompt,
  readProjectContext,
  type ProjectContext,
} from './project-context.ts'

// --- Skills: parsing SKILL.md and wiring it into the prompt ---

export {
  NAME_LIMIT,
  parseSkillFile,
  DESCRIPTION_LIMIT,
  type SkillFile,
} from './skill-file.ts'

export {
  SKILL_DIR,
  SKILL_COUNT_LIMIT,
  readSkills,
  skillsToPrompt,
  type LoadedSkill,
} from './skill-load.ts'

// --- Project memory: the long-lived facts the agent writes itself ---

export {
  readMemoryIndex,
  MEMORY_FILE_LIMIT,
  MEMORY_INDEX_LIMIT,
  MEMORY_INDEX,
  MEMORY_DIR,
  MEMORY_COUNT_LIMIT,
  MEMORY_KINDS,
  readMemories,
  memoriesToPrompt,
  type Memory,
} from './memory.ts'

// --- Context: persisting tool results, and compaction ---

export {
  dropOldest,
  cutPoint,
  buildContext,
  contextTokens,
  compact,
  needsCompaction,
  truncateToolResults,
  type StoredMessage,
  type CompactionResult,
  type CompactionOptions,
  type HistoryOptions,
  type MessageAttachment,
} from './context.ts'

// --- Tool hooks ---

export {
  afterChain,
  observerHook,
  redactSecrets,
  redactSecretsHook,
  beforeChain,
  extraDenyHook,
  lengthHook,
  type AfterResult,
  type BeforeResult,
  type ToolCallContext,
  type ToolHook,
  type ToolResultContext,
} from './hooks.ts'

export {
  assessAction,
  CLASSIFIER_BY_PROVIDER,
  CLASSIFIER_PROMPT,
  CLASSIFIER_TIMEOUT_MS,
  pickClassifierModel,
  requestToText,
  type ClassifierResult,
  type ClassifierRequest,
  type ClassifierMessage,
} from './classifier.ts'

export {
  TOTAL_BLOCK_LIMIT,
  CONSECUTIVE_BLOCK_LIMIT,
  ModeManager,
  modeManagerCount,
  modeManager,
  closeModeManager,
  clearModes,
  type ModeListener,
  type ModeChange,
} from './mode.ts'

export {
  RestrictedEnv,
  DEFAULT_COMMAND_TIMEOUT_MS,
  type RestrictedEnvOptions,
} from './environment.ts'

export {
  PERMISSION_WAIT_MS,
  PermissionManager,
  permissionManagerCount,
  permissionManager,
  closePermissionManager,
  clearPermissions,
  type ClassifierContext,
  type VerdictListener,
  type PermissionAsk,
  type RequestListener,
} from './permission.ts'

export {
  REGISTRY_LIMIT,
  REGISTRY_TTL_MS,
  SessionRegistry,
  type Closable,
} from './registry.ts'

// --- Search tools: grep / find / ls ---

export {
  checkBoundary,
  FIND_LIMIT,
  globMatches,
  globToRegExp,
  GREP_LIMIT,
  isInside,
  isBinary,
  LS_LIMIT,
  matchOrder,
  relativePath,
  ROW_LIMIT,
  prepareLine,
  setRgCache,
  rgAvailable,
  SKIPPED_DIRS,
  pathOrder,
  type BoundaryResult,
  type GrepMatch,
  type DirEntry,
  type SearchResult,
} from './search-core.ts'

export {
  BoundaryError,
  findNode,
  findSearch,
  findRg,
  grepNode,
  grepSearch,
  grepRg,
  lsList,
  PatternError,
  type FindOptions,
  type GrepOptions,
  type LsOptions,
} from './search-engine.ts'

export {
  findResultToText,
  createFindTool,
  grepResultToText,
  createGrepTool,
  lsResultToText,
  createLsTool,
  sizeToText,
  SEARCH_PROMPT_SECTION,
  searchTools,
  searchToolsRaw,
  type FindToolInput,
  type GrepToolInput,
  type LsToolInput,
  type SearchDetail,
  type SearchTool,
} from './search-tools.ts'

export {
  DASHBOARD_PROMPT_SECTION,
  createAppDeleteTool,
  createAppPublishTool,
  dashboardTools,
  dashboardToolsRaw,
  resultToText,
  type AppDeleteInput,
  type AppPublishInput,
  type DashboardDeleteDetail,
  type DashboardDeleteResult,
  type DashboardRemover,
  type DashboardSink,
  type DashboardResult,
  type DashboardDetail,
} from './dashboard-tools.ts'

export {
  SCHEDULE_PROMPT_SECTION,
  createScheduleCreateTool,
  createScheduleDeleteTool,
  createScheduleListTool,
  scheduleTools,
  scheduleToolsRaw,
  type ScheduleCreateInput,
  type ScheduleCreateResult,
  type ScheduleDeleteInput,
  type ScheduleDeleteResult,
  type ScheduleDetail,
  type ScheduleLister,
  type ScheduleListInput,
  type ScheduleRemover,
  type ScheduleSink,
  type ScheduleSummary,
} from './schedule-tools.ts'

export {
  detectUrls,
  killAllBackgroundProcesses,
  liveBackgroundProcessCount,
  MAX_OUTPUT_CHARS,
  MAX_PROCESSES,
  PROCESS_KILL_GRACE_MS,
  PROCESS_TTL_MS,
  ProcessManager,
  processManager,
  closeProcessManager,
  processManagerCount,
  clearProcessManagers,
  type ProcessOutput,
  type ProcessSnapshot,
  type ProcessStatus,
} from './process-manager.ts'

export {
  PROCESS_PROMPT_SECTION,
  createProcessListTool,
  createProcessOutputTool,
  createProcessStartTool,
  createProcessStopTool,
  processToolsRaw,
  START_WAIT_DEFAULT_S,
  START_WAIT_MAX_S,
  type ProcessDetail,
  type ProcessIdInput,
  type ProcessListInput,
  type ProcessStartInput,
} from './process-tools.ts'

export {
  SERVER_PROMPT_SECTION,
  createServerListTool,
  serversToText,
  serverTools,
  serverToolsRaw,
  type ServerListInput,
  type ServerProvider,
  type ServerDetail,
  type ServerRecord,
} from './server-tools.ts'

// --- The MCP (Model Context Protocol) client ---
//
// The server does not use `McpClient` from this layer DIRECTLY — it hands
// `agentStream()` an `mcpProvider` function and this package handles the rest
// (the same inversion as `serverProvider`/`dashboardSink`). The exports are
// open for tests and diagnostics.

export {
  isResponse,
  MCP_PROTOCOL_VERSION,
  parseCallResult,
  parseTools,
  type JsonRpcResponse,
  type JsonRpcIncoming,
  type JsonRpcRequest,
  type JsonRpcNotification,
  type JsonRpcError,
  type McpServerInfo,
  type McpToolResult,
  type McpToolSpec,
} from './mcp-protocol.ts'

export {
  sanitiseEnv,
  killAllMcpProcesses,
  HTTP_TIMEOUT_MS,
  createHttpTransport,
  setProcessSpawner,
  KILL_GRACE_MS,
  parseSseMessages,
  createStdioTransport,
  liveProcessCount,
  type ProcessSpawner,
  type McpProcess,
  type McpTransport,
} from './mcp-transport.ts'

export {
  MCP_CALL_TIMEOUT_MS,
  MCP_HANDSHAKE_TIMEOUT_MS,
  McpClient,
  type McpConnectionOptions,
} from './mcp-client.ts'

export {
  argsToTarget,
  McpManager,
  mcpPattern,
  type McpToolListEntry,
  type McpConnectableServer,
} from './mcp-manager.ts'

export {
  MCP_PROMPT_SECTION,
  MCP_TOOL_PREFIX,
  isMcpTool,
  mcpTools,
  mcpToolsRaw,
  mcpToolName,
  safeToolName,
  type McpToolDetail,
} from './mcp-tools.ts'
