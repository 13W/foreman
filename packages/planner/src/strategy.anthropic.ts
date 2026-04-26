import Anthropic from '@anthropic-ai/sdk';
import { ContentBlock } from '@agentclientprotocol/sdk';
import { Plan, Subtask } from '@foreman-stack/shared';
import { Strategy, StrategyResponse } from './strategy.js';
import { SessionState } from './session.js';
import { PlannerConfig } from './config.js';
import {
  DECOMPOSITION_SYSTEM_PROMPT,
  ESCALATION_SYSTEM_PROMPT,
} from './prompts.js';
import { Logger } from 'pino';
import { zodToJsonSchema } from 'zod-to-json-schema';

export class AnthropicStrategy implements Strategy {
  private client: Anthropic;

  constructor(
    private config: PlannerConfig,
    private logger: Logger,
  ) {
    const apiKey = process.env[config.llm.api_key_env];
    if (!apiKey) {
      throw new Error(`Environment variable ${config.llm.api_key_env} not set`);
    }
    this.client = new Anthropic({ apiKey });
  }

  async handle(state: SessionState, prompt: ContentBlock[]): Promise<StrategyResponse> {
    const isFirstPrompt = !state.plan;

    if (isFirstPrompt) {
      return this.handleDecomposition(state, prompt);
    } else {
      return this.handleEscalation(state, prompt);
    }
  }

  private async handleDecomposition(state: SessionState, prompt: ContentBlock[]): Promise<StrategyResponse> {
    const messages: Anthropic.MessageParam[] = [
      {
        role: 'user',
        content: prompt.map((b) => {
          if (b.type === 'text') {
            return { type: 'text', text: b.text };
          }
          // ACP ContentBlock can have other types, but for now we only support text for LLM
          return { type: 'text', text: JSON.stringify(b) };
        }),
      },
    ];

    const tools: Anthropic.Tool[] = [
      {
        name: 'submit_plan',
        description: 'Submit a validated plan for the requested task',
        input_schema: zodToJsonSchema(Plan as any) as any,
      },
    ];

    let retries = 0;
    const maxRetries = this.config.llm.max_validation_retries;

    while (retries <= maxRetries) {
      try {
        const response = await this.client.messages.create({
          model: this.config.llm.model,
          max_tokens: this.config.llm.max_tokens_per_plan,
          system: DECOMPOSITION_SYSTEM_PROMPT,
          messages,
          tools,
          tool_choice: { type: 'tool', name: 'submit_plan' },
        });

        const toolCall = response.content.find((c) => c.type === 'tool_use' && c.name === 'submit_plan') as Anthropic.ToolUseBlock | undefined;

        if (!toolCall) {
          throw new Error('Model did not use submit_plan tool');
        }

        const planResult = Plan.safeParse(toolCall.input);
        if (planResult.success) {
          return { kind: 'plan', plan: planResult.data };
        } else {
          const errorMsg = planResult.error.issues.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ');
          this.logger.warn({ errorMsg, retries }, 'Plan validation failed, retrying');
          
          messages.push({
            role: 'assistant',
            content: response.content,
          });
          messages.push({
            role: 'user',
            content: [
              {
                type: 'text',
                text: `Plan validation failed: ${errorMsg}. Please correct the plan and try again.`,
              },
            ],
          });
          retries++;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error({ err }, 'Error during decomposition call');
        return { kind: 'refusal', reason: `LLM error: ${msg}` };
      }
    }

    return { kind: 'refusal', reason: `Failed to generate a valid plan after ${maxRetries} retries` };
  }

  private async handleEscalation(state: SessionState, prompt: ContentBlock[]): Promise<StrategyResponse> {
    // Build history for escalation
    const messages: Anthropic.MessageParam[] = [];

    // 1. Initial intent
    if (state.originator_intent) {
      messages.push({
        role: 'user',
        content: state.originator_intent,
      });
    }

    // 2. The plan
    if (state.plan) {
      messages.push({
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: `I have created the following plan:\n${JSON.stringify(state.plan, null, 2)}`,
          },
        ],
      });
    }

    // 3. Prior escalation history
    for (const entry of state.escalation_history) {
      messages.push({
        role: 'user',
        content: entry.question.map((b) => (b.type === 'text' ? b.text : JSON.stringify(b))).join('\n'),
      });
      messages.push({
        role: 'assistant',
        content: entry.answer,
      });
    }

    // 4. Current question
    messages.push({
      role: 'user',
      content: prompt.map((b) => (b.type === 'text' ? b.text : JSON.stringify(b))).join('\n'),
    });

    const tools: Anthropic.Tool[] = [
      {
        name: 'submit_answer',
        description: 'Submit an answer to the worker escalation',
        input_schema: {
          type: 'object',
          properties: {
            answer: { type: 'string', description: 'The clear, decisive answer for the worker' },
          },
          required: ['answer'],
        },
      },
    ];

    try {
      const response = await this.client.messages.create({
        model: this.config.llm.model,
        max_tokens: 4096,
        system: ESCALATION_SYSTEM_PROMPT,
        messages,
        tools,
        tool_choice: { type: 'tool', name: 'submit_answer' },
      });

      const toolCall = response.content.find((c) => c.type === 'tool_use' && c.name === 'submit_answer') as Anthropic.ToolUseBlock | undefined;

      if (!toolCall) {
        // Fallback to text if tool use failed but we got text
        const textBlock = response.content.find((c) => c.type === 'text') as Anthropic.TextBlock | undefined;
        if (textBlock) {
          return { kind: 'answer', text: textBlock.text };
        }
        throw new Error('Model did not use submit_answer tool');
      }

      const input = toolCall.input as { answer: string };
      return { kind: 'answer', text: input.answer };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error({ err }, 'Error during escalation call');
      return { kind: 'refusal', reason: `LLM error: ${msg}` };
    }
  }
}
