import type { ChatRequest, ChatChunk, ChatResponse, Target, CallContext, Usage } from '../domain/types.js';

export interface ProviderAdapter {
  readonly name: string;
  complete(
    req: ChatRequest,
    target: Target,
    ctx: CallContext
  ): Promise<{ response: ChatResponse; usage: Usage }>;
  stream(
    req: ChatRequest,
    target: Target,
    ctx: CallContext
  ): AsyncIterable<ChatChunk>;
}
