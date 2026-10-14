import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { BotConfigBase } from '../../config.js';
import type { Logger } from '../../utils/logger.js';
import type { TeamState } from '../../types.js';
import { AsyncQueue } from '../../utils/async-queue.js';
import type { ExecutionHandle, ExecutorOptions, SDKMessage } from '../claude/executor.js';
import { CodexAppServerClient, type RpcNotification, type RpcRequest } from './app-server-client.js';
import { buildCodexPrompt } from './executor.js';
import { sharedClaudeInstructions } from './instructions.js';
import { withCodexSessionStats } from './session-stats.js';

interface ActiveTurn {
  queue: AsyncQueue<SDKMessage>;
  complete: boolean;
  cancelled?: boolean;
  abort(): void;
  options: ExecutorOptions;
}
interface Scope {
  id: string;
  teamState?: TeamState;
  options: ExecutorOptions;
  model?: string;
  turnId?: string;
  startedAt: number;
  text: string;
  deltaItems: Set<string>;
  stats: {
    model?: string;
    contextWindow?: number;
    usage?: { input_tokens: number; output_tokens: number; total_tokens: number };
  };
  foreground?: ActiveTurn;
  question?: RpcRequest;
  questionIndex?: number;
  questionAnswers?: Record<string, string>;
  externalQuestion?: boolean;
}
export interface CodexGoal {
  objective: string;
  status: string;
  tokensUsed: number;
  tokenBudget?: number;
}
export interface CodexBackgroundJob {
  id: string;
  chatId: string;
  prompt: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'stopped';
  createdAt: number;
  threadId?: string;
  parentThreadId?: string;
  cwd: string;
  outputsDir?: string;
  model?: string;
  result?: string;
  error?: string;
  delivered?: boolean;
  retries?: number;
}
interface SavedGoal {
  chatId: string;
  threadId: string;
  cwd: string;
  outputsDir?: string;
  model?: string;
  goal: CodexGoal;
}

/** Native persistent threads and goal dispatcher, plus isolated durable background jobs. */
export class PersistentCodexExecutor extends EventEmitter {
  readonly client: CodexAppServerClient;
  private scopes = new Map<string, Scope>();
  private loading = new Map<string, Promise<Scope>>();
  private jobs = new Map<string, CodexBackgroundJob>();
  private goals = new Map<string, SavedGoal>();
  private jobHandles = new Map<string, ExecutionHandle>();
  private restoring = false;
  private recoveryTimer?: ReturnType<typeof setTimeout>;
  private shuttingDown = false;
  private storePath: string;
  private defaultModel?: Promise<string | undefined>;

  constructor(
    private config: BotConfigBase,
    private logger: Logger,
    client?: CodexAppServerClient,
  ) {
    super();
    this.client = client ?? new CodexAppServerClient(logger, config.codex?.executable);
    this.client.on('notification', (n: RpcNotification) => this.onNotification(n));
    this.client.on('request', (r: RpcRequest) => this.onRequest(r));
    this.client.on('disconnected', (err: Error) => this.disconnected(err));
    const dir = process.env.SESSION_STORE_DIR || path.join(os.homedir(), '.luckagent');
    this.storePath = path.join(dir, `codex-work-${config.name.replace(/[^\w-]/g, '_')}.json`);
    try {
      const data = JSON.parse(fs.readFileSync(this.storePath, 'utf8'));
      for (const job of data.jobs ?? []) this.jobs.set(job.id, job);
      for (const goal of data.goals ?? []) this.goals.set(goal.chatId, goal);
    } catch {
      /* First use. */
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.storePath), { recursive: true });
    const tmp = this.storePath + '.tmp';
    fs.writeFileSync(
      tmp,
      JSON.stringify({ jobs: [...this.jobs.values()].slice(-200), goals: [...this.goals.values()] }, null, 2) + '\n',
      { mode: 0o600 },
    );
    fs.renameSync(tmp, this.storePath);
  }
  private async ensureThread(options: ExecutorOptions): Promise<Scope> {
    if (this.shuttingDown) throw new Error('Codex runtime is shutting down');
    const id = options.sessionId;
    const existing = id && this.scopes.get(id);
    if (existing) {
      existing.options = options;
      return existing;
    }
    if (id && this.loading.has(id)) return this.loading.get(id)!;
    const load = this.loadThread(options);
    if (id) this.loading.set(id, load);
    try {
      return await load;
    } finally {
      if (id) this.loading.delete(id);
    }
  }
  private async loadThread(options: ExecutorOptions): Promise<Scope> {
    const defaultModel = await this.resolveDefaultModel();
    if (options.outputsDir) fs.mkdirSync(options.outputsDir, { recursive: true });
    const overrides = {
      cwd: options.cwd,
      model: options.model || defaultModel || null,
      modelProvider: 'openai',
      approvalPolicy: 'never',
      sandbox: 'workspace-write',
      developerInstructions: sharedClaudeInstructions(options.cwd),
    };
    // Install the listener scope before resuming: native goals can emit events during resume.
    const scope: Scope = {
      id: options.sessionId || '',
      options,
      startedAt: Date.now(),
      text: '',
      deltaItems: new Set(),
      stats: {},
    };
    if (options.sessionId) this.scopes.set(options.sessionId, scope);
    let response;
    try {
      response = await this.client.call(options.sessionId ? 'thread/resume' : 'thread/start', {
        ...overrides,
        ...(options.sessionId ? { threadId: options.sessionId } : {}),
      });
    } catch (error) {
      if (options.sessionId) this.scopes.delete(options.sessionId);
      throw error;
    }
    scope.id = response.thread.id;
    scope.model = response.model || options.model || this.config.codex?.model;
    scope.stats.model = scope.model;
    this.scopes.set(scope.id, scope);
    return scope;
  }

  private resolveDefaultModel(): Promise<string | undefined> {
    if (this.config.codex?.model) return Promise.resolve(this.config.codex.model);
    this.defaultModel ??= (async () => {
      try {
        const settings = await this.client.call('config/read', {
          includeLayers: false,
          cwd: this.config.claude.defaultWorkingDirectory,
        });
        if (typeof settings.config?.model === 'string') return settings.config.model;
        const catalog = await this.client.call('model/list', { includeHidden: false });
        const selected = catalog.data?.find((m: any) => m.isDefault);
        return selected?.model || selected?.id;
      } catch {
        return undefined;
      }
    })();
    return this.defaultModel;
  }

  startExecution(options: ExecutorOptions): ExecutionHandle {
    const queue = new AsyncQueue<SDKMessage>();
    let scope: Scope | undefined;
    const active: ActiveTurn = {
      queue,
      complete: false,
      options,
      abort: () => {
        if (active.complete) return;
        active.cancelled = true;
        if (scope?.turnId) void this.interrupt(scope).catch((error) => fail(error));
        else {
          active.complete = true;
          queue.enqueue(this.error('Codex execution cancelled', scope, true));
          queue.finish();
        }
      },
    };
    const fail = (error: unknown) => {
      if (active.complete) return;
      active.complete = true;
      options.abortController.signal.removeEventListener('abort', active.abort);
      if (scope?.foreground === active) scope.foreground = undefined;
      queue.enqueue(
        this.error(
          String(error instanceof Error ? error.message : error),
          scope,
          options.abortController.signal.aborted,
        ),
      );
      queue.finish();
    };
    if (options.abortController.signal.aborted) active.abort();
    else {
      options.abortController.signal.addEventListener('abort', active.abort, { once: true });
      void (async () => {
        if (options.maxTurns !== undefined || options.allowedTools !== undefined)
          throw new Error('Codex 暂不支持 allowedTools / maxTurns 限制；此受限任务请使用 Claude。');
        scope = await this.ensureThread(options);
        if (active.complete) return;
        const drainDeadline = Date.now() + 8000;
        while (scope.foreground?.complete && Date.now() < drainDeadline) await new Promise((r) => setTimeout(r, 25));
        if (scope.foreground) throw new Error('This Codex thread already has an active user turn');
        scope.foreground = active;
        queue.enqueue({ type: 'system', subtype: 'init', session_id: scope.id });
        if (scope.question && scope.externalQuestion) {
          scope.externalQuestion = false;
          const unanswered = scope.question.params.questions.slice(scope.questionIndex ?? 0);
          this.emitMessage(scope, {
            type: 'assistant',
            message: {
              content: [
                {
                  type: 'tool_use',
                  id: String(scope.question.id),
                  name: 'AskUserQuestion',
                  input: {
                    questions: unanswered.map((q: any) => ({
                      question: q.question,
                      header: q.header,
                      options: q.options ?? [],
                      multiSelect: false,
                    })),
                  },
                },
              ],
            },
          });
          return; // Attach to the existing question; no second turn or steer is needed.
        }
        const input: Array<Record<string, unknown>> = [{ type: 'text', text: buildCodexPrompt(options) }];
        for (const match of options.prompt.matchAll(/\[Image saved at: (.+?)\]/g))
          if (fs.existsSync(match[1])) input.push({ type: 'localImage', path: match[1] });
        const model = options.model || (await this.resolveDefaultModel());
        if (model) {
          scope.model = model;
          scope.stats.model = model;
        }
        if (scope.turnId) {
          // A user's message takes over the native goal continuation rather than waiting behind it.
          await this.client.call('turn/steer', { threadId: scope.id, expectedTurnId: scope.turnId, input });
        } else {
          const response = await this.client.call('turn/start', {
            threadId: scope.id,
            input,
            ...(model ? { model } : {}),
            ...(this.config.codex?.reasoningEffort ? { effort: this.config.codex.reasoningEffort } : {}),
            sandboxPolicy: {
              type: 'workspaceWrite',
              networkAccess: true,
              writableRoots: [options.cwd, ...(options.outputsDir ? [options.outputsDir] : [])],
            },
          });
          if (active.cancelled) {
            try {
              await this.client.call('turn/interrupt', { threadId: scope.id, turnId: response.turn.id });
            } catch {}
            await this.client.call('thread/backgroundTerminals/clean', { threadId: scope.id });
          } else if (!active.complete) scope.turnId = response.turn.id;
        }
      })().catch(fail);
    }
    return {
      stream: queue[Symbol.asyncIterator]() as AsyncGenerator<SDKMessage>,
      finish: () => {
        if (!active.complete) active.abort();
      },
      resolveQuestion: (_id, answers) => {
        if (!scope?.question) return;
        const request = scope.question;
        this.client.respond(request.id, {
          answers: Object.fromEntries(
            (request.params.questions ?? []).map((q: any) => [
              q.id,
              {
                answers: [
                  answers[q.question] ??
                    answers[q.id] ??
                    scope?.questionAnswers?.[q.id] ??
                    answers._answer ??
                    answers._auto ??
                    '',
                ],
              },
            ]),
          ),
        });
        scope.question = undefined;
      },
      sendAnswer: (_id, _sid, answer) => {
        if (!scope?.question) return;
        this.client.respond(scope.question.id, {
          answers: Object.fromEntries(
            (scope.question.params.questions ?? []).map((q: any) => [q.id, { answers: [answer] }]),
          ),
        });
        scope.question = undefined;
      },
    };
  }
  async *execute(options: ExecutorOptions): AsyncGenerator<SDKMessage> {
    const handle = this.startExecution(options);
    try {
      for await (const msg of handle.stream) yield msg;
    } finally {
      handle.finish();
    }
  }
  private error(message: string, scope?: Scope, cancelled = false): SDKMessage {
    return withCodexSessionStats(
      {
        type: 'result',
        subtype: cancelled ? 'error_cancelled' : 'error_during_execution',
        session_id: scope?.id,
        duration_ms: scope ? Date.now() - scope.startedAt : 0,
        is_error: true,
        errors: [message],
        result: scope?.text ?? '',
      },
      scope?.stats ?? {},
    );
  }
  private emitMessage(scope: Scope, message: SDKMessage): void {
    scope.foreground?.queue.enqueue(message);
  }
  private onNotification({ method, params: p }: RpcNotification): void {
    const scope = this.scopes.get(p.threadId);
    if (!scope) return;
    if (method === 'turn/started') {
      scope.turnId = p.turn.id;
      scope.startedAt = Date.now();
      scope.text = '';
      scope.deltaItems.clear();
      scope.stats = { model: scope.model };
      this.emit('turn-started', { options: scope.options });
    } else if (method === 'item/agentMessage/delta') {
      scope.text += p.delta ?? '';
      scope.deltaItems.add(p.itemId);
      this.emitMessage(scope, {
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: p.delta ?? '' } },
      });
    } else if (method === 'thread/tokenUsage/updated') {
      const usage = p.tokenUsage;
      scope.stats = {
        model: scope.model,
        contextWindow: usage.modelContextWindow,
        usage: {
          input_tokens: usage.last.inputTokens,
          output_tokens: usage.last.outputTokens,
          total_tokens: usage.last.totalTokens,
        },
      };
    } else if (method === 'item/started' || method === 'item/completed') {
      const item = p.item;
      const completed = method === 'item/completed';
      if (item.type === 'agentMessage' && completed) {
        scope.text = item.text;
        if (!scope.deltaItems.has(item.id))
          this.emitMessage(scope, { type: 'assistant', message: { content: [{ type: 'text', text: item.text }] } });
      } else if (item.type === 'subAgentActivity') {
        const id = item.agentPath || item.agentThreadId;
        this.teamEvents(scope, {
          receiverThreadIds: [id],
          displayName: item.agentPath?.split('/').pop(),
          prompt: `子 agent：${item.agentPath}`,
          agentsStates: {
            [id]: {
              status: item.kind === 'completed' ? 'completed' : item.kind === 'interrupted' ? 'errored' : 'running',
            },
          },
        });
      } else if (['commandExecution', 'fileChange', 'mcpToolCall', 'collabAgentToolCall'].includes(item.type)) {
        const name =
          item.type === 'commandExecution'
            ? 'Bash'
            : item.type === 'fileChange'
              ? 'Write'
              : item.type === 'collabAgentToolCall'
                ? 'Agent'
                : `${item.server}/${item.tool}`;
        this.emitMessage(scope, {
          type: completed ? 'user' : 'assistant',
          message: {
            content: [
              completed
                ? { type: 'tool_result', id: item.id, text: item.aggregatedOutput || '' }
                : {
                    type: 'tool_use',
                    id: item.id,
                    name,
                    input: { command: item.command, prompt: item.prompt, file_path: item.changes?.[0]?.path },
                  },
            ],
          },
        });
        if (item.type === 'collabAgentToolCall') this.teamEvents(scope, item);
      }
    } else if (method === 'turn/completed') {
      // A completion from an interrupted earlier turn must not finish a newer user turn.
      if (scope.turnId && scope.turnId !== p.turn.id) return;
      scope.turnId = undefined;
      scope.question = undefined;
      const result = withCodexSessionStats(
        {
          type: 'result',
          session_id: scope.id,
          result: scope.text,
          subtype:
            p.turn.status === 'completed'
              ? 'success'
              : p.turn.status === 'interrupted'
                ? 'error_cancelled'
                : 'error_during_execution',
          is_error: p.turn.status !== 'completed',
          errors: p.turn.error
            ? [p.turn.error.message]
            : p.turn.status === 'interrupted'
              ? ['Codex execution cancelled']
              : undefined,
          duration_ms: p.turn.durationMs ?? Date.now() - scope.startedAt,
        },
        scope.stats,
      );
      const active = scope.foreground;
      if (active) {
        active.complete = true;
        active.options.abortController.signal.removeEventListener('abort', active.abort);
        active.queue.enqueue(result);
        active.queue.finish();
        scope.foreground = undefined;
      } else if (!this.shuttingDown && scope.options.apiContext?.chatId)
        this.emit('autonomous-result', {
          options: scope.options,
          result,
          teamState: scope.teamState && structuredClone(scope.teamState),
        });
    } else if (method === 'thread/goal/updated' || method === 'thread/goal/cleared') {
      const chatId = scope.options.apiContext?.chatId;
      if (chatId) {
        if (p.goal)
          this.goals.set(chatId, {
            chatId,
            threadId: scope.id,
            cwd: scope.options.cwd,
            outputsDir: scope.options.outputsDir,
            model: scope.model,
            goal: p.goal,
          });
        else this.goals.delete(chatId);
        this.save();
        this.emit('goal-updated', { chatId, goal: p.goal ?? null });
      }
    }
  }
  private teamEvents(scope: Scope, item: any): void {
    const callback = scope.foreground ? scope.options.onTeamEvent : undefined;
    scope.teamState ??= { name: 'Codex', teammates: [], tasks: [] };
    for (const id of item.receiverThreadIds ?? []) {
      if (!id) continue;
      const teammate = item.displayName || `agent-${id.slice(-6)}`;
      const state = item.agentsStates?.[id];
      const completed = ['completed', 'shutdown', 'errored'].includes(state?.status);
      let task = scope.teamState.tasks.find((t) => t.taskId === id);
      if (!task) {
        task = { taskId: id, teammate, subject: item.prompt?.slice(0, 100) || '子 agent 任务', status: 'in_progress' };
        scope.teamState.tasks.push(task);
      }
      const member = scope.teamState.teammates.find((m) => m.name === teammate);
      if (member) member.status = completed ? 'idle' : 'working';
      else
        scope.teamState.teammates.push({
          name: teammate,
          status: completed ? 'idle' : 'working',
          lastSubject: task.subject,
        });
      callback?.({ kind: 'task_created', taskId: id, teammate, teamName: 'Codex', subject: task.subject });
      task.status = completed ? 'completed' : 'in_progress';
      if (completed) {
        callback?.({
          kind: 'task_completed',
          taskId: id,
          teammate,
          teamName: 'Codex',
          subject: state?.message?.slice(0, 100) || task.subject,
        });
      }
    }
  }
  activeWork(): Array<{ chatId: string; startTime: number }> {
    return [...this.scopes.values()]
      .filter((s) => s.turnId && s.options.apiContext?.chatId)
      .map((s) => ({ chatId: s.options.apiContext!.chatId, startTime: s.startedAt }));
  }
  hasActiveMainTurn(chatId: string): boolean {
    return [...this.scopes.values()].some(
      (s) =>
        s.turnId &&
        s.options.apiContext?.chatId === chatId &&
        ![...this.jobs.values()].some((j) => j.threadId === s.id),
    );
  }
  private onRequest(request: RpcRequest): void {
    const scope = this.scopes.get(request.params.threadId);
    const background = [...this.jobs.values()].some((j) => j.threadId === scope?.id && j.status === 'running');
    if (request.method === 'item/tool/requestUserInput' && scope && (!scope.foreground || background)) {
      scope.question = request;
      scope.questionIndex = 0;
      scope.questionAnswers = {};
      scope.externalQuestion = true;
      this.emitExternalQuestion(scope);
      return;
    }
    if (request.method === 'item/tool/requestUserInput' && scope?.foreground) {
      scope.question = request;
      scope.externalQuestion = false;
      scope.questionAnswers = {};
      scope.questionIndex = 0;
      this.emitMessage(scope, {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: String(request.id),
              name: 'AskUserQuestion',
              input: {
                questions: request.params.questions.map((q: any) => ({
                  question: q.question,
                  header: q.header,
                  options: q.options ?? [],
                  multiSelect: false,
                })),
              },
            },
          ],
        },
      });
      return;
    }
    // Do not grant permissions silently. Workspace operations use the thread's existing policy.
    if (request.method.includes('requestApproval'))
      this.client.respond(
        request.id,
        request.method.includes('permissions') ? { permissions: {}, scope: 'turn' } : { decision: 'decline' },
      );
    else if (request.method === 'item/tool/requestUserInput') this.client.respond(request.id, { answers: {} });
    else if (request.method === 'mcpServer/elicitation/request')
      this.client.respond(request.id, { action: 'decline', content: null });
    else
      this.client.respond(request.id, {
        success: false,
        contentItems: [{ type: 'inputText', text: 'Unsupported interactive request' }],
      });
  }
  private disconnected(error: Error): void {
    this.scopes.forEach((scope) => {
      const active = scope.foreground;
      if (!active) return;
      active.complete = true;
      active.options.abortController.signal.removeEventListener('abort', active.abort);
      active.queue.enqueue(this.error(error.message, scope));
      active.queue.finish();
    });
    this.scopes.clear();
    this.defaultModel = undefined;
    if (!this.shuttingDown && !this.recoveryTimer && [...this.goals.values()].some((g) => g.goal.status === 'active')) {
      this.recoveryTimer = setTimeout(() => {
        this.recoveryTimer = undefined;
        void this.restore().catch((error) => this.logger.warn({ error: String(error) }, 'Codex recovery failed'));
      }, 5000);
      this.recoveryTimer.unref();
    }
  }
  private async interrupt(scope: Scope): Promise<void> {
    if (scope.turnId) await this.client.call('turn/interrupt', { threadId: scope.id, turnId: scope.turnId });
    await this.client.call('thread/backgroundTerminals/clean', { threadId: scope.id });
  }

  async goal(
    options: ExecutorOptions,
    action: 'get' | 'set' | 'clear' | 'pause' | 'resume',
    objective?: string,
    tokenBudget?: number,
  ): Promise<{ threadId: string; goal: CodexGoal | null }> {
    const scope = await this.ensureThread(options);
    let response;
    if (action === 'get') response = await this.client.call('thread/goal/get', { threadId: scope.id });
    else if (action === 'clear')
      response = await this.client.call('thread/goal/clear', { threadId: scope.id, origin: 'user' });
    else
      response = await this.client.call('thread/goal/set', {
        threadId: scope.id,
        origin: 'user',
        status: action === 'pause' ? 'paused' : 'active',
        ...(objective ? { objective } : {}),
        ...(tokenBudget !== undefined ? { tokenBudget } : {}),
      });
    if (action === 'pause' || action === 'clear') await this.interrupt(scope);
    const current = action === 'clear' ? null : (response.goal ?? null);
    const chatId = options.apiContext?.chatId;
    if (chatId) {
      if (current)
        this.goals.set(chatId, {
          chatId,
          threadId: scope.id,
          cwd: options.cwd,
          outputsDir: options.outputsDir,
          model: scope.model,
          goal: current,
        });
      else this.goals.delete(chatId);
      this.save();
    }
    return { threadId: scope.id, goal: current };
  }
  async stopChat(chatId: string): Promise<void> {
    const goal = this.goals.get(chatId);
    if (goal?.goal.status === 'active') await this.goal(this.optionsForGoal(goal), 'pause');
    for (const scope of this.scopes.values())
      if (scope.options.apiContext?.chatId === chatId) await this.interrupt(scope);
    for (const job of this.jobs.values())
      if (job.chatId === chatId && ['queued', 'running'].includes(job.status))
        await this.stopBackground(job.id, chatId);
  }
  private emitExternalQuestion(scope: Scope): void {
    if (!scope.question) return;
    const request = scope.question;
    const index = scope.questionIndex ?? 0;
    this.emit('question', {
      chatId: scope.options.apiContext?.chatId,
      request: { ...request, params: { ...request.params, questions: [request.params.questions[index]] } },
    });
  }
  answerPending(chatId: string, text: string): boolean {
    const scope = [...this.scopes.values()].find(
      (s) => s.options.apiContext?.chatId === chatId && s.question && s.externalQuestion,
    );
    if (!scope?.question) return false;
    const request = scope.question;
    const question = request.params.questions[scope.questionIndex ?? 0];
    const index = /^\d+$/.test(text.trim()) ? Number(text.trim()) - 1 : -1;
    const answer = index >= 0 && question.options?.[index] ? question.options[index].label : text;
    scope.questionAnswers ??= {};
    scope.questionAnswers[question.id] = answer;
    scope.questionIndex = (scope.questionIndex ?? 0) + 1;
    if (scope.questionIndex < request.params.questions.length) {
      this.emitExternalQuestion(scope);
      return true;
    }
    this.client.respond(request.id, {
      answers: Object.fromEntries(
        request.params.questions.map((q: any) => [q.id, { answers: [scope.questionAnswers![q.id]] }]),
      ),
    });
    scope.question = undefined;
    scope.externalQuestion = false;
    return true;
  }
  async resetChat(chatId: string): Promise<void> {
    const saved = this.goals.get(chatId);
    if (saved) await this.goal(this.optionsForGoal(saved), 'clear');
    await this.stopChat(chatId);
    for (const scope of [...this.scopes.values()])
      if (scope.options.apiContext?.chatId === chatId) await this.releaseThread(scope.id);
  }
  async releaseThread(sessionId?: string): Promise<void> {
    if (!sessionId) return;
    const scope = this.scopes.get(sessionId);
    if (scope) await this.interrupt(scope);
    await this.client.call('thread/unsubscribe', { threadId: sessionId });
    this.scopes.delete(sessionId);
  }

  startBackground(options: ExecutorOptions, prompt: string): CodexBackgroundJob {
    const job: CodexBackgroundJob = {
      id: crypto.randomUUID().slice(0, 8),
      chatId: options.apiContext!.chatId,
      prompt,
      status: 'queued',
      createdAt: Date.now(),
      parentThreadId: options.sessionId,
      cwd: options.cwd,
      outputsDir: options.outputsDir,
      model: options.model,
    };
    this.jobs.set(job.id, job);
    this.save();
    void this.runBackground(job);
    return job;
  }
  listBackground(chatId: string): CodexBackgroundJob[] {
    return [...this.jobs.values()].filter((j) => j.chatId === chatId).slice(-30);
  }
  async stopBackground(id: string, chatId: string): Promise<void> {
    const job = this.jobs.get(id);
    if (!job || job.chatId !== chatId) throw new Error('后台任务不存在');
    if (!['running', 'queued'].includes(job.status)) return;
    job.status = 'stopped';
    this.save();
    this.jobHandles.get(id)?.finish();
    const scope = job.threadId && this.scopes.get(job.threadId);
    if (scope) await this.interrupt(scope);
  }
  private async runBackground(job: CodexBackgroundJob): Promise<void> {
    if (this.shuttingDown || this.jobs.get(job.id)?.status === 'stopped' || this.jobHandles.has(job.id)) return;
    try {
      if (!job.threadId && job.parentThreadId) {
        const fork = await this.client.call('thread/fork', { threadId: job.parentThreadId });
        job.threadId = fork.thread.id;
        this.save();
        await this.client.call('thread/goal/clear', { threadId: job.threadId, origin: 'user' });
      }
      if (this.jobs.get(job.id)?.status === 'stopped') return;
      job.status = 'running';
      this.save();
      const handle = this.startExecution({
        prompt: job.prompt,
        cwd: job.cwd,
        sessionId: job.threadId,
        outputsDir: job.outputsDir,
        model: job.model,
        abortController: new AbortController(),
        apiContext: { botName: this.config.name, chatId: job.chatId },
      });
      this.jobHandles.set(job.id, handle);
      let result: SDKMessage | undefined;
      for await (const message of handle.stream) {
        if (message.session_id) {
          job.threadId = message.session_id;
          this.save();
        }
        if (message.type === 'result') result = message;
      }
      if (this.jobs.get(job.id)?.status === 'stopped' || this.shuttingDown) return;
      if (
        result?.is_error &&
        /app-server exited|request timed out/i.test(result.errors?.join(' ') || '') &&
        (job.retries ?? 0) < 3
      ) {
        job.retries = (job.retries ?? 0) + 1;
        job.status = 'queued';
        this.save();
        const retry = setTimeout(() => void this.runBackground(job), 1000 * job.retries);
        retry.unref();
        return;
      }
      job.status = result?.is_error || !result ? 'failed' : 'completed';
      job.result = result?.result;
      job.error = result?.errors?.join('; ');
      this.save();
      this.emit('background-result', {
        job,
        result,
        teamState: job.threadId && this.scopes.get(job.threadId)?.teamState,
      });
    } catch (error) {
      if (this.shuttingDown || this.jobs.get(job.id)?.status === 'stopped') return;
      job.status = 'failed';
      job.error = String(error);
      this.save();
      this.emit('background-result', { job, result: this.error(job.error) });
    } finally {
      this.jobHandles.delete(job.id);
    }
  }
  markDelivered(id: string): void {
    const job = this.jobs.get(id);
    if (job) {
      job.delivered = true;
      this.save();
    }
  }
  private optionsForGoal(goal: SavedGoal): ExecutorOptions {
    return {
      prompt: '',
      cwd: goal.cwd,
      sessionId: goal.threadId,
      model: goal.model,
      outputsDir: goal.outputsDir,
      abortController: new AbortController(),
      apiContext: { botName: this.config.name, chatId: goal.chatId },
    };
  }
  async restore(): Promise<void> {
    if (this.restoring || this.shuttingDown) return;
    this.restoring = true;
    try {
      for (const goal of this.goals.values()) {
        if (goal.goal.status !== 'active') continue;
        try {
          await this.ensureThread(this.optionsForGoal(goal));
        } catch (error) {
          this.logger.warn({ error: String(error) }, 'Codex goal restore failed');
        }
      }
      for (const job of this.jobs.values()) {
        if (['running', 'queued'].includes(job.status)) {
          job.status = 'queued';
          void this.runBackground(job);
        } else if (!job.delivered && ['completed', 'failed'].includes(job.status))
          this.emit('background-result', {
            job,
            result: {
              type: 'result',
              subtype: job.status === 'completed' ? 'success' : 'error_during_execution',
              result: job.result,
              errors: job.error ? [job.error] : undefined,
              is_error: job.status === 'failed',
              total_cost_usd: 0,
            },
          });
      }
    } finally {
      this.restoring = false;
    }
  }
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    this.disconnected(new Error('Codex runtime shutdown'));
    await this.client.close();
    this.scopes.clear();
  }
}
