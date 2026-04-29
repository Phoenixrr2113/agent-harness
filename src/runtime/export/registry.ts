import type { ProviderAdapter, ProviderName } from './types.js';

const adapters = new Map<ProviderName, ProviderAdapter>();

export function registerAdapter(adapter: ProviderAdapter): void {
  adapters.set(adapter.name, adapter);
}

export function getAdapter(name: ProviderName): ProviderAdapter | null {
  return adapters.get(name) ?? null;
}

export function listAdapters(): ProviderAdapter[] {
  return Array.from(adapters.values());
}

export function clearRegistry(): void {
  adapters.clear();
}
