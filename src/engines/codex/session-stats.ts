import { createReadStream, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { SDKMessage } from '../claude/executor.js';
import type { CodexUsage } from './jsonl-translator.js';

export interface CodexSessionStats {
  model?: string;
  contextWindow?: number;
  usage?: CodexUsage;
}

function findSessionFile(root: string, sessionId: string): string | undefined {
  const entries = readdirSync(root, { withFileTypes: true }).sort((a, b) => b.name.localeCompare(a.name));
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(`-${sessionId}.jsonl`)) return path.join(root, entry.name);
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = findSessionFile(path.join(root, entry.name), sessionId);
    if (found) return found;
  }
  return undefined;
}

/** Read actual runtime metadata, keeping only the most recent turn's token snapshot. */
export async function readCodexSessionStats(
  sessionId: string | undefined,
  codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
): Promise<CodexSessionStats> {
  if (!sessionId || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(sessionId)) return {};
  try {
    const file = findSessionFile(path.join(codexHome, 'sessions'), sessionId);
    if (!file) return {};
    const stats: CodexSessionStats = {};
    const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.includes('"turn_context"') && !line.includes('"token_count"') && !line.includes('"task_started"'))
        continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      const payload = record.payload;
      if (record.type === 'event_msg' && payload?.type === 'task_started') {
        // A resumed turn may fail before inference; never carry the previous turn's ctx into it.
        stats.model = undefined;
        stats.usage = undefined;
        stats.contextWindow = payload.model_context_window;
      } else if (record.type === 'turn_context' && typeof payload?.model === 'string') {
        stats.model = payload.model;
      } else if (record.type === 'event_msg' && payload?.type === 'token_count') {
        const info = payload.info;
        if (info?.last_token_usage) stats.usage = info.last_token_usage;
        if (typeof info?.model_context_window === 'number') stats.contextWindow = info.model_context_window;
      }
    }
    return stats;
  } catch {
    // Optional telemetry must never turn a completed reply into an execution failure.
    return {};
  }
}

export function withCodexSessionStats(message: SDKMessage, stats: CodexSessionStats): SDKMessage {
  const model = stats.model || Object.keys(message.modelUsage ?? {})[0];
  const previous = model ? message.modelUsage?.[model] : undefined;
  const usage = stats.usage;
  const outputTokens = usage?.output_tokens ?? previous?.outputTokens ?? 0;
  const inputTokens = usage
    ? typeof usage.total_tokens === 'number'
      ? Math.max(0, usage.total_tokens - outputTokens)
      : (usage.input_tokens ?? 0)
    : (previous?.inputTokens ?? 0);
  return {
    ...message,
    total_cost_usd: 0,
    modelUsage: model
      ? {
          [model]: {
            inputTokens,
            outputTokens,
            // A window without a fresh token snapshot is not a measured occupancy.
            contextWindow: usage
              ? (stats.contextWindow ?? previous?.contextWindow ?? 0)
              : (previous?.contextWindow ?? 0),
            costUSD: 0,
          },
        }
      : undefined,
  };
}
