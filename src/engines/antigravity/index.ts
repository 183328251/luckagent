import type { BotConfigBase } from '../../config.js';
import type { Logger } from '../../utils/logger.js';
import type { Engine } from '../types.js';
import { StreamProcessor } from '../claude/stream-processor.js';
import { PersistentAntigravityExecutor } from './persistent-executor.js';

export class AntigravityEngine implements Engine {
  readonly name = 'antigravity' as const;
  constructor(
    private config: BotConfigBase,
    private logger: Logger,
  ) {}
  createExecutor(): PersistentAntigravityExecutor {
    return new PersistentAntigravityExecutor(this.config, this.logger);
  }
  createStreamProcessor(userPrompt: string): StreamProcessor {
    return new StreamProcessor(userPrompt);
  }
}
