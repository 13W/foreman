import { ContentBlock } from '@agentclientprotocol/sdk';
import { Strategy, StrategyResponse } from './strategy.js';
import { SessionState } from './session.js';

export class StubStrategy implements Strategy {
  async handle(state: SessionState, prompt: ContentBlock[]): Promise<StrategyResponse> {
    // If it's the first prompt (no plan yet), return a canned plan
    if (!state.plan) {
      return {
        kind: 'plan',
        plan: {
          plan_id: 'stub-plan-id',
          originator_intent: state.originator_intent || 'unknown intent',
          goal_summary: 'Stub goal summary',
          source: 'external_planner',
          batches: [
            {
              batch_id: 'b1',
              subtasks: [
                {
                  id: 't1',
                  assigned_agent: 'stub-agent',
                  description: 'Stub subtask description',
                  inputs: {
                    relevant_files: [],
                    constraints: [],
                    context_from_prior_tasks: [],
                  },
                  expected_output: 'Stub expected output',
                },
              ],
            },
          ],
        },
      };
    }

    // Subsequent prompts are follow-up questions
    return {
      kind: 'answer',
      text: 'stub answer',
    };
  }
}
