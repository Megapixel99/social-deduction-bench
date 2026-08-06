const { Ollama } = require('ollama');
const { BaseAgent } = require('../base-agent.js');
const { CONFIG } = require('../../config.js');

/**
 * Ollama Cloud — hosted inference for large open models, no local GPU. Ported from
 * the CTF project including its rate-limit handling, which was written against the
 * real behaviour of the service: 429s arrive in bursts and clear after a wait, so
 * retrying beats failing, and exhausting the retries needs to be distinguishable
 * from an ordinary error so the caller can pause the batch rather than record a
 * string of broken games.
 */
/**
 * Minimum gap between Ollama Cloud requests, shared across every seat.
 *
 * Calls are already strictly sequential, and for a while that was enough — an early batch
 * saw zero 429s, so no pacing was added. That stopped being true once three distinct cloud
 * models were seated: at 2-5 s per call the loop was issuing 12-30 requests a minute and
 * the free tier began refusing them. **"No rate limiting observed" is not the same as "no
 * rate limit", and the difference only shows up when throughput rises.**
 *
 * Module-level because the limit is per account, not per seat.
 */
const MIN_CALL_GAP_MS = 3000;
let lastCallAt = 0;

async function paceCloudCalls() {
  const wait = MIN_CALL_GAP_MS - (Date.now() - lastCallAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallAt = Date.now();
}

class OllamaCloudAgent extends BaseAgent {
  constructor(opts) {
    super({ ...opts, provider: 'ollama-cloud' });
    this.client = new Ollama({
      host: 'https://ollama.com',
      headers: { Authorization: 'Bearer ' + CONFIG.api.ollamaCloud.apiKey },
    });
  }

  async callModel(messages, { maxTokens } = {}) {
    const maxRetries = 3;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const response = await this.client.chat({
          model: this.model,
          messages,
          stream: false,
          options: { temperature: 0.8, num_predict: maxTokens || 1024 },
        });

        return {
          text: response.message?.content || '',
          thinking: '',
          tokensUsed: (response.prompt_eval_count || 0) + (response.eval_count || 0),
        };
      } catch (err) {
        const status = err.status_code || err.status || err.response?.status;
        const msg = err.message || '';
        const isRateLimit =
          status === 429 || msg.includes('rate limit') || msg.includes('capacity') || msg.includes('queue is full');

        if (isRateLimit) this.stats.rateLimited++;
        if (isRateLimit && attempt < maxRetries) {
          // Exponential: 30s, 60s, 120s, 240s. A flat 60s x3 was not enough headroom
          // once three models shared one account's quota.
          const backoff = 30000 * 2 ** (attempt - 1);
          console.log(
            `  [${this.playerName}] rate limited — waiting ${backoff / 1000}s (${attempt}/${maxRetries})`
          );
          await new Promise((r) => setTimeout(r, backoff));
          continue;
        }
        if (isRateLimit) {
          const e = new Error('RATE_LIMIT_EXHAUSTED');
          e.isRateLimitExhausted = true;
          throw e;
        }
        throw err;
      }
    }
  }
}

module.exports = { OllamaCloudAgent };
