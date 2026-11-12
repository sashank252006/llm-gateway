import express from 'express';

const app = express();
app.use(express.json());

const port = Number(process.env.FAKE_PROVIDER_PORT ?? 3001);
const latencyMs = Number(process.env.FAKE_PROVIDER_LATENCY_MS ?? 0);
const statusCode = Number(process.env.FAKE_PROVIDER_STATUS ?? 200);
const dieAfterChunks = Number(process.env.FAKE_PROVIDER_DIE_AFTER_CHUNKS ?? 0);
const hang = process.env.FAKE_PROVIDER_HANG === 'true';

async function delay(): Promise<void> {
  if (latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, latencyMs));
}

function fail(res: express.Response): void {
  res.status(statusCode).json({ error: { message: 'fake provider failure', type: 'server_error' } });
}

function openaiStream(res: express.Response, model: string): void {
  res.setHeader('content-type', 'text/event-stream');
  res.setHeader('cache-control', 'no-cache');
  const chunks = [
    { id: 'fake-openai', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] },
    { id: 'fake-openai', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: { content: 'fake response' }, finish_reason: null }] },
    { id: 'fake-openai', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 } },
  ];
  for (const [index, chunk] of chunks.entries()) {
    if (dieAfterChunks > 0 && index >= dieAfterChunks) {
      res.destroy();
      return;
    }
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  }
  res.end('data: [DONE]\n\n');
}

app.post('/v1/chat/completions', async (req, res) => {
  if (hang) return;
  await delay();
  if (statusCode >= 400) {
    fail(res);
    return;
  }
  const model = req.body.model ?? 'fake-openai';
  if (req.body.stream) return openaiStream(res, model);
  res.json({
    id: 'fake-openai', object: 'chat.completion', created: Math.floor(Date.now() / 1000), model,
    choices: [{ index: 0, message: { role: 'assistant', content: 'fake response' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 },
  });
});

app.post('/v1/messages', async (req, res) => {
  if (hang) return;
  await delay();
  if (statusCode >= 400) {
    fail(res);
    return;
  }
  const model = req.body.model ?? 'fake-anthropic';
  if (req.body.stream) {
    res.setHeader('content-type', 'text/event-stream');
    const events = [
      { type: 'message_start', message: { usage: { input_tokens: 2 } } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'fake response' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
    ];
    for (const [index, event] of events.entries()) {
      if (dieAfterChunks > 0 && index >= dieAfterChunks) return res.destroy();
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    }
    return res.end();
  }
  res.json({ id: 'fake-anthropic', type: 'message', role: 'assistant', model, content: [{ type: 'text', text: 'fake response' }], stop_reason: 'end_turn', usage: { input_tokens: 2, output_tokens: 2 } });
});

app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));
app.listen(port, () => console.log(`Fake provider listening on ${port}`));
