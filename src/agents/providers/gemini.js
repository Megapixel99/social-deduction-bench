const { GoogleGenerativeAI } = require('@google/generative-ai');
const { BaseAgent } = require('../base-agent.js');
const { CONFIG } = require('../../config.js');

/**
 * Google Gemini provider. Ported from the CTF project.
 *
 * Simpler here than there: a Mafia request is always a single system prompt plus one
 * user message, so there is no conversation history to convert — the history/merge
 * dance the CTF version needed is gone.
 */
class GeminiAgent extends BaseAgent {
  constructor(opts) {
    super({ ...opts, provider: 'gemini' });
    this.genAI = new GoogleGenerativeAI(CONFIG.api.gemini.apiKey);
  }

  async callModel(messages) {
    const systemInstruction = messages.find((m) => m.role === 'system')?.content || '';
    const userText = messages
      .filter((m) => m.role !== 'system')
      .map((m) => m.content)
      .join('\n\n');

    const model = this.genAI.getGenerativeModel({
      model: this.model,
      systemInstruction,
      generationConfig: { maxOutputTokens: 1024, temperature: 0.8 },
    });

    const result = await model.generateContent(userText);
    const response = result.response;

    return {
      text: response.text(),
      thinking: '',
      tokensUsed: response.usageMetadata?.totalTokenCount || null,
    };
  }
}

module.exports = { GeminiAgent };
