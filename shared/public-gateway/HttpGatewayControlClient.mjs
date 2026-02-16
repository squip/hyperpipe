import { resolveHttpFallbackRequest } from './ControlPlaneMethods.mjs';

const DEFAULT_TIMEOUT_MS = 10_000;

function normalizeBaseUrl(baseUrl) {
  if (typeof baseUrl !== 'string' || !baseUrl.trim()) return null;
  return baseUrl.replace(/\/$/, '');
}

class HttpGatewayControlClient {
  constructor({ baseUrl, fetchImpl = globalThis.fetch, logger = console } = {}) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.fetch = fetchImpl;
    this.logger = logger;
    if (!this.baseUrl) {
      throw new Error('HttpGatewayControlClient requires baseUrl');
    }
    if (typeof this.fetch !== 'function') {
      throw new Error('HttpGatewayControlClient requires fetch implementation');
    }
  }

  async request(methodName, payload = {}, options = {}) {
    const requestInfo = resolveHttpFallbackRequest(methodName, payload);
    const url = `${this.baseUrl}${requestInfo.path}`;
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timeoutMs = Number.isFinite(Number(options.timeoutMs)) && Number(options.timeoutMs) > 0
      ? Math.round(Number(options.timeoutMs))
      : DEFAULT_TIMEOUT_MS;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

    try {
      const response = await this.fetch(url, {
        method: requestInfo.method,
        headers: requestInfo.body == null
          ? { accept: 'application/json' }
          : {
            accept: 'application/json',
            'content-type': 'application/json'
          },
        body: requestInfo.body == null ? undefined : JSON.stringify(requestInfo.body),
        signal: controller?.signal
      });

      const text = await response.text().catch(() => '');
      let parsed = null;
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch (_) {
          parsed = { raw: text };
        }
      }

      if (!response.ok) {
        const error = new Error(parsed?.error || `HTTP ${response.status}`);
        error.statusCode = response.status;
        error.payload = parsed;
        throw error;
      }

      return parsed;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

export default HttpGatewayControlClient;
