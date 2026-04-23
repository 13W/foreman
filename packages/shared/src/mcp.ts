import { z } from 'zod';

export const McpServerSpec = z
  .object({
    name: z.string(),
    transport: z.enum(['stdio', 'sse']),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    url: z.string().optional(),
  })
  .strict();

export type McpServerSpec = z.infer<typeof McpServerSpec>;
