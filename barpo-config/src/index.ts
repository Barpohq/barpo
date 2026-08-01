// @barpo/config — the platform's settings layer.
//
// Usage:
//
//   import { config } from '@barpo/config'
//   const { config: settings, warnings } = config({ workDir })
//   settings.agent.compaction.reserveTokens   // → 16384
//
// Reading the config NEVER throws: if the file is missing, malformed or has
// bad values, the defaults are used and the reason lands in `warnings`.
// The platform always starts.

export {
  FIELDS,
  type Config,
  type FieldSpec,
  type FieldKind,
  type PartialConfig,
} from './schema.ts'

export {
  mergeConfigs,
  validateConfig,
  validateField,
  defaultConfig,
  readByPath,
  writeByPath,
  type ConfigWarning,
  type ValidationResult,
} from './validate.ts'

export {
  CONFIG_FILE,
  PROJECT_DIR,
  config,
  readConfig,
  refreshConfig,
  readConfigFile,
  globalConfigDir,
  applyProjectRestriction,
  type ConfigResult,
  type ReadOptions,
} from './read.ts'

export { buildSchema } from './schema-build.ts'
