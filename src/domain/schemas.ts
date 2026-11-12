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
}).strict().superRefine((request, context) => {
  const firstNonSystem = request.messages.findIndex((message) => message.role !== 'system');
  const systemMessages = firstNonSystem === -1 ? request.messages : request.messages.slice(0, firstNonSystem);
  if (systemMessages.length !== request.messages.filter((message) => message.role === 'system').length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['messages'], message: 'system messages must appear before all conversation messages' });
  }
  const conversation = request.messages.filter((message) => message.role !== 'system');
  if (conversation.length === 0 || conversation[0]?.role !== 'user') {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['messages'], message: 'a conversation must start with a user message' });
  }
  for (let index = 1; index < conversation.length; index++) {
    if (conversation[index]?.role === conversation[index - 1]?.role) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['messages', index], message: 'user and assistant messages must alternate' });
      break;
    }
  }
});

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
  aliases: z.record(z.string(), RouteAliasSchema),
});

export const PriceEntrySchema = z.object({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
});

export const PricesConfigSchema = z.object({
  models: z.record(z.string(), PriceEntrySchema),
});
