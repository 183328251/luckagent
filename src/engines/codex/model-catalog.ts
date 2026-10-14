import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CodexReasoningEffort } from '../../config.js';
import { buildCodexEnv, resolveCodexPath } from './executor.js';

const EFFORTS: CodexReasoningEffort[] = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
export interface CodexModelOption {
  id: string;
  displayName: string;
  reasoningEfforts: CodexReasoningEffort[];
  defaultReasoningEffort?: CodexReasoningEffort;
}
export interface CodexModelCatalog {
  models: CodexModelOption[];
  source: 'codex' | 'cache' | 'unavailable';
  warning?: string;
}

/** Expose picker metadata only, without auth identity or hidden internal models. */
export function parseCodexModels(raw: unknown): CodexModelOption[] {
  const list = Array.isArray(raw) ? raw : (raw as { models?: unknown[] } | null)?.models;
  if (!Array.isArray(list)) return [];
  const models: CodexModelOption[] = [];
  const seen = new Set<string>();
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const model = entry as Record<string, unknown>;
    if (model.visibility !== 'list' || typeof model.slug !== 'string' || !model.slug.trim() || seen.has(model.slug))
      continue;
    seen.add(model.slug);
    const reasoningEfforts: CodexReasoningEffort[] = [];
    if (Array.isArray(model.supported_reasoning_levels)) {
      for (const item of model.supported_reasoning_levels) {
        const effort = item?.effort;
        if (EFFORTS.includes(effort) && !reasoningEfforts.includes(effort)) reasoningEfforts.push(effort);
      }
    }
    models.push({
      id: model.slug,
      displayName: typeof model.display_name === 'string' && model.display_name ? model.display_name : model.slug,
      reasoningEfforts,
      ...(EFFORTS.includes(model.default_reasoning_level as CodexReasoningEffort)
        ? { defaultReasoningEffort: model.default_reasoning_level as CodexReasoningEffort }
        : {}),
    });
  }
  return models;
}

function cachedModels(): CodexModelOption[] {
  try {
    const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
    return parseCodexModels(JSON.parse(fs.readFileSync(path.join(home, 'models_cache.json'), 'utf8')));
  } catch {
    return [];
  }
}

let inFlight: Promise<CodexModelCatalog> | undefined;
export async function getCodexModelCatalog(refresh = false): Promise<CodexModelCatalog> {
  const cached = cachedModels();
  if (!refresh && cached.length) return { models: cached, source: 'cache' };
  if (inFlight) return inFlight;
  inFlight = new Promise<CodexModelCatalog>((resolve) => {
    execFile(
      resolveCodexPath(),
      ['-c', 'model_provider="openai"', '-c', 'forced_login_method="chatgpt"', 'debug', 'models'],
      { env: buildCodexEnv(), timeout: 15000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        let models: CodexModelOption[] = [];
        if (!err) {
          try {
            models = parseCodexModels(JSON.parse(stdout));
          } catch {
            /* Fall back below. */
          }
        }
        if (models.length) {
          resolve({ models, source: 'codex' });
          return;
        }
        const fallback = cachedModels();
        resolve({
          models: fallback,
          source: fallback.length ? 'cache' : 'unavailable',
          warning: fallback.length
            ? '模型列表刷新失败，正在显示已有列表。'
            : '暂未获取到模型列表，请确认本机 Codex 已登录后刷新。',
        });
      },
    );
  });
  try {
    return await inFlight;
  } finally {
    inFlight = undefined;
  }
}
