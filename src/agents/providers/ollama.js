const axios = require('axios');
const { BaseAgent } = require('../base-agent.js');
const { CONFIG } = require('../../config.js');

/**
 * Local Ollama provider — the small-model arm. Ported from the CTF project along
 * with the operational details that took a while to get right there: `think: false`
 * so reasoning arrives in our own THINKING field rather than a provider-specific
 * channel, a long `keep_alive` so the model is not unloaded between turns, and a
 * generous timeout because a 2B model on CPU is slow but not broken.
 *
 * One addition: a retry on empty output. Small models return a blank completion
 * often enough that not retrying would score them as silent when they are merely
 * flaky, and the two are different findings.
 */
class OllamaAgent extends BaseAgent {
  constructor(opts) {
    super({ ...opts, provider: 'ollama' });
    this.baseUrl = CONFIG.api.ollama.baseUrl;
  }

  async callModel(messages) {
    const maxAttempts = 2;
    let last = { text: '', thinking: '', tokensUsed: 0 };

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const response = await axios.post(
        `${this.baseUrl}/api/chat`,
        {
          model: this.model,
          messages,
          stream: false,
          think: false,
          keep_alive: '30m',
          options: {
            temperature: 0.8,
            num_predict: 1024,
            // Small models need the window to cover the rendered ledger; too small
            // and the identity block silently falls out of context, which looks
            // exactly like the model ignoring its role.
            num_ctx: 8192,
          },
        },
        { headers: { 'Content-Type': 'application/json' }, timeout: 300000 }
      );

      const data = response.data;
      last = {
        text: data.message?.content || '',
        thinking: '',
        tokensUsed: (data.prompt_eval_count || 0) + (data.eval_count || 0),
      };
      if (last.text.trim()) return last;
    }

    return last;
  }
}

/** Pull a model if Ollama does not already have it. */
async function pullModel(modelName) {
  const baseUrl = CONFIG.api.ollama.baseUrl;
  try {
    const tags = await axios.get(`${baseUrl}/api/tags`, { timeout: 5000 });
    const models = tags.data.models || [];
    if (models.some((m) => m.name === modelName || m.name.startsWith(modelName + ':'))) {
      return;
    }
  } catch {
    // tags unreachable — attempt the pull anyway and let it report the real error
  }

  console.log(`[Ollama] Pulling "${modelName}" (first run may take a while)...`);
  try {
    await axios.post(`${baseUrl}/api/pull`, { name: modelName, stream: false }, { timeout: 3600000 });
    console.log(`[Ollama] "${modelName}" ready.`);
  } catch (err) {
    const detail = err.response?.data?.error || err.message;
    throw new Error(`Failed to pull Ollama model "${modelName}": ${detail}`);
  }
}

async function checkHealth() {
  try {
    const resp = await axios.get(`${CONFIG.api.ollama.baseUrl}/api/tags`, { timeout: 5000 });
    return resp.status === 200;
  } catch {
    return false;
  }
}

/** Load a model into memory before the game so turn one is not a cold start. */
async function warmModel(modelName) {
  try {
    await axios.post(
      `${CONFIG.api.ollama.baseUrl}/api/chat`,
      {
        model: modelName,
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
        keep_alive: '30m',
        options: { num_predict: 1 },
      },
      { timeout: 300000 }
    );
    return true;
  } catch {
    return false;
  }
}

module.exports = { OllamaAgent, pullModel, checkHealth, warmModel };
