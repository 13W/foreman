import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AnthropicStrategy } from './strategy.anthropic.js';
import { PlannerConfig } from './config.js';
import { SessionState } from './session.js';
import { ContentBlock } from '@agentclientprotocol/sdk';
import { pino } from 'pino';

// Mock Anthropic
const mockMessagesCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: class {
      messages = {
        create: mockMessagesCreate,
      };
    },
  };
});

describe('AnthropicStrategy', () => {
  const logger = pino({ level: 'silent' });
  const config: PlannerConfig = {
    planner: { name: 'test-planner', version: '0.1.0' },
    llm: {
      model: 'claude-3-5-sonnet-20240620',
      api_key_env: 'ANTHROPIC_API_KEY',
      max_tokens_per_plan: 1000,
      max_validation_retries: 2,
    },
    logging: { level: 'info', format: 'json', destination: 'stderr' },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ANTHROPIC_API_KEY = 'test-key';
  });

  it('should handle decomposition and return a valid plan', async () => {
    const strategy = new AnthropicStrategy(config, logger);
    const state: SessionState = {
      sessionId: 's1',
      originator_intent: 'test intent',
      plan: null,
      escalation_history: [],
    };
    const prompt: ContentBlock[] = [{ type: 'text', text: 'test intent' }];

    const mockPlan = {
      plan_id: 'p1',
      originator_intent: 'test intent',
      goal_summary: 'test goal',
      source: 'external_planner',
      batches: [
        {
          batch_id: 'b1',
          subtasks: [
            {
              id: 't1',
              assigned_agent: 'a1',
              description: 'd1',
              inputs: { relevant_files: [], constraints: [], context_from_prior_tasks: [] },
              expected_output: 'o1',
            },
          ],
        },
      ],
    };

    mockMessagesCreate.mockResolvedValueOnce({
      content: [
        {
          type: 'tool_use',
          id: 'call_1',
          name: 'submit_plan',
          input: mockPlan,
        },
      ],
    });

    const response = await strategy.handle(state, prompt);

    expect(response.kind).toBe('plan');
    if (response.kind === 'plan') {
      expect(response.plan).toEqual(mockPlan);
    }
    expect(mockMessagesCreate).toHaveBeenCalledTimes(1);
  });

  it('should retry on validation failure', async () => {
    const strategy = new AnthropicStrategy(config, logger);
    const state: SessionState = {
      sessionId: 's1',
      originator_intent: 'test intent',
      plan: null,
      escalation_history: [],
    };
    const prompt: ContentBlock[] = [{ type: 'text', text: 'test intent' }];

    const invalidPlan = {
      plan_id: 'p1',
      // missing fields to trigger zod failure
    };

    const validPlan = {
      plan_id: 'p1',
      originator_intent: 'test intent',
      goal_summary: 'test goal',
      source: 'external_planner',
      batches: [
        {
          batch_id: 'b1',
          subtasks: [
            {
              id: 't1',
              assigned_agent: 'a1',
              description: 'd1',
              inputs: { relevant_files: [], constraints: [], context_from_prior_tasks: [] },
              expected_output: 'o1',
            },
          ],
        },
      ],
    };

    mockMessagesCreate
      .mockResolvedValueOnce({
        content: [
          {
            type: 'tool_use',
            id: 'call_1',
            name: 'submit_plan',
            input: invalidPlan,
          },
        ],
      })
      .mockResolvedValueOnce({
        content: [
          {
            type: 'tool_use',
            id: 'call_2',
            name: 'submit_plan',
            input: validPlan,
          },
        ],
      });

    const response = await strategy.handle(state, prompt);

    expect(response.kind).toBe('plan');
    expect(mockMessagesCreate).toHaveBeenCalledTimes(2);
  });

  it('should return refusal after max retries', async () => {
    const strategy = new AnthropicStrategy(config, logger);
    const state: SessionState = {
      sessionId: 's1',
      originator_intent: 'test intent',
      plan: null,
      escalation_history: [],
    };
    const prompt: ContentBlock[] = [{ type: 'text', text: 'test intent' }];

    mockMessagesCreate.mockResolvedValue({
      content: [
        {
          type: 'tool_use',
          id: 'call_1',
          name: 'submit_plan',
          input: { invalid: 'plan' },
        },
      ],
    });

    const response = await strategy.handle(state, prompt);

    expect(response.kind).toBe('refusal');
    expect(mockMessagesCreate).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
  });

  it('should handle escalation and return an answer', async () => {
    const strategy = new AnthropicStrategy(config, logger);
    const state: SessionState = {
      sessionId: 's1',
      originator_intent: 'test intent',
      plan: {
        plan_id: 'p1',
        originator_intent: 'test intent',
        goal_summary: 'test goal',
        source: 'external_planner',
        batches: [],
      } as any,
      escalation_history: [],
    };
    const prompt: ContentBlock[] = [{ type: 'text', text: 'worker question' }];

    mockMessagesCreate.mockResolvedValueOnce({
      content: [
        {
          type: 'tool_use',
          id: 'call_1',
          name: 'submit_answer',
          input: { answer: 'test answer' },
        },
      ],
    });

    const response = await strategy.handle(state, prompt);

    expect(response.kind).toBe('answer');
    if (response.kind === 'answer') {
      expect(response.text).toBe('test answer');
    }
    expect(mockMessagesCreate).toHaveBeenCalledTimes(1);
  });
});
