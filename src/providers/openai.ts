import OpenAI from 'openai';
import type { ProviderAdapter } from './ProviderAdapter.js';
import type { ChatRequest, ChatChunk, ChatResponse, Target, CallContext, Usage } from '../domain/types.js';
import { classifyHttpError, classifyNetworkError, classifyTimeout } from './classify.js';
import { env } from '../config/env.js';

export class OpenAIAdapter implements ProviderAdapter {
  readonly name = 'openai';
  private client: OpenAI;

  constructor() {
    this.client = new OpenAI({
      apiKey: env.OPENAI_API_KEY,
    });
  }

  async complete(req: ChatRequest, target: Target, ctx: CallContext): Promise<{ response: ChatResponse; usage: Usage }> {
    const timeoutSignal = AbortSignal.timeout(target.timeoutMs);
    const signal = AbortSignal.any([ctx.signal, timeoutSignal]);

    const messages = req.messages.map(m => ({ role: m.role, content: m.content })) as OpenAI.ChatCompletionMessageParam[];

    try {
      const completion = await this.client.chat.completions.create({
        model: target.model,
        messages,
        temperature: req.temperature,
        top_p: req.top_p,
        max_tokens: req.max_tokens,
        stop: req.stop,
      }, { signal });

      const choice = completion.choices[0];
      const usageData = completion.usage;

      const usage: Usage = {
        prompt_tokens: usageData?.prompt_tokens ?? 0,
        completion_tokens: usageData?.completion_tokens ?? 0,
        total_tokens: usageData?.total_tokens ?? 0,
      };

      const response: ChatResponse = {
        id: `chatcmpl-${ctx.requestId}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: target.model,
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: choice.message.content ?? '',
          },
          finish_reason: (choice.finish_reason as 'stop' | 'length') ?? 'stop',
        }],
        usage,
      };

      return { response, usage };
    } catch (err: unknown) {
      if (err instanceof OpenAI.APIError) {
        throw classifyHttpError(err.status ?? 500);
      }
      if (err instanceof DOMException && err.name === 'TimeoutError') {
        throw classifyTimeout();
      }
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw classifyNetworkError();
      }
      throw classifyNetworkError();
    }
  }

  async *stream(req: ChatRequest, target: Target, ctx: CallContext): AsyncIterable<ChatChunk> {
    const timeoutSignal = AbortSignal.timeout(target.timeoutMs);
    const signal = AbortSignal.any([ctx.signal, timeoutSignal]);

    const messages = req.messages.map(m => ({ role: m.role, content: m.content })) as OpenAI.ChatCompletionMessageParam[];

    let stream: AsyncIterable<OpenAI.ChatCompletionChunk>;
    try {
      stream = await this.client.chat.completions.create({
        model: target.model,
        messages,
        temperature: req.temperature,
        top_p: req.top_p,
        max_tokens: req.max_tokens,
        stop: req.stop,
        stream: true,
        stream_options: { include_usage: true },
      }, { signal }) as unknown as AsyncIterable<OpenAI.ChatCompletionChunk>;
    } catch (err: unknown) {
      if (err instanceof OpenAI.APIError) throw classifyHttpError(err.status ?? 500);
      if (err instanceof DOMException && err.name === 'TimeoutError') throw classifyTimeout();
      throw classifyNetworkError();
    }

    const id = `chatcmpl-${ctx.requestId}`;
    const created = Math.floor(Date.now() / 1000);

    try {
      for await (const chunk of stream) {
        const choice = chunk.choices?.[0];
        yield {
          id,
          object: 'chat.completion.chunk',
          created,
          model: target.model,
          choices: [{
            index: 0,
            delta: {
              role: choice?.delta?.role as 'assistant' | undefined,
              content: choice?.delta?.content ?? undefined,
            },
            finish_reason: (choice?.finish_reason as 'stop' | 'length' | null) ?? null,
          }],
          usage: chunk.usage ? {
            prompt_tokens: chunk.usage.prompt_tokens,
            completion_tokens: chunk.usage.completion_tokens,
            total_tokens: chunk.usage.total_tokens,
          } : null,
        };
      }
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'TimeoutError') throw classifyTimeout();
      throw classifyNetworkError();
    }
  }
}
