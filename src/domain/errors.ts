export type GatewayErrorCode =
  | 'invalid_request'
  | 'unsupported_parameter'
  | 'invalid_api_key'
  | 'model_not_found'
  | 'request_too_large'
  | 'rate_limit_exceeded'
  | 'internal_error'
  | 'upstream_error'
  | 'all_providers_unavailable'
  | 'upstream_timeout'
  | 'auth_unavailable';

export type GatewayErrorType =
  | 'invalid_request_error'
  | 'authentication_error'
  | 'rate_limit_error'
  | 'api_error';

const CODE_MAP: Record<GatewayErrorCode, { status: number; type: GatewayErrorType }> = {
  invalid_request: { status: 400, type: 'invalid_request_error' },
  unsupported_parameter: { status: 400, type: 'invalid_request_error' },
  invalid_api_key: { status: 401, type: 'authentication_error' },
  model_not_found: { status: 404, type: 'invalid_request_error' },
  request_too_large: { status: 413, type: 'invalid_request_error' },
  rate_limit_exceeded: { status: 429, type: 'rate_limit_error' },
  internal_error: { status: 500, type: 'api_error' },
  upstream_error: { status: 502, type: 'api_error' },
  all_providers_unavailable: { status: 503, type: 'api_error' },
  upstream_timeout: { status: 504, type: 'api_error' },
  auth_unavailable: { status: 503, type: 'api_error' },
};

export class GatewayError extends Error {
  public readonly code: GatewayErrorCode;
  public readonly httpStatus: number;
  public readonly errorType: GatewayErrorType;
  public readonly param?: string;
  public readonly retryAfterSeconds?: number;

  constructor(
    code: GatewayErrorCode,
    message: string,
    options?: { param?: string; retryAfterSeconds?: number }
  ) {
    super(message);
    this.name = 'GatewayError';
    this.code = code;
    const mapped = CODE_MAP[code];
    this.httpStatus = mapped.status;
    this.errorType = mapped.type;
    this.param = options?.param;
    this.retryAfterSeconds = options?.retryAfterSeconds;
  }
}

export type UpstreamErrorClass =
  | 'timeout'
  | 'http_5xx'
  | 'http_429'
  | 'http_4xx'
  | 'network_error';

export class UpstreamError extends Error {
  constructor(
    public readonly errorClass: UpstreamErrorClass,
    public readonly retryable: boolean,
    public readonly fallbackable: boolean,
    public readonly httpStatus?: number,
    public readonly retryAfterMs?: number,
  ) {
    super(`upstream ${errorClass}`);
    this.name = 'UpstreamError';
  }
}
