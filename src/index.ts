export { createHarness } from './core/harness.js';
export type {
  CreateHarnessOptions,
  HarnessConfig,
  HarnessAgent,
  HarnessHooks,
  AgentRunResult,
  AgentStreamResult,
  AgentState,
  HarnessDocument,
  Frontmatter,
  PrimitiveType,
  ContextBudget,
  IndexEntry,
  DeepPartial,
  ToolCallInfo,
  ToolExecutorOptions,
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
export { getProvider, resetProvider, getModel, getSummaryModel, getFastModel, generate, generateWithMessages, streamWithMessages, streamGenerateWithDetails } from './llm/provider.js';
export type { CallOptions, GenerateOptions, GenerateWithMessagesOptions, GenerateResult, StreamWithMessagesResult, StreamGenerateResult, ProviderName } from './llm/provider.js';
export { scaffoldHarness, listTemplates, generateSystemMd, generateCoreMd } from './cli/scaffold.js';
export type { ScaffoldOptions } from './cli/scaffold.js';
export { buildIndex, writeIndexFile, rebuildAllIndexes } from './runtime/indexer.js';
export type { IndexOptions } from './runtime/indexer.js';
export { createWatcher } from './runtime/watcher.js';
export type { WatcherOptions } from './runtime/watcher.js';
export { Scheduler, isQuietHours } from './runtime/scheduler.js';
export type { SchedulerOptions, ScheduledWorkflow } from './runtime/scheduler.js';
export { synthesizeJournal, synthesizeJournalRange, listJournals, listUnjournaled, parseJournalSynthesis, compressJournals } from './runtime/journal.js';
export type { JournalEntry, JournalSynthesis, WeekSummary } from './runtime/journal.js';
export { proposeInstincts, installInstinct, learnFromSessions, harvestInstincts } from './runtime/instinct-learner.js';
export type { HarvestResult, LearnResult, InstinctCandidate } from './runtime/instinct-learner.js';
export { fixCapability, evaluateCapability, installCapability, processIntake, downloadCapability } from './runtime/intake.js';
export type { DownloadResult } from './runtime/intake.js';
export { validateHarness, doctorHarness } from './runtime/validator.js';
export type { ValidationResult, DoctorResult } from './runtime/validator.js';
export { createSessionId, writeSession, cleanupOldFiles, archiveOldFiles, listSessions, listExpiredFiles } from './runtime/sessions.js';
export type { SessionRecord, CleanupResult, ArchiveResult } from './runtime/sessions.js';
export { Conversation, parseJsonlContext, parseLegacyContext } from './runtime/conversation.js';
export type { ConversationOptions, ConversationSendResult, ConversationStreamResult } from './runtime/conversation.js';
export { delegateTo, delegateStream, findAgent, listAgents, loadAgentDocs, buildAgentPrompt } from './runtime/delegate.js';
export type { DelegationResult, DelegateStreamResult, AgentInfo, DelegateOptions } from './runtime/delegate.js';
export { searchPrimitives } from './runtime/search.js';
export type { SearchOptions, SearchResult } from './runtime/search.js';
export { loadMetrics, saveMetrics, recordRun, getWorkflowStats, getAllWorkflowStats, clearMetrics } from './runtime/metrics.js';
export type { WorkflowRun, MetricsStore, WorkflowStats } from './runtime/metrics.js';
export { loadTools, getToolById, listToolSummaries, checkToolAuth, parseToolDefinition } from './runtime/tools.js';
export type { ToolDefinition, ToolSummary, ToolAuth, ToolOperation } from './runtime/tools.js';
export { buildToolSet, convertToolDefinition, resolveEndpoint, buildOperationSchema, buildAuthHeaders, executeHttpOperation, createToolCallTracker, getToolSetSummary } from './runtime/tool-executor.js';
export type { ToolCallResult, ToolCallRecord, ProgrammaticTool, ToolExecutorConfig, AIToolSet } from './runtime/tool-executor.js';
export { exportHarness, writeBundle, readBundle, importBundle } from './runtime/export.js';
export type { HarnessBundle, ExportEntry, ImportResult, ExportOptions } from './runtime/export.js';
export { buildDependencyGraph, getGraphStats } from './runtime/graph.js';
export type { DependencyGraph, GraphNode, GraphEdge, GraphStats } from './runtime/graph.js';
export { getSessionAnalytics, getSessionsInRange } from './runtime/analytics.js';
export type { SessionData, SessionAnalytics } from './runtime/analytics.js';
export { checkRateLimit, recordEvent, tryAcquire, getUsage, clearRateLimits, loadRateLimits, saveRateLimits } from './runtime/rate-limiter.js';
export type { RateEvent, RateLimit, RateLimitCheck, RateLimitStore } from './runtime/rate-limiter.js';
export { calculateCost, recordCost, getSpending, checkBudget, clearCosts, findPricing, loadCosts, saveCosts } from './runtime/cost-tracker.js';
export type { ModelPricing, CostEntry, BudgetConfig, BudgetStatus, SpendingSummary, CostStore } from './runtime/cost-tracker.js';
export { tryLock, releaseLock, acquireLock, withFileLock, withFileLockSync, isLocked, breakLock } from './runtime/file-lock.js';
export type { LockInfo, LockOptions } from './runtime/file-lock.js';
export { loadHealth, saveHealth, recordSuccess, recordFailure, recordBoot, getHealthStatus, resetHealth } from './runtime/health.js';
export type { HealthCheck, HealthMetrics, HealthStatus } from './runtime/health.js';
export { collectSnapshot, formatDashboard } from './runtime/telemetry.js';
export type { TelemetrySnapshot, TelemetryOptions } from './runtime/telemetry.js';
export { checkGuardrails, buildRateLimits } from './runtime/guardrails.js';
export type { GuardrailResult } from './runtime/guardrails.js';
export { createMcpManager, loadMcpTools, validateMcpConfig } from './runtime/mcp.js';
export type { McpServerConfig, McpServerConnection, McpServerSummary, McpManager } from './runtime/mcp.js';
export { discoverMcpServers, discoveredServersToYaml, getScannedTools } from './runtime/mcp-discovery.js';
export type { DiscoveredMcpServer, DiscoverySource, DiscoveryResult, DiscoveryOptions } from './runtime/mcp-discovery.js';
export { searchRegistry, getRegistryServer, installMcpServer, formatRegistryServer, listRegistryServers, updateConfigWithServer, generateToolDocs } from './runtime/mcp-installer.js';
export type { McpInstallResult, McpInstallOptions } from './runtime/mcp-installer.js';
export { searchServers, resolveServerConfig, findServer, deriveConfigName } from './runtime/mcp-registry.js';
export type { RegistryServer, RegistryPackage, RegistryRemote, RegistrySearchResult, RegistrySearchResponse, RegistryEnvVar, ResolvedServer } from './runtime/mcp-registry.js';
export { discoverEnvKeys, parseEnvFile } from './runtime/env-discovery.js';
export type { DetectedApiKey, EnvDiscoveryResult, EnvSuggestion, EnvDiscoveryOptions } from './runtime/env-discovery.js';
export { discoverProjectContext } from './runtime/project-discovery.js';
export type { ProjectSignal, ProjectSuggestion, ProjectDiscoveryResult, ProjectDiscoveryOptions } from './runtime/project-discovery.js';
export { autoProcessFile, autoProcessAll } from './runtime/auto-processor.js';
export type { AutoProcessResult, AutoProcessOptions } from './runtime/auto-processor.js';
export { createWebApp, startWebServer } from './runtime/web-server.js';
export type { WebServerOptions, ServerSentEvent, CreateWebAppOptions } from './runtime/web-server.js';
export { createManifest, writeManifest, readManifest, packBundle, writeBundleDir, readBundleDir, installBundle, uninstallBundle, diffBundle, updateBundle, readInstalledManifests, listInstalledBundles, fetchRemoteBundle, fetchFromRegistry, searchBundleRegistry, searchConfiguredRegistries, installFromRegistry } from './runtime/primitive-registry.js';
export type { BundleManifest, BundleFileEntry, PackedBundle, PrimitiveInstallResult, PrimitiveUninstallResult, PrimitiveUpdateResult, RegistryConfig, BundleSearchResult, BundleSearchResponse, BundleSearchHit, MultiBundleSearchResponse } from './runtime/primitive-registry.js';
export { autoPromoteInstincts, detectDeadPrimitives, detectContradictions, enrichSessions, suggestCapabilities, classifyFailure, getRecoveryStrategies, analyzeFailures, FAILURE_TAXONOMY, runGate, runAllGates, listGates } from './runtime/intelligence.js';
export type { PatternOccurrence, AutoPromoteResult, DeadPrimitive, DeadPrimitiveResult, Contradiction, ContradictionResult, SessionEnrichment, EnrichmentResult, CapabilitySuggestion, CapabilitySuggestionResult, FailureMode, FailureRecord, FailureTaxonomy, FailureAnalysis, GateStatus, GateCheck, VerificationGateResult } from './runtime/intelligence.js';
export { defineAgent } from './runtime/define-agent.js';
export type { AgentBuilder } from './runtime/define-agent.js';
export { parseRulesFromDoc, loadRules, checkRules, enforceRules } from './runtime/rule-engine.js';
export type { ParsedRule, RuleAction, RuleCheckInput, RuleViolation, RuleCheckResult } from './runtime/rule-engine.js';
export { extractGates, loadGates, getGatesForPlaybook, checkGate, checkAllGates } from './runtime/verification-gate.js';
export type { VerificationCriterion, VerificationGate, GateCheckResult, GateExtractResult } from './runtime/verification-gate.js';
export { createAgent, checkRuleViolation, checkAction, createCliApproval, createWebhookApproval } from './runtime/agent-framework.js';
export type { AgentDefinition, AgentLifecycleHooks, BeforeRunContext, BeforeRunResult, AfterRunContext, AgentMiddleware, DefinedAgent, GuardrailEnforcementConfig, AgentRuleViolation, ApprovalGateConfig } from './runtime/agent-framework.js';
export { mergeState, applyStateChange, loadOwnership, saveOwnership } from './runtime/state-merge.js';
export type { StateOwner, StateOwnership, OwnedStateChange, MergeStrategy, MergeResult, StateConflict } from './runtime/state-merge.js';
export { loadEmotionalState, saveEmotionalState, applySignals, deriveSignals, summarizeEmotionalState, resetEmotionalState, getEmotionalTrends } from './runtime/emotional-state.js';
export type { EmotionalState, EmotionalSignal, EmotionalSnapshot, EmotionalTrend } from './runtime/emotional-state.js';
export { extractEmbeddableText, cosineSimilarity, loadEmbeddingStore, saveEmbeddingStore, detectStalePrimitives, indexPrimitives, semanticSearch, getEmbeddingStats } from './runtime/semantic-search.js';
export type { EmbeddingRecord, EmbeddingStore, SemanticSearchResult, EmbedFunction, SemanticSearchConfig } from './runtime/semantic-search.js';
export { startServe } from './runtime/serve.js';
export type { ServeOptions, WebhookRegistration, WebhookPayload, WebhookStore, ServeResult } from './runtime/serve.js';
export { isGitRepo, initVersioning, snapshot, getVersionLog, getVersionDiff, rollback, listTags, tagVersion, getPendingChanges, getFileHistory, getFileAtVersion } from './runtime/versioning.js';
export type { VersionEntry, VersionLog, RollbackResult, SnapshotResult, DiffEntry, VersionDiff } from './runtime/versioning.js';
