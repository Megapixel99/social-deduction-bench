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

  async callModel(messages) {
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

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 1024,
      temperature: 0.8,
      system,
      messages: merged,
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
    };
  }
}

module.exports = { ClaudeAgent };
