import { z } from 'zod';

export const MessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string(),
});

export const ChatRequestSchema = z.object({
  model: z.string(),
  messages: z.array(MessageSchema).min(1),
  temperature: z.number().min(0).max(1).optional(),
  top_p: z.number().min(0).max(1).optional(),
  max_tokens: z.number().int().positive().optional(),
  stop: z.union([z.string(), z.array(z.string()).max(4)]).optional(),
  stream: z.boolean().optional(),
  stream_options: z.object({ include_usage: z.boolean().optional() }).optional(),
}).strict();

export type ChatRequestInput = z.infer<typeof ChatRequestSchema>;

export const RouteTargetSchema = z.object({
  provider: z.enum(['openai', 'anthropic']),
  model: z.string(),
  timeoutMs: z.number().positive(),
});

export const RouteAliasSchema = z.object({
  chain: z.array(RouteTargetSchema).min(1),
  cacheTtlSeconds: z.number().positive().optional(),
});

export const RouteConfigSchema = z.object({
  aliases: z.record(RouteAliasSchema),
});

export const PriceEntrySchema = z.object({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
});

export const PricesConfigSchema = z.object({
  models: z.record(PriceEntrySchema),
});
