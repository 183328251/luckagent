import { configuredConnectionEngine, selectedModelConnection } from '../model-connections.js';
import type { BotConfigBase, FeishuBotJsonEntry, BotsJsonNewFormat } from '../config.js';
import type { EngineName } from '../engines/types.js';

const ENGINES: EngineName[] = ['claude', 'codex', 'antigravity', 'deepseek', 'minimax'];
export function configuredEngine(entry: { engine?: unknown }, fallback = process.env.LUCKAGENT_ENGINE): EngineName {
  if (ENGINES.includes(entry.engine as EngineName)) return entry.engine as EngineName;
  return ENGINES.includes(fallback as EngineName) ? (fallback as EngineName) : 'claude';
}

/** Only model/effort overrides are removed; executable, credentials and other settings survive. */
export function clearSubscriptionModelOverrides(entry: Record<string, unknown>): void {
  delete entry.model;
  for (const key of ['codex', 'antigravity']) {
    const settings = entry[key];
    if (settings && typeof settings === 'object' && !Array.isArray(settings)) {
      delete (settings as Record<string, unknown>).model;
      delete (settings as Record<string, unknown>).reasoningEffort;
      if (!Object.keys(settings).length) delete entry[key];
    }
  }
}

export function engineSettingsOverview(entry: FeishuBotJsonEntry, live?: BotConfigBase, cfg: BotsJsonNewFormat = {}) {
  const engine = configuredConnectionEngine(entry, cfg);
  const selected = selectedModelConnection(entry, cfg);
  const connection = cfg.modelConnections?.find(c => c.id === selected);
  const model = connection ? entry.model || connection.model : engine === 'codex' ? entry.codex?.model : engine === 'claude' ? entry.model : entry[engine]?.model;
  const effort = engine === 'codex' || engine === 'antigravity' ? entry[engine]?.reasoningEffort || null : null;
  const expectedModel =
    engine === 'claude'
      ? model || (selected === 'local' ? null : process.env.CLAUDE_MODEL || process.env.ANTHROPIC_MODEL || null)
      : engine === 'deepseek'
        ? model || process.env.DEEPSEEK_MODEL || 'deepseek-flash'
        : engine === 'minimax'
          ? model || process.env.MINIMAX_MODEL || 'MiniMax-M3'
          : model || null;
  const liveEngine = live ? configuredEngine(live) : null;
  const liveModel = live
    ? (liveEngine === 'antigravity' ? live.antigravity?.model : liveEngine === 'codex'
        ? live.codex?.model
        : liveEngine === 'claude'
          ? live.claude.model
          : liveEngine === 'deepseek'
            ? live.deepseek?.model || 'deepseek-flash'
            : live.minimax?.model || 'MiniMax-M3') || null
    : null;
  return {
    configuredEngine: engine,
    configuredModel: model || null,
    configuredReasoningEffort: effort,
    engineSettingsPending:
      !!live &&
      (engine !== liveEngine ||
        expectedModel !== liveModel ||
        ((engine === 'codex' || engine === 'antigravity') && effort !== (live[engine]?.reasoningEffort || null))),
    modelDisabled: entry.reimbursementPrint?.enabled === true,
  };
}
