import { describe, expect, it, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyModelConnection, botConnectionChoice, connectionUsers, validateConnectionSelection } from '../src/model-connections.js';
import { batchSetBotEngine, readBotsConfig, updateBot } from '../src/api/bots-config-writer.js';
import { engineSettingsOverview } from '../src/api/bot-engine-settings.js';
import { PersistentCodexExecutor } from '../src/engines/codex/persistent-executor.js';
import { MessageBridge } from '../src/bridge/message-bridge.js';
import type { BotConfig, BotsJsonNewFormat, FeishuBotJsonEntry } from '../src/config.js';

const connection = { id: 'gateway', name: 'Gateway', provider: 'deepseek' as const, baseUrl: 'https://gateway.test', model: 'flash', apiKey: 'test-key' };
const cfg: BotsJsonNewFormat = { modelConnections: [connection], defaultModelConnection: 'gateway' };
const entry = { name: 'codex', engine: 'codex', codex: { model: 'gpt-test', reasoningEffort: 'high' } } as FeishuBotJsonEntry;
const bot = () => ({ name: 'codex', engine: 'codex', claude: {}, codex: { model: 'gpt-test', reasoningEffort: 'high' } }) as BotConfig;
const dirs: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function file(bots: FeishuBotJsonEntry[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-upstream-')); dirs.push(dir);
  const p = path.join(dir, 'bots.json'); fs.writeFileSync(p, JSON.stringify({ ...cfg, feishuBots: bots })); return p;
}

describe('Codex isolation from unified model connections', () => {
  it('keeps existing Codex bots and inherited Codex engines off the global API connection', () => {
    expect(applyModelConnection(bot(), entry, cfg)).toEqual(bot());
    vi.stubEnv('LUCKAGENT_ENGINE', 'codex');
    expect(botConnectionChoice({})).toBe('codex');
    expect(applyModelConnection(bot(), { ...entry, engine: undefined }, cfg).engine).toBe('codex');
    expect(connectionUsers({ ...cfg, feishuBots: [entry] }, 'gateway')).toEqual([]);
    expect(engineSettingsOverview(entry, bot(), cfg).engineSettingsPending).toBe(false);
    validateConnectionSelection('codex', cfg);
    expect(() => validateConnectionSelection('codex', cfg, true)).toThrow();
  });
  it('permits an explicit switch from Codex to an API connection and back', () => {
    const p = file([entry]);
    updateBot(p, 'codex', { modelConnection: 'gateway' });
    let saved = readBotsConfig(p);
    expect(saved.feishuBots![0].engine).toBe('codex'); // legacy engine is retained for a later opt-out
    expect(applyModelConnection(bot(), saved.feishuBots![0], saved).deepseek?.model).toBe('flash');
    updateBot(p, 'codex', { modelConnection: 'codex', codex: { model: 'echo', reasoningEffort: 'max' } });
    saved = readBotsConfig(p);
    expect(saved.feishuBots![0].engine).toBe('codex');
    expect(saved.feishuBots![0].codex).toBeUndefined();
    expect(applyModelConnection(bot(), saved.feishuBots![0], saved).engine).toBe('codex');
  });
  it('batch switches the effective connection engine and remains pinned when the global default changes', () => {
    const p = file([{ ...entry, modelConnection: 'gateway' }]);
    expect(batchSetBotEngine(p, ['codex'], 'codex').updated).toEqual(['codex']);
    let saved = readBotsConfig(p);
    expect(saved.feishuBots![0].modelConnection).toBe('codex');
    expect(applyModelConnection(bot(), saved.feishuBots![0], saved).engine).toBe('codex');
    batchSetBotEngine(p, ['codex'], 'claude');
    saved = readBotsConfig(p);
    expect(saved.feishuBots![0].modelConnection).toBe('local');
    expect(applyModelConnection(bot(), saved.feishuBots![0], saved).engine).toBe('claude');
  });
  it('reports connection-resolved configuration and model alongside runtime', () => {
    const selected = { ...entry, modelConnection: 'gateway', model: undefined };
    const live = applyModelConnection(bot(), selected, cfg);
    expect(engineSettingsOverview(selected, live, cfg)).toMatchObject({ configuredEngine: 'deepseek', configuredModel: 'flash', engineSettingsPending: false });
  });
});

describe('Codex restart gate', () => {
  it('protects native turns, goals between turns, running jobs, queued jobs and loading threads', () => {
    const executor = Object.assign(Object.create(PersistentCodexExecutor.prototype), {
      scopes: new Map([['s', { turnId: 'turn', startedAt: 1, options: { apiContext: { chatId: 'running' } } }]]),
      goals: new Map([['g', { chatId: 'goal', goal: { status: 'active' } }], ['p', { chatId: 'paused', goal: { status: 'paused' } }]]),
      jobs: new Map([['j', { chatId: 'job', status: 'running' }], ['q', { chatId: 'queue', status: 'queued' }], ['done', { chatId: 'done', status: 'completed' }]]),
      loading: new Map([['loading', Promise.resolve()]]),
    }) as PersistentCodexExecutor;
    expect(executor.restartActivity()).toEqual({ activeChats: ['running', 'job', 'goal'], queued: 2 });
    const bridge = {
      runningTasks: new Map([['running', {}]]), admitting: new Map(), continuationTasks: new Map(),
      engineCache: new Map([['codex', { executor }]]), messageQueues: new Map(), pendingBatches: new Map(),
    };
    expect(MessageBridge.prototype.getRestartActivity.call(bridge as unknown as MessageBridge)).toEqual({ active: 3, queued: 2 });
  });
});
