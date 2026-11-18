import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { AntigravityBotConfig, BotConfigBase } from '../../config.js';
import type { Logger } from '../../utils/logger.js';
import { AsyncQueue } from '../../utils/async-queue.js';
import type { ExecutionHandle, ExecutorOptions, SDKMessage } from '../claude/executor.js';
import { createAntigravityState, translateAntigravityEvent, type AntigravityEvent } from './jsonl-translator.js';

export function resolveAntigravityPath(explicit?: string): string {
  if (explicit || process.env.ANTIGRAVITY_EXECUTABLE_PATH) return explicit || process.env.ANTIGRAVITY_EXECUTABLE_PATH!;
  const name = process.platform === 'win32' ? 'agy.cmd' : 'agy';
  for (const dir of [
    ...(process.env.PATH || '').split(path.delimiter),
    path.join(os.homedir(), '.local/bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ]) {
    if (existsSync(path.join(dir, name))) return path.join(dir, name);
  }
  return name;
}

export function buildAntigravityArgs(config: AntigravityBotConfig, options: ExecutorOptions): string[] {
  // Structured stdin keeps prompts out of argv and prevents slash-command expansion.
  const args = [
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--sandbox',
    '--disable-slash-commands',
  ];
  if (config.skipPermissions) args.push('--dangerously-skip-permissions');
  else args.push('--mode', config.mode || 'auto');
  if (options.sessionId) args.push('--conversation', options.sessionId);
  const model = options.model || config.model;
  if (model) args.push('--model', model);
  if (config.reasoningEffort) args.push('--effort', config.reasoningEffort);
  const roots = config.writableRoots ?? [];
  if (!Array.isArray(roots) || roots.some((v) => typeof v !== 'string' || !v.trim()))
    throw new Error('antigravity.writableRoots must be an array of non-empty paths');
  for (const dir of new Set(
    [options.outputsDir, path.join(options.cwd, 'inputs'), ...roots].filter((v): v is string => !!v),
  )) {
    const expanded = dir === '~' ? os.homedir() : dir.startsWith('~/') ? path.join(os.homedir(), dir.slice(2)) : dir;
    const absolute = path.resolve(options.cwd, expanded);
    if (existsSync(absolute)) args.push('--add-dir', absolute);
  }
  return args;
}

export function buildAntigravityPrompt(options: ExecutorOptions): string {
  const sections = [
    options.prompt,
    'You are the Luckagent bot agent. Complete the task with local tools. No interactive terminal is available. If user input is required, ask in your final reply. Read and follow workspace AGENTS.md and CLAUDE.md instructions.',
  ];
  if (options.outputsDir)
    sections.push(`Copy deliverables to ${options.outputsDir}; Luckagent sends files from this directory to the user.`);
  if (options.apiContext)
    sections.push(
      `You are bot "${options.apiContext.botName}" in chat "${options.apiContext.chatId}". Every lark-cli command MUST use --profile ${options.apiContext.botName} --as bot. Use the luckagent skill for memory, scheduling and the agent bus.`,
    );
  // Share installed instructions/skills by reference, without writing another copy.
  const ancestors: string[] = [];
  for (let dir = path.resolve(options.cwd); ; dir = path.dirname(dir)) {
    ancestors.unshift(path.join(dir, 'CLAUDE.md'));
    if (path.dirname(dir) === dir) break;
  }
  for (const file of new Set([path.join(os.homedir(), '.claude/CLAUDE.md'), ...ancestors])) {
    try {
      sections.push(`Workspace instructions (${file}):\n${readFileSync(file, 'utf8')}`);
    } catch {
      /* optional */
    }
  }
  for (const root of [path.join(os.homedir(), '.claude/skills'), path.join(options.cwd, '.claude/skills')]) {
    try {
      const skills = readdirSync(root)
        .map((name) => path.join(root, name, 'SKILL.md'))
        .filter(existsSync);
      if (skills.length) sections.push(`Installed skills: read relevant SKILL.md before use:\n${skills.join('\n')}`);
    } catch {
      /* optional */
    }
  }
  return sections.join('\n\n');
}

/** Each turn owns a process; native conversation IDs preserve context across turns/restarts. */
export class AntigravityExecutor {
  constructor(
    private config: BotConfigBase,
    private logger: Logger,
  ) {}

  startExecution(options: ExecutorOptions): ExecutionHandle {
    const queue = new AsyncQueue<SDKMessage>();
    const state = createAntigravityState(options.sessionId);
    let stop = () => {};
    const handle: ExecutionHandle = {
      stream: queue[Symbol.asyncIterator]() as AsyncGenerator<SDKMessage>,
      sendAnswer: () => this.logger.warn('Antigravity headless does not support mid-turn answers'),
      resolveQuestion: () => this.logger.warn('Antigravity headless does not support interactive control messages'),
      finish: () => stop(),
    };
    const fail = (message: string): SDKMessage => ({
      type: 'result',
      subtype: options.abortController.signal.aborted ? 'error_cancelled' : 'error_during_execution',
      session_id: state.sessionId,
      duration_ms: Date.now() - state.startedAt,
      result: state.text,
      is_error: true,
      errors: [message],
    });
    if (
      options.abortController.signal.aborted ||
      options.allowedTools !== undefined ||
      options.maxTurns !== undefined
    ) {
      queue.enqueue(
        fail(
          options.abortController.signal.aborted
            ? 'Antigravity execution cancelled'
            : 'Antigravity 暂不支持 allowedTools / maxTurns 限制，请使用 Claude。',
        ),
      );
      queue.finish();
      return handle;
    }
    const config = this.config.antigravity ?? {};
    let args: string[];
    try {
      args = buildAntigravityArgs(config, options);
    } catch (error) {
      queue.enqueue(fail(String(error)));
      queue.finish();
      return handle;
    }
    const child = spawn(resolveAntigravityPath(config.executable), args, {
      cwd: options.cwd,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    let closed = false;
    let terminal: SDKMessage | undefined;
    let stderr = '';
    let buffer = '';
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const decoder = new StringDecoder('utf8');
    const signal = (value: NodeJS.Signals) => {
      if (closed || !child.pid) return;
      try {
        if (process.platform === 'win32') child.kill(value);
        else process.kill(-child.pid, value);
      } catch {
        /* exited */
      }
    };
    stop = () => {
      signal('SIGTERM');
      if (!killTimer && !closed) {
        killTimer = setTimeout(() => signal('SIGKILL'), 3000);
        killTimer.unref();
      }
    };
    const cleanup = () => {
      closed = true;
      if (killTimer) clearTimeout(killTimer);
      options.abortController.signal.removeEventListener('abort', stop);
    };
    const line = (value: string) => {
      if (!value.trim()) return;
      try {
        for (const message of translateAntigravityEvent(JSON.parse(value) as AntigravityEvent, state)) {
          if (message.type === 'result') terminal = message;
          else queue.enqueue(message);
        }
      } catch {
        this.logger.warn({ engine: 'antigravity' }, 'Invalid Antigravity JSONL event');
      }
    };
    options.abortController.signal.addEventListener('abort', stop, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += decoder.write(chunk);
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const value of lines) line(value);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-12000);
    });
    child.stdin.on('error', () => {
      /* early exit is reported by close */
    });
    child.once('error', (error) => {
      cleanup();
      queue.enqueue(fail(error.message));
      queue.finish();
    });
    child.once('close', (code, exitSignal) => {
      if (closed) return;
      buffer += decoder.end();
      line(buffer);
      cleanup();
      queue.enqueue(
        options.abortController.signal.aborted
          ? fail('Antigravity execution cancelled')
          : code !== 0
            ? terminal?.is_error
              ? terminal
              : fail(`Antigravity exited with ${exitSignal || code}: ${stderr.trim()}`)
            : (terminal ?? fail(`Antigravity did not return a final result. ${stderr.trim()}`)),
      );
      queue.finish();
    });
    try {
      child.stdin.end(JSON.stringify({ event: 'user', message: { content: buildAntigravityPrompt(options) } }) + '\n');
    } catch (error) {
      stop();
      this.logger.warn({ error: String(error) }, 'Antigravity stdin failed');
    }
    return handle;
  }

  async *execute(options: ExecutorOptions): AsyncGenerator<SDKMessage> {
    const handle = this.startExecution(options);
    try {
      for await (const message of handle.stream) yield message;
    } finally {
      handle.finish();
    }
  }
}
