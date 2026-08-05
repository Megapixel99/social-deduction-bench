const OpenAI = require('openai');
const { BaseAgent } = require('../base-agent.js');
const { CONFIG } = require('../../config.js');

/**
 * OpenAI provider. Ported from the CTF project.
 *
 * Adapters take their model from constructor options rather than looking themselves
 * up in a global player list — the same model can now hold two seats, so a global
 * lookup by id is ambiguous here in a way it was not there.
 */
class OpenAIAgent extends BaseAgent {
  constructor(opts) {
    super({ ...opts, provider: 'openai' });
    this.client = new OpenAI({ apiKey: CONFIG.api.openai.apiKey });
  }

  async callModel(messages, { maxTokens } = {}) {
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages,
      max_tokens: maxTokens || 1024,
      temperature: 0.8,
    });

    const choice = response.choices[0];
    return {
      text: choice.message.content || '',
      thinking: '',
      tokensUsed: response.usage?.total_tokens || null,
    };
  }
}

/**
 * Any server speaking the OpenAI chat-completions API at an arbitrary base URL —
 * used for Swiftlet's local server (`swiftlet-server --port 8080`) and for anything
 * else OpenAI-shaped.
 *
 * This is why Swiftlet costs nothing to support: it is a config entry and a base
 * URL, not an integration. Local inference gets no API key, so a placeholder is
 * sent to satisfy the client library.
 */
class OpenAICompatibleAgent extends BaseAgent {
  constructor(opts) {
    super({ ...opts, provider: 'openai-compatible' });
    this.client = new OpenAI({
      apiKey: opts.apiKey || 'not-needed',
      baseURL: opts.baseUrl,
    });
  }

  async callModel(messages) {
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages,
      max_tokens: 1024,
      temperature: 0.8,
    });

    const choice = response.choices[0];
    return {
      text: choice.message?.content || '',
      thinking: '',
      tokensUsed: response.usage?.total_tokens || null,
    };
  }
}

module.exports = { OpenAIAgent, OpenAICompatibleAgent };
