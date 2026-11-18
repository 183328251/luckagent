import { AntigravityWork } from './work.js';
import { formQuestions, formAnswer } from './questions.js';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { BotConfigBase } from '../../config.js';
import type { Logger } from '../../utils/logger.js';
import { AsyncQueue } from '../../utils/async-queue.js';
import type { ExecutionHandle, ExecutorOptions, SDKMessage } from '../claude/executor.js';
import { AntigravityAcpClient, type RpcRequest, type RpcNotification } from './acp-client.js';
import { buildAntigravityPrompt } from './executor.js';

interface Question {
  request: RpcRequest;
  fields?: Record<string, any>;
  options?: Array<{ optionId: string; name: string; kind: string }>;
  labels?: string[];
}
interface Turn {
  queue: AsyncQueue<SDKMessage>;
  options: ExecutorOptions;
  text: string;
  started: number;
  complete: boolean;
  cancelled: boolean;
  abort(): void;
  question?: Question;
  tools: Set<string>;
  subagents: Map<string, string>;
}
interface Session {
  id: string;
  chatId?: string;
  cwd: string;
  model?: string;
  configOptions?: any[];
  active?: Turn;
}

/** One ACP server per bot; sessions remain warm and are resumed by native ID after restart. */
export class PersistentAntigravityExecutor extends EventEmitter {
  readonly client: AntigravityAcpClient;
  readonly work: AntigravityWork;
  private sessions = new Map<string, Session>();
  private stats = new Map<string, NonNullable<SDKMessage['engineStats']>>();
  private preparing = new Set<Turn>();
  private stopping = false;
  constructor(
    private config: BotConfigBase,
    private logger: Logger,
    client?: AntigravityAcpClient,
  ) {
    super();
    this.work = new AntigravityWork(config, (options) => this.startExecution(options));
    this.client = client ?? new AntigravityAcpClient(logger, config.antigravity, config.claude.defaultWorkingDirectory);
    this.client.on('notification', (message: RpcNotification) => this.onUpdate(message));
    this.client.on('request', (request: RpcRequest) => this.onRequest(request));
    this.client.on('disconnected', (error: Error) => {
      for (const session of this.sessions.values())
        if (session.active) this.finish(session.active, session.id, error.message);
      this.sessions.clear();
      this.stats.clear();
    });
  }

  private async session(options: ExecutorOptions): Promise<Session> {
    if (this.stopping) throw new Error('Antigravity runtime is shutting down');
    await this.client.start();
    let session = options.sessionId ? this.sessions.get(options.sessionId) : undefined;
    if (session && session.cwd !== options.cwd) throw new Error('Antigravity session working directory mismatch');
    if (!session) {
      const caps = this.client.capabilities;
      const method = !options.sessionId
        ? 'session/new'
        : caps.sessionCapabilities?.resume
          ? 'session/resume'
          : caps.loadSession
            ? 'session/load'
            : undefined;
      if (!method) throw new Error('This Antigravity CLI cannot resume sessions; update the CLI or reset the chat');
      const roots = this.config.antigravity?.writableRoots ?? [];
      if (!Array.isArray(roots) || roots.some((dir) => typeof dir !== 'string' || !dir.trim()))
        throw new Error('antigravity.writableRoots must be an array of non-empty paths');
      const dirs = [
        ...new Set(
          [options.outputsDir, path.join(options.cwd, 'inputs'), ...roots]
            .filter((v): v is string => !!v)
            .map((dir) =>
              path.resolve(
                options.cwd,
                dir === '~' ? os.homedir() : dir.startsWith('~/') ? path.join(os.homedir(), dir.slice(2)) : dir,
              ),
            ),
        ),
      ];
      if (
        dirs.length &&
        !caps.sessionCapabilities?.additionalDirectories &&
        dirs.some((dir) => !dir.startsWith(path.resolve(options.cwd) + path.sep))
      )
        throw new Error('This Antigravity CLI cannot grant additional workspace directories; update the CLI');
      const response = await this.client.call(method, {
        cwd: options.cwd,
        mcpServers: [],
        ...(options.sessionId ? { sessionId: options.sessionId } : {}),
        ...(caps.sessionCapabilities?.additionalDirectories ? { additionalDirectories: dirs } : {}),
      });
      session = {
        id: response.sessionId || options.sessionId,
        chatId: options.apiContext?.chatId,
        cwd: options.cwd,
        configOptions: response.configOptions,
        model: response.models?.currentModelId,
      };
      if (!session.id) throw new Error('Antigravity did not return a session ID');
      this.sessions.set(session.id, session);
    }
    if (session.active) throw new Error('Antigravity session already has an active turn');
    const model = options.model || this.config.antigravity?.model;
    if (model && model !== session.model) {
      const modelOption = session.configOptions?.find((o) => o.category === 'model');
      if (modelOption?.options?.some((o: any) => o.value === model)) {
        const result = await this.client.call('session/set_config_option', {
          sessionId: session.id,
          configId: modelOption.id,
          value: model,
        });
        session.configOptions = result.configOptions ?? session.configOptions;
      } else await this.client.call('session/set_model', { sessionId: session.id, modelId: model });
      session.model = model;
      this.stats.set(session.id, { ...this.stats.get(session.id), model });
    }
    const effort = this.config.antigravity?.reasoningEffort;
    if (effort) {
      const option = session.configOptions?.find((o) => o.category === 'thought_level');
      if (!option || !option.options?.some((o: any) => o.value === effort))
        throw new Error(`Antigravity model does not support reasoning effort: ${effort}`);
      await this.client.call('session/set_config_option', {
        sessionId: session.id,
        configId: option.id,
        value: effort,
      });
    }
    const mode = this.config.antigravity?.mode || 'accept-edits';
    await this.client.call('session/set_mode', { sessionId: session.id, modeId: mode });
    return session;
  }

  startExecution(options: ExecutorOptions): ExecutionHandle {
    let session: Session | undefined;
    const turn: Turn = {
      queue: new AsyncQueue(),
      options,
      text: '',
      started: Date.now(),
      complete: false,
      cancelled: false,
      tools: new Set(),
      subagents: new Map(),
      abort: () => {
        if (turn.complete) return;
        turn.cancelled = true;
        if (session) {
          this.dismiss(turn);
          try {
            this.client.notify('session/cancel', { sessionId: session.id });
          } catch {
            /* disconnected */
          }
          // Cancellation acknowledgement must precede the next prompt on this session.
          const timer = setTimeout(() => {
            if (!turn.complete) void this.resetConnection();
          }, 5000);
          timer.unref();
          turn.queue.enqueue({ type: 'system', subtype: 'status', session_id: session.id });
        } else this.finish(turn, options.sessionId, 'Antigravity execution cancelled');
      },
    };
    if (options.abortController.signal.aborted) turn.abort();
    else {
      options.abortController.signal.addEventListener('abort', turn.abort, { once: true });
      this.preparing.add(turn);
      void (async () => {
        if (options.allowedTools !== undefined || options.maxTurns !== undefined)
          throw new Error('Antigravity 暂不支持 allowedTools / maxTurns 限制，请使用 Claude。');
        session = await this.session(options);
        this.preparing.delete(turn);
        if (turn.complete || this.stopping) {
          if (this.stopping) await this.client.close();
          return;
        }
        if (session.active) throw new Error('Antigravity session already has an active turn');
        session.active = turn;
        turn.queue.enqueue({
          type: 'system',
          subtype: 'init',
          session_id: session.id,
          engineStats: this.sessionStats(session.id),
        });
        const prompt: Array<Record<string, unknown>> = [
          {
            type: 'text',
            text: buildAntigravityPrompt(options).replace(
              'If user input is required, ask in your final reply.',
              'If user input is required, use the native question tool and wait for the answer.',
            ),
          },
        ];
        for (const match of options.prompt.matchAll(/\[Image saved at: (.+?)\]/g)) {
          if (!existsSync(match[1])) continue;
          const ext = path.extname(match[1]).toLowerCase();
          const mime = (
            {
              '.png': 'image/png',
              '.jpg': 'image/jpeg',
              '.jpeg': 'image/jpeg',
              '.webp': 'image/webp',
              '.gif': 'image/gif',
            } as Record<string, string>
          )[ext];
          if (mime) prompt.push({ type: 'image', mimeType: mime, data: readFileSync(match[1]).toString('base64') });
        }
        const result = await this.client.call('session/prompt', { sessionId: session.id, prompt });
        this.finish(
          turn,
          session.id,
          turn.cancelled || result.stopReason === 'cancelled' ? 'Antigravity execution cancelled' : undefined,
        );
      })().catch((error) =>
        this.finish(turn, session?.id || options.sessionId, String(error instanceof Error ? error.message : error)),
      );
    }
    return {
      stream: turn.queue[Symbol.asyncIterator]() as AsyncGenerator<SDKMessage>,
      finish: () => {
        if (!turn.complete) turn.abort();
      },
      resolveQuestion: (id, answers) => this.answer(turn, id, answers),
      sendAnswer: (id, _sid, answer) => this.answer(turn, id, { answer }),
    };
  }

  private finish(turn: Turn, sessionId?: string, error?: string): void {
    if (turn.complete) return;
    turn.complete = true;
    this.preparing.delete(turn);
    turn.options.abortController.signal.removeEventListener('abort', turn.abort);
    this.dismiss(turn);
    const session = sessionId && this.sessions.get(sessionId);
    if (session && session.active === turn) session.active = undefined;
    turn.queue.enqueue({
      type: 'result',
      subtype: error ? (turn.cancelled ? 'error_cancelled' : 'error_during_execution') : 'success',
      session_id: sessionId,
      engineStats: sessionId ? this.sessionStats(sessionId) : undefined,
      result: turn.text,
      duration_ms: Date.now() - turn.started,
      is_error: !!error,
      errors: error ? [error] : undefined,
    });
    turn.queue.finish();
  }
  private dismiss(turn: Turn): void {
    if (!turn.question) return;
    try {
      this.client.respond(
        turn.question.request.id,
        turn.question.options ? { outcome: { outcome: 'cancelled' } } : { action: 'cancel' },
      );
    } catch {
      /* disconnected */
    }
    turn.question = undefined;
  }
  private sessionStats(id: string): NonNullable<SDKMessage['engineStats']> {
    return { model: this.sessions.get(id)?.model, ...this.stats.get(id) };
  }
  private onUpdate(message: RpcNotification): void {
    if (message.method !== 'session/update') return;
    const id = message.params.sessionId;
    const update = message.params.update;
    if (!update || typeof id !== 'string') return;
    const session = this.sessions.get(id);
    if (update.sessionUpdate === 'usage_update') {
      // Native context occupancy can decrease after compaction. Do not accumulate it.
      if (
        Number.isSafeInteger(update.used) &&
        update.used >= 0 &&
        Number.isSafeInteger(update.size) &&
        update.size > 0
      ) {
        this.stats.set(id, { ...this.stats.get(id), contextTokens: update.used, contextWindow: update.size });
      } else return;
    } else if (update.sessionUpdate === 'config_option_update') {
      const model = update.configOptions?.find((option: any) => option.category === 'model')?.currentValue;
      if (typeof model === 'string' && model) {
        this.stats.set(id, { ...this.stats.get(id), model });
        if (session) session.model = model;
      }
    }
    const turn = session?.active;
    if (!turn || turn.complete || turn.cancelled) return;
    if (update.sessionUpdate === 'usage_update' || update.sessionUpdate === 'config_option_update') {
      turn.queue.enqueue({
        type: 'system',
        subtype: 'engine_stats',
        session_id: id,
        engineStats: this.sessionStats(id),
      });
      return;
    }
    if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
      turn.text += update.content.text;
      turn.queue.enqueue({
        type: 'stream_event',
        session_id: session.id,
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: update.content.text } },
      });
    } else if (['tool_call', 'tool_call_update'].includes(update.sessionUpdate)) {
      const id = update.toolCallId;
      if (!turn.tools.has(id)) {
        turn.tools.add(id);
        if (/invoke_subagent|browser_subagent/.test(update.name || '')) {
          const name = update.rawInput?.name || update.rawInput?.type_name || update.name;
          turn.subagents.set(id, name);
          turn.options.onTeamEvent?.({
            kind: 'task_created',
            taskId: id,
            teammate: name,
            teamName: 'Antigravity',
            subject: update.title || '原生子 agent 调用',
          });
        }
        turn.queue.enqueue({
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                id,
                name: update.name || update.title || 'AntigravityTool',
                input: update.rawInput || {},
              },
            ],
          },
        });
      }
      if (['completed', 'failed'].includes(update.status) && turn.subagents.has(id)) {
        turn.options.onTeamEvent?.({
          kind: 'task_completed',
          taskId: id,
          teammate: turn.subagents.get(id),
          teamName: 'Antigravity',
          subject: update.status === 'failed' ? '原生子 agent 调用失败' : '原生子 agent 调用结束',
        });
        turn.subagents.delete(id);
      }
      if (['completed', 'failed'].includes(update.status))
        turn.queue.enqueue({
          type: 'user',
          message: {
            content: [{ type: 'tool_result', id, text: JSON.stringify(update.rawOutput ?? update.content ?? '') }],
          },
        });
    }
  }
  private onRequest(request: RpcRequest): void {
    const turn = this.sessions.get(request.params.sessionId)?.active;
    if (!turn || turn.complete || turn.cancelled) {
      if (request.method === 'session/request_permission')
        this.client.respond(request.id, { outcome: { outcome: 'cancelled' } });
      else if (request.method === 'elicitation/create') this.client.respond(request.id, { action: 'cancel' });
      else this.client.reject(request.id, 'Unsupported ACP request');
      return;
    }
    if (turn.question) {
      this.client.reject(request.id, 'A user question is already pending');
      return;
    }
    let questions: any[];
    if (request.method === 'session/request_permission') {
      const options = request.params.options ?? [];
      const labels = options.map((o: any) => o.name);
      turn.question = { request, options, labels };
      questions = [
        {
          question: request.params.toolCall?.title || '允许此操作？',
          header: 'Antigravity',
          multiSelect: false,
          options: labels.map((label: string) => ({ label })),
        },
      ];
    } else if (request.method === 'elicitation/create' && request.params.mode !== 'url') {
      const fields = request.params.requestedSchema?.properties;
      if (
        !fields ||
        Object.values(fields).some((f: any) => !['string', 'boolean', 'number', 'integer'].includes(f.type))
      ) {
        this.client.respond(request.id, { action: 'decline' });
        return;
      }
      turn.question = { request, fields };
      questions = formQuestions(request.params);
    } else {
      this.client.reject(request.id, 'Unsupported ACP request');
      return;
    }
    turn.queue.enqueue({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: String(request.id), name: 'AskUserQuestion', input: { questions } }],
      },
    });
  }
  private answer(turn: Turn, id: string, answers: Record<string, string>): void {
    const question = turn.question;
    if (!question || String(question.request.id) !== id || turn.complete) return;
    const values = Object.values(answers);
    if (question.options) {
      const value = values[0] || '';
      const index = /^\d+$/.test(value) ? Number(value) - 1 : -1;
      const option = question.options.find((o) => o.name === value || o.optionId === value) || question.options[index];
      if (!option) {
        this.dismiss(turn);
        return;
      } // Unrecognized answers cannot approve tools.
      this.client.respond(question.request.id, { outcome: { outcome: 'selected', optionId: option.optionId } });
    } else {
      const content = formAnswer(question.request.params, answers);
      this.client.respond(question.request.id, content ? { action: 'accept', content } : { action: 'decline' });
    }
    turn.question = undefined;
  }
  activeWork(): Array<{ chatId: string; startTime: number }> {
    return [...this.sessions.values()].flatMap((s) =>
      s.active?.options.apiContext?.chatId
        ? [{ chatId: s.active.options.apiContext.chatId, startTime: s.active.started }]
        : [],
    );
  }
  async resetChat(chatId: string): Promise<void> {
    for (const session of [...this.sessions.values()])
      if (session.chatId === chatId) {
        session.active?.abort();
        await this.client.call('session/close', { sessionId: session.id }).catch(() => {});
        this.sessions.delete(session.id);
        this.stats.delete(session.id);
      }
  }
  private async resetConnection(): Promise<void> {
    for (const session of this.sessions.values())
      if (session.active) this.finish(session.active, session.id, 'Antigravity connection reset after cancellation');
    this.sessions.clear();
    this.stats.clear();
    await this.client.close();
  }
  async shutdown(): Promise<void> {
    this.stopping = true;
    this.work.shutdown();
    for (const turn of this.preparing) this.finish(turn, turn.options.sessionId, 'Antigravity runtime shutdown');
    for (const session of this.sessions.values())
      if (session.active) this.finish(session.active, session.id, 'Antigravity runtime shutdown');
    this.sessions.clear();
    this.stats.clear();
    await this.client.close();
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
