import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { BotConfig, BotsJsonNewFormat, FeishuBotJsonEntry } from '../src/config.js';
import {
  applyModelConnection,
  configuredConnectionEngine,
  validateConnectionSelection,
} from '../src/model-connections.js';
import { batchSetBotEngine, readBotsConfig, updateBot } from '../src/api/bots-config-writer.js';
import { engineSettingsOverview } from '../src/api/bot-engine-settings.js';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-settings-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
afterEach(() => {
  for (const file of fs.readdirSync(root)) fs.unlinkSync(path.join(root, file));
});
const entry: FeishuBotJsonEntry = {
  name: 'test',
  feishuAppId: 'app',
  feishuAppSecret: 'secret',
  defaultWorkingDirectory: '/tmp',
};
describe('Antigravity model connections and settings', () => {
  it('resolves inherited and pinned connections without inheriting API models', () => {
    const cfg: BotsJsonNewFormat = { defaultModelConnection: 'antigravity' };
    expect(() => validateConnectionSelection('antigravity', cfg, true)).not.toThrow();
    expect(configuredConnectionEngine(entry, cfg)).toBe('antigravity');
    expect(configuredConnectionEngine({ ...entry, engine: 'claude' }, cfg)).toBe('claude');
    expect(configuredConnectionEngine({ ...entry, engine: 'codex' }, cfg)).toBe('codex');
    const bot = {
      name: 'test',
      engine: 'claude',
      claude: { connection: { model: 'api-model' } },
      antigravity: { model: 'native-model' },
    } as BotConfig;
    expect(applyModelConnection(bot, entry, cfg)).toMatchObject({
      engine: 'antigravity',
      antigravity: { model: 'native-model' },
    });
    expect(bot.claude.connection).toBeUndefined();
    expect(engineSettingsOverview({ ...entry, antigravity: { model: 'native-model' } }, bot, cfg)).toMatchObject({
      configuredModel: 'native-model',
      engineSettingsPending: false,
    });
  });
  it('switches and batches through the existing writer while preserving executable and permissions', () => {
    const file = path.join(root, 'bots.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        feishuBots: [
          {
            ...entry,
            engine: 'codex',
            model: 'stale',
            codex: { model: 'stale', executable: '/bin/codex' },
            antigravity: { model: 'old', executable: '/bin/agy', skipPermissions: false },
          },
        ],
      }),
    );
    updateBot(file, 'test', { engine: 'antigravity' });
    let saved = readBotsConfig(file).feishuBots![0];
    expect(saved.modelConnection).toBe('antigravity');
    expect(saved.model).toBeUndefined();
    expect(saved.antigravity).toEqual({ executable: '/bin/agy', skipPermissions: false });
    expect(saved.codex).toEqual({ executable: '/bin/codex' });
    expect(batchSetBotEngine(file, ['test'], 'claude').updated).toEqual(['test']);
    expect(batchSetBotEngine(file, ['test'], 'antigravity').updated).toEqual(['test']);
    saved = readBotsConfig(file).feishuBots![0];
    expect(saved.modelConnection).toBe('antigravity');
    expect(batchSetBotEngine(file, ['test'], 'antigravity').unchanged).toEqual(['test']);
  });
});
