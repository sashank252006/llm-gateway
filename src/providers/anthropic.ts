import Anthropic from '@anthropic-ai/sdk';
import type { ProviderAdapter } from './ProviderAdapter.js';
import type { ChatRequest, ChatChunk, ChatResponse, Target, CallContext, Usage, FinishReason } from '../domain/types.js';
import { classifyHttpError, classifyNetworkError, classifyTimeout } from './classify.js';
import { env } from '../config/env.js';

export class AnthropicAdapter implements ProviderAdapter {
  readonly name = 'anthropic';
  private client: Anthropic;

  constructor() {
    this.client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, baseURL: env.ANTHROPIC_BASE_URL, maxRetries: 0 });
  }

  private buildParams(req: ChatRequest, target: Target) {
    // Extract system message (Anthropic takes it as top-level field)
    const systemMessages = req.messages.filter(m => m.role === 'system');
    const otherMessages = req.messages.filter(m => m.role !== 'system');
    const system = systemMessages.map(m => m.content).join('\n') || undefined;

    const messages: Anthropic.MessageParam[] = otherMessages.map(m => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    }));

    const stop_sequences = req.stop
      ? (Array.isArray(req.stop) ? req.stop : [req.stop])
      : undefined;

    return {
      model: target.model,
      messages,
      system,
      max_tokens: req.max_tokens ?? 4096, // Anthropic requires max_tokens
      temperature: req.temperature,
      top_p: req.temperature === undefined ? req.top_p : undefined,
      stop_sequences,
    };
  }

  private mapStopReason(reason: string | null): FinishReason {
    if (reason === 'end_turn') return 'stop';
    if (reason === 'max_tokens') return 'length';
    if (reason === 'refusal') return 'content_filter';
    return 'stop';
  }

  async complete(req: ChatRequest, target: Target, ctx: CallContext): Promise<{ response: ChatResponse; usage: Usage }> {
    const params = this.buildParams(req, target);

    try {
      const msg = await this.client.messages.create(
        { ...params, stream: false },
        { signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(target.timeoutMs)]) }
      );

      const content = msg.content.find(b => b.type === 'text');
      const usage: Usage = {
        prompt_tokens: msg.usage.input_tokens,
        completion_tokens: msg.usage.output_tokens,
        total_tokens: msg.usage.input_tokens + msg.usage.output_tokens,
      };

      const response: ChatResponse = {
        id: `chatcmpl-${ctx.requestId}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: target.model,
        choices: [{
          index: 0,
          message: { role: 'assistant', content: content?.type === 'text' ? content.text : '' },
          finish_reason: this.mapStopReason(msg.stop_reason),
        }],
        usage,
      };

      return { response, usage };
    } catch (err: unknown) { throw classifyAnthropicError(err); }
  }

  async *stream(req: ChatRequest, target: Target, ctx: CallContext): AsyncIterable<ChatChunk> {
    const params = this.buildParams(req, target);
    const id = `chatcmpl-${ctx.requestId}`;
    const created = Math.floor(Date.now() / 1000);

    let inputTokens = 0;
    let outputTokens = 0;

    try {
      const stream = this.client.messages.stream(
        { ...params },
        { signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(target.timeoutMs)]) }
      );

      for await (const event of stream) {
        if (event.type === 'message_start') {
          inputTokens = event.message.usage.input_tokens;
        } else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          yield {
            id,
            object: 'chat.completion.chunk',
            created,
            model: target.model,
            choices: [{
              index: 0,
              delta: { content: event.delta.text },
              finish_reason: null,
            }],
          };
        } else if (event.type === 'message_delta') {
          outputTokens = event.usage.output_tokens;
          if (event.delta.stop_reason) {
            yield {
              id,
              object: 'chat.completion.chunk',
              created,
              model: target.model,
              choices: [{
                index: 0,
                delta: {},
                finish_reason: this.mapStopReason(event.delta.stop_reason),
              }],
              usage: {
                prompt_tokens: inputTokens,
                completion_tokens: outputTokens,
                total_tokens: inputTokens + outputTokens,
              },
            };
          }
        }
      }
    } catch (err: unknown) { throw classifyAnthropicError(err); }
  }
}

function retryAfterMs(err: { headers?: { get?: (name: string) => string | null } | Record<string, string | undefined> }): number | undefined {
  const headers = err.headers;
  const value = headers && 'get' in headers && typeof headers.get === 'function'
    ? headers.get('retry-after')
    : (headers as Record<string, string | undefined> | undefined)?.['retry-after'];
  if (!value) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : undefined;
}

function classifyAnthropicError(err: unknown) {
  if (err instanceof Anthropic.APIConnectionTimeoutError) return classifyTimeout();
  if (err instanceof Anthropic.APIUserAbortError) return classifyNetworkError();
  if (err instanceof Anthropic.APIConnectionError) return classifyNetworkError();
  if (err instanceof Anthropic.APIError) return classifyHttpError(err.status ?? 500, retryAfterMs(err));
  if (err instanceof DOMException && err.name === 'TimeoutError') return classifyTimeout();
  return classifyNetworkError();
}
