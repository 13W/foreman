import { ContentBlock } from '@agentclientprotocol/sdk';
import { Plan } from '@foreman-stack/shared';
import { SessionState } from './session.js';

export type StrategyResponse =
  | { kind: 'plan'; plan: Plan }
  | { kind: 'answer'; text: string }
  | { kind: 'refusal'; reason: string };

export interface Strategy {
  handle(state: SessionState, prompt: ContentBlock[]): Promise<StrategyResponse>;
}
