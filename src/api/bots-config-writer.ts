import { configuredConnectionEngine } from '../model-connections.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BotsJsonNewFormat, FeishuBotJsonEntry, PeerJsonEntry } from '../config.js';
import { configuredEngine, clearSubscriptionModelOverrides } from './bot-engine-settings.js';

export function readBotsConfig(configPath: string): BotsJsonNewFormat {
  const raw = fs.readFileSync(configPath, 'utf-8');
  const parsed = JSON.parse(raw);

  // Handle old array format (backward compat)
  if (Array.isArray(parsed)) {
    return { feishuBots: parsed as FeishuBotJsonEntry[] };
  }

  return parsed as BotsJsonNewFormat;
}

export function writeBotsConfig(configPath: string, config: BotsJsonNewFormat): void {
  const json = JSON.stringify(config, null, 2) + '\n';
  const tmpPath = path.join(path.dirname(configPath), '.bots.json.tmp');
  fs.writeFileSync(tmpPath, json, { mode: 0o600 });
  fs.renameSync(tmpPath, configPath);
}

/** Collect all bot names. */
function allBotNames(config: BotsJsonNewFormat): string[] {
  return (config.feishuBots || []).map((b) => b.name);
}

export function addBot(
  configPath: string,
  platform: 'feishu',
  entry: FeishuBotJsonEntry,
): void {
  const config = readBotsConfig(configPath);

  if (allBotNames(config).includes(entry.name)) {
    throw new Error(`Bot with name "${entry.name}" already exists`);
  }

  if (!config.feishuBots) config.feishuBots = [];
  config.feishuBots.push(entry);

  writeBotsConfig(configPath, config);
}

export function removeBot(configPath: string, name: string): boolean {
  const config = readBotsConfig(configPath);

  if (config.feishuBots) {
    const idx = config.feishuBots.findIndex((b) => b.name === name);
    if (idx !== -1) {
      config.feishuBots.splice(idx, 1);
      writeBotsConfig(configPath, config);
      return true;
    }
  }

  return false;
}

export function updateBot(configPath: string, name: string, updates: Record<string, unknown>): boolean {
  const config = readBotsConfig(configPath);

  const bots = config.feishuBots;
  if (!bots) return false;
  const idx = bots.findIndex((b: any) => b.name === name);
  if (idx === -1) return false;

  // Merge updates into existing entry (name and platform credentials are immutable)
  const entry = bots[idx] as unknown as Record<string, unknown>;
  const previousEngine = configuredConnectionEngine(bots[idx], config);
  mergeInto(entry, updates);
  if ('engine' in updates && !('modelConnection' in updates) && previousEngine !== configuredEngine(entry)) {
    if (entry.engine === 'antigravity' || entry.engine === 'codex' || entry.engine === 'claude') entry.modelConnection = entry.engine === 'claude' ? 'local' : entry.engine;
  }
  const nextEngine = configuredConnectionEngine(bots[idx], config);
  if (previousEngine !== nextEngine && (nextEngine === 'claude' || nextEngine === 'codex' || nextEngine === 'antigravity')) {
    // Clear AFTER merging so hidden/echoed fields from the old edit form
    // cannot restore stale model choices during an engine switch.
    clearSubscriptionModelOverrides(entry);
  }
  writeBotsConfig(configPath, config);
  return true;
}

export class BatchEngineError extends Error {
  constructor(message: string, public readonly statusCode = 400) { super(message); }
}

/** Validate the whole selection first, then persist once. No runtime/session operations. */
export function batchSetBotEngine(configPath: string, names: unknown, engine: unknown): { updated: string[]; unchanged: string[] } {
  if (engine !== 'claude' && engine !== 'codex' && engine !== 'antigravity') throw new BatchEngineError('请选择 Claude、Codex 或 Antigravity。');
  if (!Array.isArray(names) || !names.length || names.length > 200 || !names.every(n => typeof n === 'string' && n.length > 0 && n.length <= 128)) {
    throw new BatchEngineError('请选择 1～200 个机器人。');
  }
  const unique = [...new Set(names)] as string[];
  const config = readBotsConfig(configPath);
  const entries = unique.map(name => {
    const bot = config.feishuBots?.find(b => b.name === name);
    if (!bot) throw new BatchEngineError(`机器人「${name}」不存在，请刷新列表后重试。`, 404);
    if (bot.reimbursementPrint?.enabled) throw new BatchEngineError(`「${name}」使用无模型业务模块，不参与引擎切换。`);
    return bot;
  });
  const updated: string[] = [], unchanged: string[] = [];
  for (const entry of entries) {
    if (configuredConnectionEngine(entry, config) === engine) { unchanged.push(entry.name); continue; }
    entry.engine = engine;
    entry.modelConnection = engine === 'claude' ? 'local' : engine;
    clearSubscriptionModelOverrides(entry as unknown as Record<string, unknown>);
    updated.push(entry.name);
  }
  if (updated.length) writeBotsConfig(configPath, config);
  return { updated, unchanged };
}

/**
 * Merge `updates` into `target` with the ''/null = delete-key convention.
 * Plain-object values are DEEP-merged instead of overwritten — an engine
 * sub-block like `deepseek: { model }` arriving without its (masked-and-
 * stripped) `apiKey` must not wipe the stored secret. Arrays and scalars
 * replace wholesale.
 */
function mergeInto(target: Record<string, unknown>, updates: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(updates)) {
    if (key === 'name' || key === 'platform') continue; // immutable
    if (value === undefined || value === null || value === '') {
      delete target[key];
    } else if (
      value && typeof value === 'object' && !Array.isArray(value)
      && target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])
    ) {
      mergeInto(target[key] as Record<string, unknown>, value as Record<string, unknown>);
      if (Object.keys(target[key] as object).length === 0) delete target[key];
    } else {
      target[key] = value;
    }
  }
}

/**
 * Add (or update by name) a static peer in the bots.json `peers[]` array so it
 * survives a bridge restart. Idempotent — re-adding an existing name updates
 * its url/secret rather than duplicating.
 */
export function addPeer(configPath: string, entry: PeerJsonEntry): void {
  const config = readBotsConfig(configPath);
  if (!config.peers) config.peers = [];
  const idx = config.peers.findIndex((p) => p.name === entry.name);
  const normalized: PeerJsonEntry = {
    name: entry.name,
    url: entry.url.replace(/\/+$/, ''),
    ...(entry.secret ? { secret: entry.secret } : {}),
  };
  if (idx !== -1) {
    config.peers[idx] = normalized;
  } else {
    config.peers.push(normalized);
  }
  writeBotsConfig(configPath, config);
}

/** Remove a peer from bots.json `peers[]` by name. Returns true if removed. */
export function removePeer(configPath: string, name: string): boolean {
  const config = readBotsConfig(configPath);
  if (!config.peers) return false;
  const idx = config.peers.findIndex((p) => p.name === name);
  if (idx === -1) return false;
  config.peers.splice(idx, 1);
  writeBotsConfig(configPath, config);
  return true;
}

export function getBotEntry(
  configPath: string,
  name: string,
): { platform: 'feishu'; entry: FeishuBotJsonEntry } | null {
  const config = readBotsConfig(configPath);

  const feishu = config.feishuBots?.find((b) => b.name === name);
  if (feishu) return { platform: 'feishu', entry: feishu };

  return null;
}
