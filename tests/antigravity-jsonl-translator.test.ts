import { describe, expect, it } from 'vitest';
import { createAntigravityState, translateAntigravityEvent } from '../src/engines/antigravity/jsonl-translator.js';
import { StreamProcessor } from '../src/engines/claude/stream-processor.js';
describe('Antigravity native event translation', () => {
  it('streams response fragments without duplication and retains conversation ownership', () => {
    const state = createAntigravityState();
    translateAntigravityEvent({ event: 'init', conversation_id: 'agy-1' }, state);
    const processor = new StreamProcessor('test');
    for (const [text_delta, status] of [
      ['你', 'ACTIVE'],
      ['好', 'ACTIVE'],
      ['\n', 'DONE'],
    ]) {
      for (const message of translateAntigravityEvent(
        {
          event: 'step_update',
          step_update: { step_index: 1, step_type: 'agent_response', state: status, text_delta },
        },
        state,
      ))
        processor.processMessage(message);
    }
    expect(state.text).toBe('你好\n');
    expect(processor.processMessage({ type: 'tool_use_summary' }).responseText).toBe('你好\n');
    const result = translateAntigravityEvent(
      { event: 'result', result: { status: 'SUCCESS', response: '你好\n' } },
      state,
    )[0];
    expect(result).toMatchObject({ session_id: 'agy-1', result: '你好\n', is_error: false });
    expect(result.modelUsage).toBeUndefined();
  });
  it('emits a tool once across ACTIVE/DONE and preserves failures', () => {
    const state = createAntigravityState('agy-1');
    const step = {
      step_index: 2,
      step_type: 'tool',
      tool_name: 'run_command',
      tool_info: { parameters: { CommandLine: 'echo hello' }, output: 'hello' },
    };
    expect(
      translateAntigravityEvent({ event: 'step_update', step_update: { ...step, state: 'ACTIVE' } }, state)[0].message
        ?.content?.[0].type,
    ).toBe('tool_use');
    expect(
      translateAntigravityEvent({ event: 'step_update', step_update: { ...step, state: 'DONE' } }, state)[0].message
        ?.content?.[0],
    ).toMatchObject({ type: 'tool_result', text: 'hello' });
    expect(translateAntigravityEvent({ event: 'step_update', step_update: { ...step, state: 'DONE' } }, state)).toEqual(
      [],
    );
    expect(
      translateAntigravityEvent({ event: 'result', result: { status: 'ERROR', error: 'quota exceeded' } }, state)[0],
    ).toMatchObject({ is_error: true, errors: ['quota exceeded'] });
    expect(translateAntigravityEvent({ event: 'future_event' }, state)).toEqual([]);
  });
});
