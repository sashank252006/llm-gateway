import express from 'express';

const app = express();
app.use(express.json());

const port = Number(process.env.FAKE_PROVIDER_PORT ?? 3001);
interface FakeBehavior { latencyMs: number; statusCode: number; dieAfterChunks: number; hang: boolean; }
const defaultBehavior = (): FakeBehavior => ({
  latencyMs: Number(process.env.FAKE_PROVIDER_LATENCY_MS ?? 0),
  statusCode: Number(process.env.FAKE_PROVIDER_STATUS ?? 200),
  dieAfterChunks: Number(process.env.FAKE_PROVIDER_DIE_AFTER_CHUNKS ?? 0),
  hang: process.env.FAKE_PROVIDER_HANG === 'true',
});
const behaviors: Record<'openai' | 'anthropic', FakeBehavior> = { openai: defaultBehavior(), anthropic: defaultBehavior() };

async function delay(behavior: FakeBehavior): Promise<void> {
  if (behavior.latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, behavior.latencyMs));
}

function fail(res: express.Response, behavior: FakeBehavior): void {
  res.status(behavior.statusCode).json({ error: { message: 'fake provider failure', type: 'server_error' } });
}

function openaiStream(res: express.Response, model: string, behavior: FakeBehavior): void {
  res.setHeader('content-type', 'text/event-stream');
  res.setHeader('cache-control', 'no-cache');
  const chunks = [
    { id: 'fake-openai', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] },
    { id: 'fake-openai', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: { content: 'fake response' }, finish_reason: null }] },
    { id: 'fake-openai', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 } },
  ];
  for (const [index, chunk] of chunks.entries()) {
    if (behavior.dieAfterChunks > 0 && index >= behavior.dieAfterChunks) {
      res.destroy();
      return;
    }
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  }
  res.end('data: [DONE]\n\n');
}

app.post('/v1/chat/completions', async (req, res) => {
  const behavior = behaviors.openai;
  if (behavior.hang) return;
  await delay(behavior);
  if (behavior.statusCode >= 400) {
    fail(res, behavior);
    return;
  }
  const model = req.body.model ?? 'fake-openai';
  if (req.body.stream) return openaiStream(res, model, behavior);
  res.json({
    id: 'fake-openai', object: 'chat.completion', created: Math.floor(Date.now() / 1000), model,
    choices: [{ index: 0, message: { role: 'assistant', content: 'fake response' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 },
  });
});

app.post('/v1/messages', async (req, res) => {
  const behavior = behaviors.anthropic;
  if (behavior.hang) return;
  await delay(behavior);
  if (behavior.statusCode >= 400) {
    fail(res, behavior);
    return;
  }
  const model = req.body.model ?? 'fake-anthropic';
  if (req.body.stream) {
    res.setHeader('content-type', 'text/event-stream');
    const events = [
      { type: 'message_start', message: { id: 'fake-anthropic', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 2, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'fake response' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
      { type: 'message_stop' },
    ];
    for (const [index, event] of events.entries()) {
      if (behavior.dieAfterChunks > 0 && index >= behavior.dieAfterChunks) {
        res.destroy();
        return;
      }
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    }
    return res.end();
  }
  res.json({ id: 'fake-anthropic', type: 'message', role: 'assistant', model, content: [{ type: 'text', text: 'fake response' }], stop_reason: 'end_turn', usage: { input_tokens: 2, output_tokens: 2 } });
});

app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));
app.post('/__control/:provider', (req, res) => {
  const provider = req.params.provider;
  if (provider !== 'openai' && provider !== 'anthropic') return res.status(404).json({ error: 'unknown provider' });
  const next = req.body as Partial<FakeBehavior>;
  const current = behaviors[provider];
  behaviors[provider] = {
    latencyMs: Number.isFinite(next.latencyMs) ? Math.max(0, Number(next.latencyMs)) : current.latencyMs,
    statusCode: Number.isInteger(next.statusCode) ? Number(next.statusCode) : current.statusCode,
    dieAfterChunks: Number.isInteger(next.dieAfterChunks) ? Math.max(0, Number(next.dieAfterChunks)) : current.dieAfterChunks,
    hang: typeof next.hang === 'boolean' ? next.hang : current.hang,
  };
  res.json(behaviors[provider]);
});
app.listen(port, () => console.log(`Fake provider listening on ${port}`));
