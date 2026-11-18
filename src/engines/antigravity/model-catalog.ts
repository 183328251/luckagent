import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Logger } from '../../utils/logger.js';
import { AntigravityAcpClient } from './acp-client.js';

export interface AntigravityCatalog {
  models: Array<{ id: string; displayName: string; reasoningEfforts: string[] }>;
  modes: Array<{ id: string; name: string }>;
  source: 'antigravity' | 'cache' | 'unavailable';
  installed: boolean;
  authenticated: boolean | null;
  version?: string;
  plan?: string;
  checkedAt: string;
  warning?: string;
}
/** Restrict API responses to picker metadata; never return user identity or credentials. */
export function parseAntigravityCatalog(raw: any): Pick<AntigravityCatalog, 'models' | 'modes' | 'plan'> {
  const options = raw?.configOptions ?? [];
  const effort = options.find((o: any) => o.category === 'thought_level')?.options ?? [];
  const native = options.find((o: any) => o.category === 'model')?.options;
  const models = Array.isArray(native)
    ? native.map((m: any) => ({ id: m.value, displayName: m.name, reasoningEfforts: [] }))
    : (raw?.models?.availableModels ?? []).map((m: any) => ({
        id: m.modelId,
        displayName: m.name,
        reasoningEfforts: [],
      }));
  const currentModel = options.find((o: any) => o.category === 'model')?.currentValue;
  const seen = new Set<string>();
  const cleaned = models
    .filter((m: any) => typeof m.id === 'string' && m.id && !seen.has(m.id) && seen.add(m.id))
    .map((m: any) => ({
      ...m,
      displayName: typeof m.displayName === 'string' ? m.displayName : m.id,
      // Thinking levels are model-specific; only advertise the selected model's list.
      reasoningEfforts:
        m.id === currentModel ? effort.map((e: any) => e.value).filter((v: any) => typeof v === 'string') : [],
    }));
  return {
    models: cleaned,
    modes: (raw?.modes?.availableModes ?? [])
      .filter((m: any) => typeof m.id === 'string')
      .map((m: any) => ({ id: m.id, name: m.name || m.id })),
    ...(typeof raw?._meta?.antigravity?.tier?.name === 'string' ? { plan: raw._meta.antigravity.tier.name } : {}),
  };
}
export function createAntigravityCatalogReader(factory = (logger: Logger) => new AntigravityAcpClient(logger)) {
  let snapshot: AntigravityCatalog | undefined;
  let lastAttempt = 0;
  let inFlight: Promise<AntigravityCatalog> | undefined;
  return async (logger: Logger, refresh = false): Promise<AntigravityCatalog> => {
    if (inFlight) return inFlight;
    if (snapshot && Date.now() - lastAttempt < (refresh ? 5000 : 300000)) return snapshot;
    lastAttempt = Date.now();
    inFlight = (async () => {
      const client = factory(logger);
      let installed = false;
      let sessionId: string | undefined;
      try {
        await client.start();
        installed = true;
        const cwd = path.join(
          process.env.SESSION_STORE_DIR || path.join(os.homedir(), '.luckagent'),
          'antigravity-probe',
        );
        fs.mkdirSync(cwd, { recursive: true, mode: 0o700 });
        const result = await client.call('session/new', { cwd, mcpServers: [] });
        sessionId = result.sessionId;
        snapshot = {
          ...parseAntigravityCatalog(result),
          installed: true,
          authenticated: true,
          version: client.version,
          checkedAt: new Date().toISOString(),
          source: 'antigravity',
        };
      } catch (error) {
        const authRequired = /authentication required|auth_required/i.test(String(error));
        snapshot = {
          models: snapshot?.models ?? [],
          modes: snapshot?.modes ?? [],
          installed,
          authenticated: authRequired ? false : null,
          version: client.version,
          checkedAt: new Date().toISOString(),
          source: snapshot?.models.length ? 'cache' : 'unavailable',
          warning: authRequired
            ? 'Antigravity 未登录，请在桥接所属用户下运行 agy 完成登录。'
            : 'Antigravity 检测失败，请确认 CLI 已安装、能启动且网络可用。',
        };
      } finally {
        if (sessionId && client.capabilities.sessionCapabilities?.close)
          await client.call('session/close', { sessionId }).catch(() => {});
        await client.close().catch(() => {});
      }
      return snapshot!;
    })();
    try {
      return await inFlight;
    } finally {
      inFlight = undefined;
    }
  };
}
export const getAntigravityCatalog = createAntigravityCatalogReader();
