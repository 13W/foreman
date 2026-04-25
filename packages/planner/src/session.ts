import { ContentBlock } from '@agentclientprotocol/sdk';
import { Plan } from '@foreman-stack/shared';
import { Strategy } from './strategy.js';

export interface EscalationHistoryEntry {
  question: ContentBlock[];
  answer: string;
}

export interface SessionState {
  sessionId: string;
  originator_intent: string | null;
  plan: Plan | null;
  escalation_history: EscalationHistoryEntry[];
}

export class SessionManager {
  private sessions = new Map<string, SessionState>();

  constructor(private strategy: Strategy) {}

  createSession(sessionId: string): SessionState {
    const state: SessionState = {
      sessionId,
      originator_intent: null,
      plan: null,
      escalation_history: [],
    };
    this.sessions.set(sessionId, state);
    return state;
  }

  getSession(sessionId: string): SessionState | undefined {
    return this.sessions.get(sessionId);
  }

  removeSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  async handlePrompt(sessionId: string, prompt: ContentBlock[]): Promise<string> {
    const state = this.getSession(sessionId);
    if (!state) {
      throw new Error(`Session ${sessionId} not found`);
    }

    // On first prompt, extract originator intent if not set
    if (!state.originator_intent) {
      // Find the first text block to use as originator intent
      const textBlock = prompt.find((b) => b.type === 'text');
      if (textBlock && 'text' in textBlock) {
        state.originator_intent = textBlock.text;
      }
    }

    const response = await this.strategy.handle(state, prompt);

    if (response.kind === 'plan') {
      state.plan = response.plan;
      return JSON.stringify(response.plan, null, 2);
    } else if (response.kind === 'answer') {
      state.escalation_history.push({
        question: prompt,
        answer: response.text,
      });
      return response.text;
    } else {
      return `Refusal: ${response.reason}`;
    }
  }
}
