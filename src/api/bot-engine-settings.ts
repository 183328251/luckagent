import type { BotConfigBase, FeishuBotJsonEntry } from '../config.js';
import type { EngineName } from '../engines/types.js';

const ENGINES: EngineName[] = ['claude', 'codex', 'deepseek', 'minimax'];
export function configuredEngine(entry: { engine?: unknown }, fallback = process.env.LUCKAGENT_ENGINE): EngineName {
  if (ENGINES.includes(entry.engine as EngineName)) return entry.engine as EngineName;
  return ENGINES.includes(fallback as EngineName) ? (fallback as EngineName) : 'claude';
}

/** Only model/effort overrides are removed; executable, credentials and other settings survive. */
export function clearSubscriptionModelOverrides(entry: Record<string, unknown>): void {
  delete entry.model;
  const codex = entry.codex;
  if (codex && typeof codex === 'object' && !Array.isArray(codex)) {
    delete (codex as Record<string, unknown>).model;
    delete (codex as Record<string, unknown>).reasoningEffort;
    if (!Object.keys(codex).length) delete entry.codex;
  }
}

export function engineSettingsOverview(entry: FeishuBotJsonEntry, live?: BotConfigBase) {
  const engine = configuredEngine(entry);
  const model = engine === 'codex' ? entry.codex?.model : engine === 'claude' ? entry.model : entry[engine]?.model;
  const effort = engine === 'codex' ? entry.codex?.reasoningEffort || null : null;
  const expectedModel =
    engine === 'claude'
      ? model || process.env.CLAUDE_MODEL || process.env.ANTHROPIC_MODEL || null
      : engine === 'deepseek'
        ? model || process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash'
        : engine === 'minimax'
          ? model || process.env.MINIMAX_MODEL || 'MiniMax-M3'
          : model || null;
  const liveEngine = live ? configuredEngine(live) : null;
  const liveModel = live
    ? (liveEngine === 'codex'
        ? live.codex?.model
        : liveEngine === 'claude'
          ? live.claude.model
          : liveEngine === 'deepseek'
            ? live.deepseek?.model || 'deepseek-v4-flash'
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
        (engine === 'codex' && effort !== (live.codex?.reasoningEffort || null))),
    modelDisabled: entry.reimbursementPrint?.enabled === true,
  };
}
