// Auto-register all adapters by importing them
import './adapters/claude.js';
import './adapters/codex.js';
import './adapters/agents.js';
import './adapters/cursor.js';
import './adapters/copilot.js';
import './adapters/gemini.js';

export { runExport } from './runner.js';
export { getAdapter, listAdapters } from './registry.js';
export type { ProviderAdapter, ExportReport, DriftReport, ExportContext, ProviderName, ExportTarget } from './types.js';
