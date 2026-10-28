import { EMPTY_USAGE, addUsage, type TokenUsage } from '../providers/types.js';

export type TurnPhase = 'assembling' | 'streaming' | 'executing' | 'done' | 'aborted' | 'error';

const ALLOWED_TRANSITIONS: Record<TurnPhase, readonly TurnPhase[]> = {
  assembling: ['streaming', 'aborted', 'error'],
  streaming: ['assembling', 'executing', 'done', 'aborted', 'error'],
  executing: ['assembling', 'aborted', 'error'],
  done: [],
  aborted: [],
  error: [],
};

/**
 * Explicit per-turn state machine. Every transition is validated so a failed
 * provider/tool path cannot leave a turn in an impossible state.
 */
export class TurnState {
  readonly turnId: string;
  readonly startedAt = Date.now();
  private current: TurnPhase = 'assembling';
  private currentUsage: TokenUsage = EMPTY_USAGE;
  private currentSteps = 0;

  constructor(turnId: string) {
    this.turnId = turnId;
  }

  get phase(): TurnPhase {
    return this.current;
  }

  get usage(): TokenUsage {
    return this.currentUsage;
  }

  get steps(): number {
    return this.currentSteps;
  }

  get durationMs(): number {
    return Date.now() - this.startedAt;
  }

  get isTerminal(): boolean {
    return this.current === 'done' || this.current === 'aborted' || this.current === 'error';
  }

  transition(next: TurnPhase): void {
    if (next === this.current) return;
    const allowed = ALLOWED_TRANSITIONS[this.current];
    if (!allowed.includes(next)) {
      throw new Error('Invalid turn transition: ' + this.current + ' -> ' + next + '.');
    }
    this.current = next;
  }

  addUsage(event: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheCreationTokens?: number }): void {
    this.currentUsage = addUsage(this.currentUsage, event);
  }

  incrementStep(): void {
    this.currentSteps += 1;
  }
}
