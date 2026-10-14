import type { BotConfigBase } from '../../config.js';
import type { Logger } from '../../utils/logger.js';
import type { Engine } from '../types.js';
import { StreamProcessor } from '../claude/stream-processor.js';
import { PersistentCodexExecutor } from './persistent-executor.js';

export class CodexEngine implements Engine {
  readonly name = 'codex' as const;

  constructor(
    private config: BotConfigBase,
    private logger: Logger,
  ) {}

  createExecutor(): PersistentCodexExecutor {
    return new PersistentCodexExecutor(this.config, this.logger);
  }

  createStreamProcessor(userPrompt: string): StreamProcessor {
    return new StreamProcessor(userPrompt);
  }
}

export { CodexExecutor } from './executor.js';
export { createCodexTranslatorState, translateCodexJsonEvent } from './jsonl-translator.js';
export type { CodexJsonEvent, CodexTranslatorState } from './jsonl-translator.js';
