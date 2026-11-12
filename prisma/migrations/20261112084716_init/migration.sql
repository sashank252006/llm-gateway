-- CreateTable
CREATE TABLE "api_keys" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "key_prefix" TEXT NOT NULL,
    "key_hash" TEXT NOT NULL,
    "rate_limit_rpm" INTEGER NOT NULL DEFAULT 60,
    "rate_limit_burst" INTEGER NOT NULL DEFAULT 20,
    "max_output_tokens_cap" INTEGER NOT NULL DEFAULT 4096,
    "cache_enabled" BOOLEAN NOT NULL DEFAULT true,
    "daily_cost_cap_usd" DECIMAL(12,4),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ,
    "last_used_at" TIMESTAMPTZ,

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_events" (
    "id" BIGSERIAL NOT NULL,
    "request_id" TEXT NOT NULL,
    "api_key_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL,
    "alias" TEXT NOT NULL,
    "provider" TEXT,
    "model" TEXT,
    "stream" BOOLEAN NOT NULL,
    "cache_hit" BOOLEAN NOT NULL,
    "fallback_used" BOOLEAN NOT NULL,
    "attempts" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "http_status" INTEGER NOT NULL,
    "error_code" TEXT,
    "input_tokens" INTEGER,
    "output_tokens" INTEGER,
    "cost_usd" DECIMAL(12,8),
    "saved_cost_usd" DECIMAL(12,8) NOT NULL DEFAULT 0,
    "latency_ms" INTEGER NOT NULL,
    "upstream_latency_ms" INTEGER,
    "ttfb_ms" INTEGER,

    CONSTRAINT "usage_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_attempts" (
    "id" BIGSERIAL NOT NULL,
    "request_id" TEXT NOT NULL,
    "attempt_no" INTEGER NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "http_status" INTEGER,
    "latency_ms" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "provider_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_key_hash_key" ON "api_keys"("key_hash");

-- CreateIndex
CREATE UNIQUE INDEX "usage_events_request_id_key" ON "usage_events"("request_id");

-- CreateIndex
CREATE INDEX "usage_events_api_key_id_created_at_idx" ON "usage_events"("api_key_id", "created_at");

-- CreateIndex
CREATE INDEX "usage_events_created_at_idx" ON "usage_events"("created_at");

-- CreateIndex
CREATE INDEX "provider_attempts_provider_created_at_idx" ON "provider_attempts"("provider", "created_at");

-- CreateIndex
CREATE INDEX "provider_attempts_request_id_idx" ON "provider_attempts"("request_id");

-- AddForeignKey
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_api_key_id_fkey" FOREIGN KEY ("api_key_id") REFERENCES "api_keys"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
