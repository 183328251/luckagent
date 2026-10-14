import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as pty from 'node-pty';
import xterm from '@xterm/headless';
import type { SubscriptionUsage, SubscriptionWindow } from '../codex/subscription-usage.js';
const { Terminal } = xterm;

/** Parse only quota sections; local skill/contribution statistics are not account quotas. */
export function parseClaudeUsage(text: string, now = new Date()): SubscriptionUsage {
  const parseWindow = (heading: string, durationMinutes: number): SubscriptionWindow | null => {
    const match = text.match(
      new RegExp(`${heading}\\s+[^\\n]*?(\\d+(?:\\.\\d+)?)%[^\\n]*used\\s+Resets ([^\\n]+)`, 'i'),
    );
    if (!match) return null;
    const usedPercent = Number(match[1]);
    if (!Number.isFinite(usedPercent) || usedPercent > 100) return null;
    return { usedPercent, remainingPercent: 100 - usedPercent, durationMinutes, resetsAt: resetTime(match[2], now) };
  };
  const primary = parseWindow('Current session', 300);
  const secondary = parseWindow('Current week \\(all models\\)', 10080);
  if (!primary && !secondary) throw new Error('No quota windows');
  const plan = text.match(/Claude (Pro|Max(?:\s*\d+x)?|Team|Enterprise)/i)?.[1] || null;
  return {
    checkedAt: now.toISOString(),
    stale: false,
    resetCredits: null,
    buckets: [{ id: 'claude', name: 'Claude', plan, primary, secondary }],
  };
}
function resetTime(text: string, now: Date): string | null {
  // Query process uses TZ=Asia/Shanghai. Never guess a different terminal timezone.
  if (!text.includes('(Asia/Shanghai)')) return null;
  const match = text.match(
    /(?:(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})\s+at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i,
  );
  if (!match) return null;
  const local = new Date(now.getTime() + 8 * 3600000);
  const month = match[1]
    ? ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(
        match[1].toLowerCase(),
      )
    : local.getUTCMonth();
  const hour = (Number(match[3]) % 12) + (match[5].toLowerCase() === 'pm' ? 12 : 0);
  if (Number(match[3]) < 1 || Number(match[3]) > 12 || Number(match[4] || 0) > 59) return null;
  let ts =
    Date.UTC(
      local.getUTCFullYear(),
      month,
      match[2] ? Number(match[2]) : local.getUTCDate(),
      hour,
      Number(match[4] || 0),
    ) -
    8 * 3600000;
  if (ts < now.getTime())
    ts = match[1]
      ? Date.UTC(local.getUTCFullYear() + 1, month, Number(match[2]), hour, Number(match[4] || 0)) - 8 * 3600000
      : ts + 86400000;
  return new Date(ts).toISOString();
}

export async function queryClaudeUsage(): Promise<SubscriptionUsage> {
  const dir = path.join(process.env.SESSION_STORE_DIR || path.join(os.homedir(), '.luckagent'), 'claude-usage-query');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const env = {
    ...process.env,
    TZ: 'Asia/Shanghai',
    LANG: 'en_US.UTF-8',
    CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: 'false',
  };
  for (const key of [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'CLAUDECODE',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_CODE_USE_FOUNDRY',
  ])
    delete (env as Record<string, string | undefined>)[key];
  const terminal = new Terminal({ cols: 160, rows: 100, scrollback: 200, allowProposedApi: true });
  const child = pty.spawn(
    process.env.CLAUDE_EXECUTABLE_PATH || path.join(os.homedir(), '.local/bin/claude'),
    [
      '--ax-screen-reader',
      '--tools',
      '',
      '--strict-mcp-config',
      '--mcp-config',
      '{"mcpServers":{}}',
      '--settings',
      '{"disableAllHooks":true}',
    ],
    { cwd: dir, env, cols: 160, rows: 100, name: 'xterm-256color' },
  );
  return new Promise((resolve, reject) => {
    let done = false,
      sent = false,
      trusted = false;
    let resultTimer: ReturnType<typeof setTimeout> | undefined;
    const timeout = setTimeout(() => finish(undefined), 30000);
    const screen = () => {
      const lines: string[] = [];
      const b = terminal.buffer.active;
      for (let i = 0; i < b.length; i++) lines.push(b.getLine(i)?.translateToString(true) || '');
      return lines.join('\n');
    };
    const finish = (result?: SubscriptionUsage) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      clearTimeout(resultTimer);
      subscription.dispose();
      exit.dispose();
      try {
        child.kill();
      } catch {
        /* Already exited. */
      }
      terminal.dispose();
      if (result) resolve(result);
      else reject(new Error('Claude quota query unavailable'));
    };
    const subscription = child.onData((data) =>
      terminal.write(data, () => {
        if (done) return;
        const text = screen();
        if (!trusted && text.includes('Enter y/n:')) {
          trusted = true;
          child.write('y\r');
          return;
        }
        if (!sent && /\n\$\s*$/.test(text.trimEnd())) {
          sent = true;
          child.write('/usage\r');
          return;
        }
        if (!sent) return;
        try {
          const result = parseClaudeUsage(text);
          if (text.includes('Refreshing…') && !text.includes('Usage credits')) return;
          clearTimeout(resultTimer);
          resultTimer = setTimeout(() => {
            try {
              finish(parseClaudeUsage(screen()));
            } catch {
              finish();
            }
          }, 800);
          void result;
        } catch {
          /* Wait until both UI and quota request settle. */
        }
      }),
    );
    const exit = child.onExit(() => finish());
  });
}

export function createClaudeUsageReader(query = queryClaudeUsage) {
  let snapshot: SubscriptionUsage | undefined,
    lastAttempt = 0;
  let inFlight: Promise<SubscriptionUsage> | undefined;
  return async (refresh = false): Promise<SubscriptionUsage> => {
    if (inFlight) return inFlight;
    if (snapshot && Date.now() - lastAttempt < (refresh ? 10000 : 120000)) return snapshot;
    lastAttempt = Date.now();
    inFlight = query().catch(() => ({
      ...(snapshot || { checkedAt: null, buckets: [], resetCredits: null }),
      stale: true,
      warning: snapshot?.checkedAt
        ? 'Claude 额度刷新失败，保留上次查询结果。'
        : '暂未获取到 Claude 额度，请确认本机 Claude Code 的订阅登录。',
    }));
    try {
      snapshot = await inFlight;
      return snapshot;
    } finally {
      inFlight = undefined;
    }
  };
}
export const getClaudeSubscriptionUsage = createClaudeUsageReader();
