import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { BotConfigBase, CodexBotConfig } from '../../config.js';
import type { Logger } from '../../utils/logger.js';
import { AsyncQueue } from '../../utils/async-queue.js';
import type { ExecutionHandle, ExecutorOptions, SDKMessage } from '../claude/executor.js';
import { createCodexTranslatorState, translateCodexJsonEvent, type CodexJsonEvent } from './jsonl-translator.js';
import { readCodexSessionStats, withCodexSessionStats } from './session-stats.js';

/** Keep inference on the existing ChatGPT subscription, independent of image/voice API keys. */
export function buildCodexEnv(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...baseEnv };
  for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'OPENAI_BASE_URL']) delete env[key];
  return env;
}

export function resolveCodexPath(explicit?: string): string {
  if (explicit || process.env.CODEX_EXECUTABLE_PATH) return explicit || process.env.CODEX_EXECUTABLE_PATH!;
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    const file = path.join(dir, process.platform === 'win32' ? 'codex.cmd' : 'codex');
    if (existsSync(file)) return file;
  }
  for (const file of ['/opt/homebrew/bin/codex', '/usr/local/bin/codex', path.join(os.homedir(), '.local/bin/codex')]) {
    if (existsSync(file)) return file;
  }
  return 'codex';
}

export function buildCodexArgs(config: CodexBotConfig, options: ExecutorOptions): string[] {
  const args = [
    '-a',
    'never',
    '--sandbox',
    'workspace-write',
    '-C',
    options.cwd,
    '-c',
    'model_provider="openai"',
    '-c',
    'forced_login_method="chatgpt"',
    '-c',
    'sandbox_workspace_write.network_access=true',
  ];
  for (const dir of new Set(
    [options.outputsDir, path.resolve(options.cwd, 'inputs')].filter((v): v is string => !!v),
  )) {
    if (existsSync(dir)) args.push('--add-dir', dir);
  }
  const model = options.model || config.model;
  if (model) args.push('-m', model);
  if (config.reasoningEffort) args.push('-c', `model_reasoning_effort=${JSON.stringify(config.reasoningEffort)}`);
  args.push('exec');
  if (options.sessionId) args.push('resume');
  args.push('--json', '--skip-git-repo-check');
  if (!options.sessionId) args.push('--color', 'never');
  // The bridge includes downloaded image paths in its prompt. Attach them to the CLI as images.
  for (const match of options.prompt.matchAll(/\[Image saved at: (.+?)\]/g)) {
    if (existsSync(match[1])) args.push('--image', match[1]);
  }
  if (options.sessionId) args.push(options.sessionId);
  // Keep user text out of argv and avoid option parsing of prompts beginning with '-'.
  args.push('-');
  return args;
}

function skillHints(cwd: string): string {
  const skills = new Map<string, string>();
  for (const root of [path.join(os.homedir(), '.claude/skills'), path.join(cwd, '.claude/skills')]) {
    try {
      for (const name of readdirSync(root)) {
        const file = path.join(root, name, 'SKILL.md');
        if (existsSync(file)) skills.set(name, file);
      }
    } catch {
      /* This installation may have only native Codex skills. */
    }
  }
  return [...skills].map(([name, file]) => `- ${name}: ${file}`).join('\n');
}

export function buildCodexPrompt(options: ExecutorOptions): string {
  const { cwd, outputsDir, apiContext } = options;
  const sections = [
    options.prompt,
    'You are the Luckagent bot agent. Complete the user task using local tools. If information is missing, use the available question tool; if no question tool is available, ask in your final reply. Do not wait for interactive terminal input.',
  ];
  if (outputsDir)
    sections.push(
      `Output files: copy deliverables to ${outputsDir}. The bridge automatically sends files from this directory to the user.`,
    );
  if (apiContext)
    sections.push(
      `You are bot "${apiContext.botName}" in chat "${apiContext.chatId}". Every lark-cli command MUST use --profile ${apiContext.botName} --as bot. Use the luckagent skill for memory, scheduling and the agent bus.`,
    );
  const hints = skillHints(cwd);
  if (hints) sections.push(`Additional installed skills (read the relevant SKILL.md before using it):\n${hints}`);
  return sections.join('\n\n');
}

/** The CLI owns its session; this adapter owns the child lifetime and bridge events. */
export class CodexExecutor {
  constructor(
    private config: BotConfigBase,
    private logger: Logger,
  ) {}

  startExecution(options: ExecutorOptions): ExecutionHandle {
    const queue = new AsyncQueue<SDKMessage>();
    const config = this.config.codex ?? {};
    const state = createCodexTranslatorState({ model: options.model || config.model });
    state.sessionId = options.sessionId;
    let terminal: SDKMessage | undefined;
    let stderr = '';
    let buffer = '';
    let closed = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const decoder = new StringDecoder('utf8');
    const errorResult = (message: string): SDKMessage => ({
      type: 'result',
      subtype: options.abortController.signal.aborted ? 'error_cancelled' : 'error_during_execution',
      session_id: state.sessionId,
      duration_ms: Date.now() - state.startTime,
      result: state.lastAgentText,
      is_error: true,
      errors: [message],
    });
    const emptyHandle = (): ExecutionHandle => ({
      stream: queue[Symbol.asyncIterator]() as AsyncGenerator<SDKMessage>,
      sendAnswer: () => {},
      resolveQuestion: () => {},
      finish: () => {},
    });
    if (options.abortController.signal.aborted) {
      queue.enqueue(errorResult('Codex execution cancelled'));
      queue.finish();
      return emptyHandle();
    }
    if (options.allowedTools !== undefined || options.maxTurns !== undefined) {
      queue.enqueue(errorResult('Codex 基础版暂不支持 allowedTools / maxTurns 限制；请使用 Claude 执行此任务。'));
      queue.finish();
      return emptyHandle();
    }
    const child = spawn(resolveCodexPath(config.executable), buildCodexArgs(config, options), {
      cwd: options.cwd,
      env: buildCodexEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    const signalChild = (signal: NodeJS.Signals) => {
      if (closed || !child.pid) return;
      try {
        if (process.platform === 'win32') child.kill(signal);
        else process.kill(-child.pid, signal);
      } catch {
        /* Process already exited. */
      }
    };
    const stop = () => {
      signalChild('SIGTERM');
      if (!killTimer) {
        killTimer = setTimeout(() => signalChild('SIGKILL'), 3000);
        killTimer.unref();
      }
    };
    const cleanup = () => {
      closed = true;
      if (killTimer) clearTimeout(killTimer);
      options.abortController.signal.removeEventListener('abort', stop);
    };
    const emitLine = (line: string) => {
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line) as CodexJsonEvent;
        for (const message of translateCodexJsonEvent(event, state)) {
          if (message.type === 'result') terminal = message;
          else queue.enqueue(message);
        }
      } catch {
        this.logger.warn({ engine: 'codex' }, 'Invalid Codex JSONL event');
      }
    };
    options.abortController.signal.addEventListener('abort', stop, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += decoder.write(chunk);
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) emitLine(line);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-12000);
    });
    child.stdin.on('error', () => {
      /* The child exit handler reports early termination. */
    });
    child.once('error', (err) => {
      cleanup();
      queue.enqueue(errorResult(err.message));
      queue.finish();
    });
    child.once('close', async (code, signal) => {
      if (closed) return;
      buffer += decoder.end();
      emitLine(buffer);
      cleanup();
      const result = options.abortController.signal.aborted
        ? errorResult('Codex execution cancelled')
        : code !== 0
          ? terminal?.is_error
            ? terminal
            : errorResult(`Codex exited with ${signal || code}: ${stderr.trim()}`)
          : (terminal ?? errorResult(`Codex did not return a final result. ${stderr.trim()}`));
      const stats = await readCodexSessionStats(state.sessionId);
      queue.enqueue(withCodexSessionStats(result, stats));
      queue.finish();
    });
    child.stdin.end(buildCodexPrompt(options));
    this.logger.info({ engine: 'codex', hasSession: !!options.sessionId }, 'Starting Codex execution');
    return {
      stream: queue[Symbol.asyncIterator]() as AsyncGenerator<SDKMessage>,
      sendAnswer: () => {
        this.logger.warn('Codex CLI does not support mid-turn answers');
      },
      resolveQuestion: () => {
        this.logger.warn('Codex CLI does not support mid-turn questions');
      },
      finish: stop,
    };
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
