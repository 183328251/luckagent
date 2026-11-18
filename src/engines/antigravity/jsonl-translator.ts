import type { SDKMessage } from '../claude/executor.js';

export interface AntigravityEvent {
  event: string;
  conversation_id?: string;
  init?: { model?: string };
  step_update?: {
    conversation_id?: string;
    step_index: number;
    state: string;
    step_type: string;
    text_delta?: string;
    tool_name?: string;
    tool_info?: { name?: string; parameters?: Record<string, unknown>; output?: string; error?: { message?: string } };
  };
  result?: { conversation_id?: string; status: string; response?: string; error?: string };
}

export function createAntigravityState(sessionId?: string) {
  return {
    sessionId,
    text: '',
    startedAt: Date.now(),
    steps: new Map<number, string>(),
    tools: new Set<number>(),
    completedTools: new Set<number>(),
  };
}
export type AntigravityState = ReturnType<typeof createAntigravityState>;

/** Translate only native events; cumulative CLI usage is not context occupancy. */
export function translateAntigravityEvent(event: AntigravityEvent, state: AntigravityState): SDKMessage[] {
  const id = event.conversation_id || event.step_update?.conversation_id || event.result?.conversation_id;
  if (id) state.sessionId = id;
  if (event.event === 'init') return [{ type: 'system', subtype: 'init', session_id: state.sessionId }];
  if (event.event === 'result' && event.result) {
    const result = event.result;
    const failed = result.status !== 'SUCCESS';
    return [
      {
        type: 'result',
        subtype: failed ? 'error_during_execution' : 'success',
        session_id: state.sessionId,
        duration_ms: Date.now() - state.startedAt,
        result: result.response || state.text,
        is_error: failed,
        errors: failed ? [result.error || `Antigravity: ${result.status}`] : undefined,
      },
    ];
  }
  const step = event.step_update;
  if (event.event !== 'step_update' || !step) return [];
  if (step.step_type === 'agent_response' && step.text_delta) {
    const text = (state.steps.get(step.step_index) || '') + step.text_delta;
    state.steps.set(step.step_index, text);
    state.text += step.text_delta;
    const messages: SDKMessage[] = [
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: step.step_index,
          delta: { type: 'text_delta', text: step.text_delta },
        },
      },
    ];
    if (step.state === 'DONE')
      messages.push({ type: 'assistant', session_id: state.sessionId, message: { content: [{ type: 'text', text }] } });
    return messages;
  }
  if (step.step_type === 'tool') {
    const messages: SDKMessage[] = [];
    const tool = step.tool_info;
    const toolId = `agy-${step.step_index}`;
    if (!state.tools.has(step.step_index)) {
      state.tools.add(step.step_index);
      messages.push({
        type: 'assistant',
        session_id: state.sessionId,
        message: {
          content: [
            {
              type: 'tool_use',
              id: toolId,
              name: tool?.name || step.tool_name || 'AntigravityTool',
              input: tool?.parameters || {},
            },
          ],
        },
      });
    }
    if (step.state === 'DONE' && !state.completedTools.has(step.step_index)) {
      state.completedTools.add(step.step_index);
      messages.push({
        type: 'user',
        session_id: state.sessionId,
        message: { content: [{ type: 'tool_result', id: toolId, text: tool?.error?.message || tool?.output || '' }] },
      });
    }
    return messages;
  }
  return [];
}
