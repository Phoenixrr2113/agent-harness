export { createHarness } from './core/harness.js';
export type {
  CreateHarnessOptions,
  HarnessConfig,
  HarnessAgent,
  AgentRunResult,
  AgentState,
  HarnessDocument,
  Frontmatter,
  PrimitiveType,
  ContextBudget,
  IndexEntry,
  DeepPartial,
} from './core/types.js';
export { HarnessConfigSchema, FrontmatterSchema, CORE_PRIMITIVE_DIRS, getPrimitiveDirs } from './core/types.js';
export { loadConfig, writeDefaultConfig } from './core/config.js';
export { createLogger, setGlobalLogLevel, getGlobalLogLevel, log } from './core/logger.js';
export type { Logger, LogLevel } from './core/logger.js';
export { parseHarnessDocument, loadDirectory, loadDirectoryWithErrors, loadAllPrimitives, loadAllPrimitivesWithErrors, estimateTokens, getAtLevel } from './primitives/loader.js';
export type { ParseError, LoadResult, LoadAllResult } from './primitives/loader.js';
export { buildSystemPrompt } from './runtime/context-loader.js';
export type { LoadedContext } from './runtime/context-loader.js';
export { loadState, saveState } from './runtime/state.js';
export { getProvider, resetProvider, getModel, generate, generateWithMessages, streamGenerate, streamWithMessages } from './llm/provider.js';
export type { CallOptions, GenerateOptions, GenerateWithMessagesOptions, GenerateResult, StreamWithMessagesResult, ProviderName } from './llm/provider.js';
export { scaffoldHarness, listTemplates } from './cli/scaffold.js';
export type { ScaffoldOptions } from './cli/scaffold.js';
export { buildIndex, writeIndexFile, rebuildAllIndexes } from './runtime/indexer.js';
export type { IndexOptions } from './runtime/indexer.js';
export { createWatcher } from './runtime/watcher.js';
export { Scheduler, isQuietHours } from './runtime/scheduler.js';
export { synthesizeJournal, synthesizeJournalRange, listJournals, listUnjournaled, parseJournalSynthesis, compressJournals } from './runtime/journal.js';
export type { JournalEntry, JournalSynthesis, WeekSummary } from './runtime/journal.js';
export { proposeInstincts, installInstinct, learnFromSessions, harvestInstincts } from './runtime/instinct-learner.js';
export type { HarvestResult } from './runtime/instinct-learner.js';
export { fixCapability, evaluateCapability, installCapability, processIntake, downloadCapability } from './runtime/intake.js';
export type { DownloadResult } from './runtime/intake.js';
export { validateHarness, doctorHarness } from './runtime/validator.js';
export type { ValidationResult, DoctorResult } from './runtime/validator.js';
export { createSessionId, writeSession, cleanupOldFiles, archiveOldFiles, listSessions, listExpiredFiles } from './runtime/sessions.js';
export type { SessionRecord, CleanupResult, ArchiveResult } from './runtime/sessions.js';
export { Conversation, parseJsonlContext, parseLegacyContext } from './runtime/conversation.js';
export { delegateTo, delegateStream, findAgent, listAgents, loadAgentDocs, buildAgentPrompt } from './runtime/delegate.js';
export type { DelegationResult, DelegateStreamResult, AgentInfo, DelegateOptions } from './runtime/delegate.js';
export { searchPrimitives } from './runtime/search.js';
export type { SearchOptions, SearchResult } from './runtime/search.js';
