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

        if (isRateLimit && attempt < maxRetries) {
          console.log(`  [${this.playerName}] rate limited — waiting 60s (${attempt}/${maxRetries})`);
          await new Promise((r) => setTimeout(r, 60000));
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
