const Anthropic = require('@anthropic-ai/sdk');
const { BaseAgent } = require('../base-agent.js');
const { CONFIG } = require('../../config.js');

/**
 * Anthropic Claude provider. Ported from the CTF project, including the
 * consecutive-same-role merge — the Messages API requires alternating turns and
 * will reject a payload that repeats a role.
 */
class ClaudeAgent extends BaseAgent {
  constructor(opts) {
    super({ ...opts, provider: 'claude' });
    this.client = new Anthropic({ apiKey: CONFIG.api.claude.apiKey });
  }

  async callModel(messages, { maxTokens, schema } = {}) {
    const system = messages.find((m) => m.role === 'system')?.content || '';

    const merged = [];
    for (const msg of messages.filter((m) => m.role !== 'system')) {
      const last = merged[merged.length - 1];
      if (last && last.role === msg.role) last.content += '\n\n' + msg.content;
      else merged.push({ role: msg.role, content: msg.content });
    }
    if (merged.length && merged[0].role !== 'user') {
      merged.unshift({ role: 'user', content: 'Begin.' });
    }

    /**
     * No `temperature`. Sampling parameters are REJECTED WITH A 400 on every current
     * Claude model (Opus 5, Sonnet 5, Opus 4.8/4.7) — the ported CTF adapter sent
     * temperature: 0.8, which would have failed the whole roster on the first call
     * rather than degrading quietly.
     *
     * Thinking is left at its default (adaptive, on by default on Opus 5). Disabling it
     * would be cheaper, but this benchmark exists to measure reasoning, so running the
     * model outside its normal operating mode would understate the very thing being
     * tested. `effort: 'low'` controls cost instead — and it keeps the frontier seats
     * roughly comparable to gpt-oss:20b, which also runs at low reasoning effort.
     *
     * max_tokens is a cap on thinking PLUS response text, so it is set well above the
     * few hundred tokens the JSON answer needs. Truncation is counted either way.
     */
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: Math.max(maxTokens || 1024, 3000),
      system,
      messages: merged,
      output_config: {
        effort: 'low',
        ...(schema
          ? { format: { type: 'json_schema', schema: { ...schema, additionalProperties: false } } }
          : {}),
      },
    });

    let text = '';
    let thinking = '';
    for (const block of response.content) {
      if (block.type === 'thinking') thinking += block.thinking;
      else if (block.type === 'text') text += block.text;
    }

    return {
      text,
      thinking,
      tokensUsed: (response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0),
      truncated: response.stop_reason === 'max_tokens',
      // A safety classifier declining is a content outcome, not an error, and must not
      // be scored as the model failing to play.
      refused: response.stop_reason === 'refusal',
    };
  }
}

module.exports = { ClaudeAgent };
