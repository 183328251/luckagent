import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const mocks = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: mocks.execFile }));
import { parseCodexModels, getCodexModelCatalog } from '../src/engines/codex/model-catalog.js';
import { updateBot, readBotsConfig } from '../src/api/bots-config-writer.js';
const visible = {
  slug: 'test-model',
  display_name: 'Test model',
  visibility: 'list',
  default_reasoning_level: 'medium',
  supported_reasoning_levels: [{ effort: 'medium' }, { effort: 'high' }],
};
const roots: string[] = [];
function scratch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-catalog-'));
  roots.push(root);
  return root;
}
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
describe('Codex model picker catalog', () => {
  it('keeps visible models and effort metadata without exposing identity or internal models', () => {
    const result = parseCodexModels({
      identity: 'private',
      models: [visible, { ...visible, slug: 'hidden', visibility: 'hide' }],
    });
    expect(result).toEqual([
      {
        id: 'test-model',
        displayName: 'Test model',
        reasoningEfforts: ['medium', 'high'],
        defaultReasoningEffort: 'medium',
      },
    ]);
    expect(JSON.stringify(result)).not.toContain('private');
  });
  it('accepts a CLI array and discards malformed, duplicate and unsupported effort values', () => {
    const result = parseCodexModels([
      null,
      {},
      visible,
      visible,
      {
        ...visible,
        slug: 'other',
        display_name: undefined,
        supported_reasoning_levels: [{ effort: 'high' }, { effort: 'high' }, { effort: 'invalid' }, { effort: 'max' }],
      },
    ]);
    expect(result).toHaveLength(2);
    expect(result[1].displayName).toBe('other');
    expect(result[1].reasoningEfforts).toEqual(['high', 'max']);
    expect(parseCodexModels({ data: [] })).toEqual([]);
  });
  it('reads the local cache without starting a subprocess', async () => {
    const root = scratch();
    vi.stubEnv('CODEX_HOME', root);
    fs.writeFileSync(path.join(root, 'models_cache.json'), JSON.stringify({ models: [visible] }));
    expect((await getCodexModelCatalog()).source).toBe('cache');
    expect(mocks.execFile).not.toHaveBeenCalled();
  });
  it('refreshes via the CLI and strips unrelated API credentials', async () => {
    vi.stubEnv('CODEX_HOME', scratch());
    vi.stubEnv('OPENAI_API_KEY', 'image-key');
    mocks.execFile.mockImplementation((_cmd, _args, options, callback) => {
      expect(options.env.OPENAI_API_KEY).toBeUndefined();
      callback(null, JSON.stringify({ models: [visible] }));
    });
    expect((await getCodexModelCatalog(true)).source).toBe('codex');
    expect(mocks.execFile.mock.calls[0][1]).toContain('models');
  });
  it('falls back to the cache when the CLI is unavailable', async () => {
    const root = scratch();
    vi.stubEnv('CODEX_HOME', root);
    fs.writeFileSync(path.join(root, 'models_cache.json'), JSON.stringify({ models: [visible] }));
    mocks.execFile.mockImplementation((_cmd, _args, _options, callback) => callback(new Error('ENOENT'), ''));
    const result = await getCodexModelCatalog(true);
    expect(result.source).toBe('cache');
    expect(result.warning).toBeTruthy();
  });
  it('returns a useful empty state when no catalog is available', async () => {
    vi.stubEnv('CODEX_HOME', scratch());
    mocks.execFile.mockImplementation((_cmd, _args, _options, callback) => callback(null, 'not-json'));
    const result = await getCodexModelCatalog(true);
    expect(result.source).toBe('unavailable');
    expect(result.models).toEqual([]);
  });
  it('clears nested selections while keeping executable and sibling bot settings', () => {
    const file = path.join(scratch(), 'bots.json');
    const sibling = { name: 'claude-bot', engine: 'claude', model: 'claude-model' };
    fs.writeFileSync(
      file,
      JSON.stringify({
        feishuBots: [
          {
            name: 'tiger',
            engine: 'codex',
            codex: { model: 'test-model', reasoningEffort: 'high', executable: '/bin/codex' },
          },
          sibling,
        ],
      }),
    );
    updateBot(file, 'tiger', { codex: { model: '', reasoningEffort: '' } });
    const bots = readBotsConfig(file).feishuBots!;
    expect(bots[0].codex).toEqual({ executable: '/bin/codex' });
    expect(bots[1]).toEqual(sibling);
  });
});
