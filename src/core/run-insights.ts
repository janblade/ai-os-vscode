import { PhaseContext, ProviderUsage } from '../contracts';

const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
export function validUsage(value: unknown): value is ProviderUsage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const usage = value as ProviderUsage;
  return Object.keys(value).every(key => ['inputTokens','outputTokens','cachedInputTokens'].includes(key)) && count(usage.inputTokens) && count(usage.outputTokens) && (usage.cachedInputTokens === undefined || count(usage.cachedInputTokens));
}
export function validPhaseContext(value: unknown): value is PhaseContext {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const context = value as PhaseContext;
  return Object.keys(value).every(key => ['bytes','estimatedTokens','sources'].includes(key)) && count(context.bytes) && count(context.estimatedTokens) && Array.isArray(context.sources) && context.sources.length <= 100 && context.sources.every(source => source && typeof source.source === 'string' && source.source.length <= 1000 && /^[a-f0-9]{64}$/.test(source.sha256));
}
export function preparedContext(system: string, prompt: string, sources: PhaseContext['sources']): PhaseContext {
  const bytes = new TextEncoder().encode(system + '\n' + prompt).length;
  // shortcut: UTF-8 bytes / 4 is a rough estimate; replace only when a provider exposes its exact prepared-input count.
  return {bytes,estimatedTokens:Math.ceil(bytes / 4),sources:sources.slice(0,100)};
}
export function phaseDuration(start?: string, end?: string, clock = Date.now()): string {
  if (!start || !Number.isFinite(Date.parse(start))) return 'Not recorded';
  const seconds = Math.max(0,Math.floor(((end ? Date.parse(end) : clock) - Date.parse(start)) / 1000));
  if (!Number.isFinite(seconds)) return 'Not recorded';
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
