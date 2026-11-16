import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { handleBotRoutes } from '../src/api/routes/bot-routes.js';
import { batchSetBotEngine, readBotsConfig, updateBot } from '../src/api/bots-config-writer.js';
import { configuredEngine, engineSettingsOverview } from '../src/api/bot-engine-settings.js';
const roots: string[] = [];
function fixture(bots: unknown[], legacy = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-engine-'));
  roots.push(dir);
  const file = path.join(dir, 'bots.json');
  fs.writeFileSync(file, JSON.stringify(legacy ? bots : { feishuBots: bots, peers: [{ name: 'keep' }] }));
  return file;
}
const bot = (name: string, engine = 'codex') => ({
  name,
  engine,
  appId: 'id',
  appSecret: 'secret',
  model: 'old-claude',
  codex: { model: 'old-codex', reasoningEffort: 'high', executable: '/keep/codex' },
  defaultWorkingDirectory: '/keep/work',
});
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
describe('bot engine changes', () => {
  it('switches once, deduplicates selection and keeps same-engine overrides and unrelated settings', () => {
    const file = fixture([bot('a'), bot('b', 'claude')]);
    expect(batchSetBotEngine(file, ['a', 'b', 'a'], 'claude')).toEqual({ updated: ['a'], unchanged: ['b'] });
    const result = readBotsConfig(file);
    expect(result.feishuBots?.[0]).toEqual({
      ...bot('a', 'claude'),
      modelConnection: 'local',
      model: undefined,
      codex: { executable: '/keep/codex' },
    });
    expect(result.feishuBots?.[1]).toEqual(bot('b', 'claude'));
    expect((result as any).peers).toEqual([{ name: 'keep' }]);
  });
  it.each([
    ['a', 'missing'],
    ['a', 'print'],
  ])('validates all names before any write: %j', (...names) => {
    const file = fixture([bot('a'), { ...bot('print'), reimbursementPrint: { enabled: true } }]);
    const original = fs.readFileSync(file, 'utf8');
    expect(() => batchSetBotEngine(file, names, 'claude')).toThrow();
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
  });
  it.each([null, [], [4], [''], Array(201).fill('a')])('rejects invalid selections %j', (names) => {
    const file = fixture([bot('a')]);
    expect(() => batchSetBotEngine(file, names, 'codex')).toThrow();
  });
  it('rejects other engines and leaves all-same selections byte-for-byte unchanged', () => {
    const file = fixture([bot('a')]);
    const original = fs.readFileSync(file, 'utf8');
    expect(() => batchSetBotEngine(file, ['a'], 'deepseek')).toThrow();
    expect(batchSetBotEngine(file, ['a'], 'codex').updated).toEqual([]);
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
  });
  it('clears echoed overrides after a single edit switches engine but retains them otherwise', () => {
    const file = fixture([bot('a')]);
    updateBot(file, 'a', { description: 'edited', engine: 'codex' });
    expect(readBotsConfig(file).feishuBots?.[0].codex?.model).toBe('old-codex');
    updateBot(file, 'a', { engine: 'claude', model: 'echo', codex: { model: 'echo', reasoningEffort: 'max' } });
    expect(readBotsConfig(file).feishuBots?.[0]).toMatchObject({
      engine: 'claude',
      description: 'edited',
      codex: { executable: '/keep/codex' },
      appSecret: 'secret',
    });
    expect(readBotsConfig(file).feishuBots?.[0].model).toBeUndefined();
    expect(readBotsConfig(file).feishuBots?.[0].codex?.model).toBeUndefined();
  });
  it('supports legacy arrays, inherited defaults and removal of empty Codex blocks', () => {
    vi.stubEnv('LUCKAGENT_ENGINE', 'codex');
    const file = fixture([{ name: 'a', codex: { model: 'old', reasoningEffort: 'high' } }], true);
    expect(configuredEngine({})).toBe('codex');
    batchSetBotEngine(file, ['a'], 'claude');
    expect(readBotsConfig(file).feishuBots?.[0]).toEqual({ name: 'a', engine: 'claude', modelConnection: 'local' });
  });
  it('reports saved configuration separately from running settings', () => {
    const live = { engine: 'codex', claude: {}, codex: { model: 'old' } } as any;
    expect(engineSettingsOverview({ name: 'a', engine: 'claude' } as any, live)).toMatchObject({
      configuredEngine: 'claude',
      configuredModel: null,
      engineSettingsPending: true,
      modelDisabled: false,
    });
    expect(
      engineSettingsOverview({ name: 'a', engine: 'codex', codex: { model: 'old' } } as any, live)
        .engineSettingsPending,
    ).toBe(false);
  });
});

describe('batch engine route', () => {
  it.each([{ names: ['a'], engine: 'claude' }, null, { names: ['missing'], engine: 'claude' }])(
    'responds safely and never touches runtime for %j',
    async (body) => {
      const file = fixture([bot('a')]);
      const registry = { get: vi.fn(), list: vi.fn(), remove: vi.fn() };
      const res = { writeHead: vi.fn(), end: vi.fn() };
      const ctx = { botsConfigPath: file, registry, logger: { info: vi.fn() } } as any;
      const req = Readable.from([Buffer.from(JSON.stringify(body))]);
      expect(await handleBotRoutes(ctx, req as any, res as any, 'POST', '/api/bots/batch-engine')).toBe(true);
      expect(res.writeHead.mock.calls[0][0]).toBe(body === null ? 400 : body.names[0] === 'missing' ? 404 : 200);
      expect(registry.get).not.toHaveBeenCalled();
      expect(registry.list).not.toHaveBeenCalled();
      expect(registry.remove).not.toHaveBeenCalled();
      if (body?.names[0] === 'a')
        expect(JSON.parse(res.end.mock.calls[0][0])).toMatchObject({ updated: ['a'], requiresRestart: true });
    },
  );
});
