# LLM Gateway

A production-grade LLM API gateway — TypeScript, Express, PostgreSQL, Redis.

> One Express service that authenticates callers, applies rate limits, answers from cache, and calls providers through a full resilience layer (retries, circuit breaker, fallback chain).

---

## Architecture

```
Client → Nginx (TLS, proxy_buffering off) → Gateway (Node.js/Express)
                                                  │
                              ┌───────────────────┼──────────────────────┐
                              ▼                   ▼                      ▼
                           Redis              PostgreSQL           OpenAI / Anthropic
                  (cache + rate-limit)   (api_keys, usage)         (via adapters)
```

**Request pipeline (in order):**
1. Request ID + child logger
2. Authenticate (Bearer key → SHA-256 hash → Postgres lookup with LRU cache)
3. Rate limit (atomic token bucket Lua script in Redis; in-memory fallback)
4. Parse + Zod validate (1 MB body limit, max_tokens cap)
5. Cache lookup (Redis, temperature=0 only, per-key scope)
6. Route (alias → ordered provider chain from `config/routing.yaml`)
7. Execute with resilience (timeout → retry+jitter → circuit breaker → fallback)
8. Respond (JSON or SSE stream) + set `x-gateway-*` headers
9. Record usage async (in-memory queue → batch flush to Postgres)

**Five core design rules:**
- Hot path never waits on a Postgres write
- Redis is an accelerator, not a dependency (fails open)
- Streaming has a commit point — before first byte = retryable, after = send error SSE
- One canonical format: OpenAI chat completions (Anthropic adapter translates)
- Measure from day one: cache hit rate, failover time, gateway overhead

---

## Quick Start

```bash
# 1. Clone and install
npm install

# 2. Configure
cp .env.example .env
# Edit .env: set OPENAI_API_KEY, ANTHROPIC_API_KEY, ADMIN_TOKEN (min 32 chars)

# 3. Start infrastructure
cd deploy && docker compose up -d

# 4. Run database migrations
DATABASE_URL=postgresql://gateway:gateway@localhost:5432/gateway npx prisma migrate dev --name init

# 5. Create an API key
npm run key:create -- --name=my-app

# 6. Call the gateway
curl http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer lgw_live_..." \
  -H "Content-Type: application/json" \
  -d '{
    "model": "fast",
    "messages": [{"role": "user", "content": "Hello!"}],
    "temperature": 0
  }'
```

---

## API Endpoints

### Chat Completions
`POST /v1/chat/completions` — Auth: API key

Supported fields: `model` (alias), `messages`, `temperature` (0–1), `top_p`, `max_tokens`, `stop`, `stream`, `stream_options`

**Response headers:**
| Header | Values |
|--------|--------|
| `x-request-id` | `req_...` |
| `x-gateway-alias` | alias used |
| `x-gateway-provider` | provider that answered |
| `x-gateway-cache` | `HIT`, `MISS`, or `SKIP` |
| `x-gateway-fallback` | `true` or `false` |
| `x-gateway-attempts` | count of upstream attempts |
| `x-ratelimit-limit` | RPM limit |
| `x-ratelimit-remaining` | tokens left |

### Other endpoints
| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `GET` | `/v1/models` | API key | List model aliases |
| `GET` | `/healthz` | none | Liveness |
| `GET` | `/readyz` | none | Readiness (checks DB) |
| `GET` | `/metrics` | none | Prometheus metrics |
| `POST` | `/admin/v1/keys` | admin token | Create key (key shown once) |
| `GET` | `/admin/v1/keys` | admin token | List keys |
| `PATCH` | `/admin/v1/keys/:id` | admin token | Update limits |
| `POST` | `/admin/v1/keys/:id/revoke` | admin token | Revoke key |
| `GET` | `/admin/v1/usage` | admin token | Usage by key+day |
| `GET` | `/admin/v1/providers/health` | admin token | Error rate + circuit state |

---

## Configuration

### Environment variables (`.env`)
| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | — | Postgres connection URL |
| `REDIS_URL` | `redis://localhost:6379` | Redis URL |
| `OPENAI_API_KEY` | — | OpenAI API key |
| `ANTHROPIC_API_KEY` | — | Anthropic API key |
| `ADMIN_TOKEN` | — | Admin bearer token (≥16 chars) |
| `LOG_LEVEL` | `info` | Pino log level |
| `LOG_PROMPTS` | `false` | Log prompt content (opt-in) |
| `BREAKER_FAILURE_THRESHOLD` | `5` | Failures before circuit opens |
| `BREAKER_COOLDOWN_MS` | `30000` | Circuit open duration |
| `RETRY_MAX_ATTEMPTS` | `2` | Max retries per target |
| `CACHE_TTL_SECONDS` | `86400` | Cache entry TTL |
| `REDIS_COMMAND_TIMEOUT_MS` | `50` | Redis timeout (fail fast) |

### Routing (`config/routing.yaml`)
```yaml
aliases:
  fast:
    chain:
      - provider: openai
        model: "gpt-4o-mini"
        timeoutMs: 15000
      - provider: anthropic       # fallback
        model: "claude-haiku-20240307"
        timeoutMs: 15000
  smart:
    chain:
      - provider: anthropic
        model: "claude-3-5-sonnet-20241022"
        timeoutMs: 60000
      - provider: openai
        model: "gpt-4o"
        timeoutMs: 60000
```

### Prices (`config/prices.yaml`)
```yaml
models:
  "gpt-4o-mini":
    input: 0.15   # USD per 1M tokens
    output: 0.60
```

---

## Project Structure

```
src/
├── server.ts              # Boot: connect, listen, graceful shutdown
├── app.ts                 # Express app factory (testable without listen)
├── config/                # Zod-validated env, routing.yaml, prices.yaml
├── domain/                # Canonical types, Zod schemas, GatewayError classes
├── http/
│   ├── middleware/        # requestId, auth, validate, errorHandler
│   └── routes/            # chatCompletions, models, health, metrics, admin
├── providers/             # ProviderAdapter interface, OpenAI & Anthropic adapters
├── resilience/            # executor (retry+breaker+fallback), breaker state machine
├── routing/               # alias → target chain
├── cache/                 # normalize, isCacheable, Redis get/set, stream replay
├── ratelimit/             # Lua token bucket (Redis) + in-memory fallback
├── keys/                  # generate, hash (SHA-256), LRU lookup, revoke
├── usage/                 # async queue → batch Prisma flush, cost math
└── observability/         # Pino logger, prom-client metrics

prisma/schema.prisma       # api_keys, usage_events, provider_attempts
config/routing.yaml
config/prices.yaml
deploy/
├── docker-compose.yml     # postgres, redis, gateway, nginx, prometheus
├── nginx.conf             # proxy_buffering off for SSE
└── prometheus.yml
test/
├── unit/                  # errors, cache policy, rate limit, retry
└── fakes/                 # fake provider server (controllable latency/errors)
```

---

## Development

```bash
npm run dev        # tsx watch — hot reload
npm run typecheck  # tsc --noEmit
npm test           # vitest unit tests
npm run build      # compile to dist/
```

---

## Deployment (Docker Compose)

```bash
cd deploy
docker compose up -d
# Gateway available at http://localhost:3000
# Prometheus at http://localhost:9090
# Nginx proxy at http://localhost:80
```

The gateway depends on Postgres and Redis with `condition: service_healthy`.

**Nginx essentials for SSE:** `proxy_buffering off` on `/v1/` — without this, streaming chunks arrive in bursts.

---

## Key Design Decisions

| Decision | Why |
|----------|-----|
| SHA-256 for key hashing (not bcrypt) | Keys are 32 random bytes — high entropy. Brute-forcing SHA-256 of 256-bit randomness is infeasible. Bcrypt is for low-entropy passwords. |
| Token bucket (not fixed window) | Allows burst, refills smoothly, stores only 2 numbers per key. Atomic via Lua script — one round trip, no lost-update race. |
| Circuit breaker in memory | Exact for one instance, no Redis round trip per request (keeps overhead low), works when Redis is down. |
| Async usage logging | Synchronous Postgres write on every request would couple latency and availability. Queue + batch = hot path never blocks on the DB. |
| Cache at temperature=0 only | Determinism first. Caching non-zero temperature silently changes behaviour. |
| Streaming commit point | Wait for first upstream byte before writing response headers — keeps fallback possible for all connection and early-5xx errors. |
| Routing config in a file | Reviewable in git, Zod-validated at boot, no admin CRUD surface to build and secure. |

