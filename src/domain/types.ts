export interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  model: string;
  messages: Message[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stop?: string | string[];
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export type FinishReason = 'stop' | 'length' | 'content_filter' | null;

export interface ChatResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: Message;
    finish_reason: FinishReason;
  }>;
  usage: Usage;
}

export interface ChatChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: { role?: 'assistant'; content?: string };
    finish_reason: FinishReason;
  }>;
  usage?: Usage | null;
}

export interface Target {
  provider: 'openai' | 'anthropic';
  model: string;
  timeoutMs: number;
}

export interface RouteAlias {
  chain: Target[];
  cacheTtlSeconds?: number;
}

export interface RouteConfig {
  aliases: Record<string, RouteAlias>;
}

export interface ApiKeyContext {
  id: string;
  name: string;
  rateLimitRpm: number;
  rateLimitBurst: number;
  maxOutputTokensCap: number;
  cacheEnabled: boolean;
}

export interface CallContext {
  signal: AbortSignal;
  requestId: string;
}
