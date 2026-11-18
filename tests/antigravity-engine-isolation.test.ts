import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageBridge } from '../src/bridge/message-bridge.js';
import { createEngine, resolveEngineName } from '../src/engines/index.js';
import type { BotConfigBase } from '../src/config.js';

let root: string;
const logger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  child() {
    return this;
  },
} as any;
const config = (engine: 'claude' | 'antigravity'): BotConfigBase => ({
  name: 'isolation-test',
  engine,
  antigravity: { model: 'antigravity-model' },
  claude: {
    defaultWorkingDirectory: root,
    maxTurns: undefined,
    maxBudgetUsd: undefined,
    model: 'claude-model',
    apiKey: undefined,
    outputsBaseDir: root,
    downloadsDir: root,
    backend: 'pty',
  },
  persistentExecutor: { enabled: true },
});
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-isolation-'));
  vi.stubEnv('SESSION_STORE_DIR', root);
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('Antigravity bot isolation', () => {
  it('keeps explicit Claude bots on Claude when the global default changes', () => {
    vi.stubEnv('LUCKAGENT_ENGINE', 'antigravity');
    expect(resolveEngineName(config('claude'))).toBe('claude');
    expect(createEngine(config('claude'), logger).name).toBe('claude');
    expect(createEngine(config('antigravity'), logger).name).toBe('antigravity');
  });
  it.each(['claude', undefined] as const)(
    'discards a %s tagged legacy session and model before a Antigravity turn',
    (owner) => {
      const bridge = new MessageBridge(config('antigravity'), logger, {} as any) as any;
      try {
        bridge.sessionManager.setSessionId('test-chat', 'old-claude-id', owner);
        bridge.sessionManager.setSessionModel('test-chat', 'claude-model', owner);
        const { session, engineName } = bridge.prepareSessionForExecution('test-chat');
        expect(engineName).toBe('antigravity');
        expect(session.sessionId).toBeUndefined();
        expect(session.model).toBeUndefined();
        expect(bridge.isPersistentExecutorEnabled()).toBe(false);
      } finally {
        bridge.destroy();
      }
    },
  );
  it('preserves Antigravity context for consecutive turns and routes it outside the Claude pool', async () => {
    const bridge = new MessageBridge(config('antigravity'), logger, {} as any) as any;
    try {
      bridge.sessionManager.setSessionId('test-chat', 'antigravity-thread', 'antigravity');
      bridge.sessionManager.setSessionModel('test-chat', 'antigravity-model', 'antigravity');
      const session = bridge.prepareSessionForExecution('test-chat').session;
      expect(session.sessionId).toBe('antigravity-thread');
      expect(session.model).toBe('antigravity-model');
      const start = vi
        .spyOn(bridge.executor, 'startExecution')
        .mockReturnValue({ stream: (async function* () {})(), finish() {} } as any);
      await bridge.runOneTurn('test-chat', 'antigravity', {
        cwd: root,
        prompt: 'hello',
        abortController: new AbortController(),
        outputsDir: root,
      });
      expect(start).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'antigravity-thread' }));
      expect(bridge.getPersistentRegistry()).toBeNull();
    } finally {
      bridge.destroy();
    }
  });
  it('preserves Claude session and persistent mode for sibling bots', () => {
    const bridge = new MessageBridge(config('claude'), logger, {} as any) as any;
    try {
      bridge.sessionManager.setSessionId('test-chat', 'claude-thread', 'claude');
      expect(bridge.prepareSessionForExecution('test-chat').session.sessionId).toBe('claude-thread');
      expect(bridge.isPersistentExecutorEnabled()).toBe(true);
    } finally {
      bridge.destroy();
    }
  });
});
