const axios = require('axios');
const { BaseAgent } = require('../base-agent.js');
const { CONFIG } = require('../../config.js');

/**
 * xAI Grok and Perplexity. Both expose OpenAI-shaped chat completions, and both were
 * separate near-identical files in the CTF project. Merged here — the only
 * differences were the base URL and the key, which are now parameters.
 */
class HttpOpenAIShapedAgent extends BaseAgent {
  constructor(opts, { baseUrl, apiKey, provider }) {
    super({ ...opts, provider });
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
  }

  async callModel(messages) {
    const response = await axios.post(
      `${this.baseUrl}/chat/completions`,
      { model: this.model, messages, max_tokens: 1024, temperature: 0.8 },
      {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 120000,
      }
    );

    const choice = response.data.choices[0];
    return {
      text: choice.message.content || '',
      thinking: '',
      tokensUsed: response.data.usage?.total_tokens || null,
    };
  }
}

class GrokAgent extends HttpOpenAIShapedAgent {
  constructor(opts) {
    super(opts, {
      baseUrl: CONFIG.api.grok.baseUrl,
      apiKey: CONFIG.api.grok.apiKey,
      provider: 'grok',
    });
  }
}

class PerplexityAgent extends HttpOpenAIShapedAgent {
  constructor(opts) {
    super(opts, {
      baseUrl: CONFIG.api.perplexity.baseUrl,
      apiKey: CONFIG.api.perplexity.apiKey,
      provider: 'perplexity',
    });
  }
}

module.exports = { HttpOpenAIShapedAgent, GrokAgent, PerplexityAgent };
