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

  /**
   * Qwen3 ignores the API-level `think: false` and reasons in plain prose regardless,
   * burning the budget before it reaches the response fields. Measured: with
   * `think:false` alone it produced no VOTE field at all; with `/no_think` appended
   * the field appears.
   *
   * `/no_think` is Qwen3's own control token for reasoning mode — the same request as
   * `think: false`, expressed the way this family actually listens to. It carries no
   * task guidance, so it does not breach the rule that game instructions stay
   * identical across models; tuning a prompt's *content* per model would make the
   * leaderboard a measure of my prompt engineering, and this is not that.
   */
  applyReasoningControl(messages) {
    if (!/^qwen3/i.test(this.model)) return messages;
    const out = messages.map((m) => ({ ...m }));
    const lastUser = [...out].reverse().find((m) => m.role === 'user');
    if (lastUser && !lastUser.content.includes('/no_think')) {
      lastUser.content += '\n/no_think';
    }
    return out;
  }

  /**
   * The value to send as Ollama's `think` parameter.
   *
   * `think: false` does NOT disable reasoning for gpt-oss — it appears to leave the
   * default effort in place, and the tokens go to a harmony channel that the JSON
   * schema does not constrain, so the model can exhaust any budget while its emitted
   * JSON stays valid-but-absent. Measured on the largest real statement prompt in the
   * logs:
   *
   *   think:false  budget 1200  -> done "length", 1200 tok, no JSON, 22.8s
   *   think:false  budget 2500  -> done "length", 2500 tok, no JSON, 48.4s
   *   think:"low"  budget 1200  -> done "stop",    142 tok, valid JSON,  6.3s
   *   think:"low"  budget 2000  -> done "stop",    103 tok, valid JSON,  3.6s
   *
   * So the fix is an effort level, not a bigger cap — and it is 4-7x faster as well.
   * This is the last of the three reasoning-model defects: the schema stopped reasoning
   * from crowding out the decision in the visible channel, and this stops it running
   * away in the hidden one.
   */
  reasoningMode() {
    if (/^gpt-oss/i.test(this.model)) return 'low';
    return false;
  }

  async callModel(messages, { maxTokens, schema } = {}) {
    const maxAttempts = 2;
    let last = { text: '', thinking: '', tokensUsed: 0 };
    const payloadMessages = this.applyReasoningControl(messages);

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const response = await axios.post(
        `${this.baseUrl}/api/chat`,
        {
          model: this.model,
          messages: payloadMessages,
          stream: false,
          think: this.reasoningMode(),
          keep_alive: '30m',
          // Ollama constrains decoding to this JSON schema. This is the fix for
          // reasoning models: the grammar cannot emit a document missing a required
          // property, so reasoning cannot crowd out the decision.
          ...(schema ? { format: schema } : {}),
          options: {
            temperature: 0.8,
            num_predict: maxTokens || 1024,
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
        // Ollama reports why generation stopped. "length" means the budget ran out
        // mid-sentence, which is a different result from a short answer and is
        // counted separately rather than scored as poor writing.
        truncated: data.done_reason === 'length',
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
