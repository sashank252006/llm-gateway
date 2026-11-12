import { describe, expect, it } from 'vitest';
import { ChatRequestSchema } from '../../../src/domain/schemas.js';

const base = { model: 'fast', messages: [{ role: 'user', content: 'hello' }] };

describe('ChatRequestSchema conversation rules', () => {
  it('accepts leading system messages followed by alternating conversation roles', () => {
    expect(ChatRequestSchema.safeParse({ ...base, messages: [
      { role: 'system', content: 'be concise' },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: 'continue' },
    ] }).success).toBe(true);
  });

  it('rejects a system message placed after the conversation starts', () => {
    const result = ChatRequestSchema.safeParse({ ...base, messages: [
      { role: 'user', content: 'hello' }, { role: 'system', content: 'late' },
    ] });
    expect(result.success).toBe(false);
  });

  it('rejects repeated conversation roles', () => {
    const result = ChatRequestSchema.safeParse({ ...base, messages: [
      { role: 'user', content: 'one' }, { role: 'user', content: 'two' },
    ] });
    expect(result.success).toBe(false);
  });
});
