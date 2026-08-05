const { OpenAIAgent, OpenAICompatibleAgent } = require('./providers/openai.js');
const { ClaudeAgent } = require('./providers/claude.js');
const { GeminiAgent } = require('./providers/gemini.js');
const { GrokAgent, PerplexityAgent } = require('./providers/http-openai-shaped.js');
const { OllamaAgent } = require('./providers/ollama.js');
const { OllamaCloudAgent } = require('./providers/ollama-cloud.js');
const { ScriptedAgent } = require('./scripted-player.js');

const PROVIDERS = {
  openai: OpenAIAgent,
  'openai-compatible': OpenAICompatibleAgent,
  claude: ClaudeAgent,
  gemini: GeminiAgent,
  grok: GrokAgent,
  perplexity: PerplexityAgent,
  ollama: OllamaAgent,
  'ollama-cloud': OllamaCloudAgent,
  scripted: ScriptedAgent,
};

/**
 * Build the agent map the engine drives, keyed by persona name.
 *
 * Seats are assigned by GameState (which shuffles), so this runs after state
 * construction and reads the seats back off it — otherwise the persona/model pairing
 * here and the one in the state could drift apart, and every result would be
 * attributed to the wrong model.
 */
function buildAgents(state, { contextMode, rng, outputMode = 'json', strictTargets = false }) {
  const agents = new Map();

  for (const player of state.players) {
    const Cls = PROVIDERS[player.provider];
    if (!Cls) {
      throw new Error(`No adapter for provider "${player.provider}" (seat ${player.name})`);
    }
    agents.set(
      player.name,
      new Cls({
        playerName: player.name,
        model: player.model,
        baseUrl: player.baseUrl,
        // A seat may pin its own context mode (`key@full`); otherwise follow the global.
        contextMode: player.contextMode || contextMode,
        outputMode,
        strictTargets,
        rng,
      })
    );
  }

  return agents;
}

module.exports = { buildAgents, PROVIDERS };
