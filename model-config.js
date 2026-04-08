/**
 * Centralized model configuration for all Anthropic API calls.
 *
 * Editable via the Nico's Brain page in the dashboard.
 * Stored in /tmp/surepath-model-config.json — survives process restarts
 * but not server reboots (defaults apply).
 *
 * Available models (April 2026):
 *   claude-3-haiku-20240307    — cheapest, fastest, good for simple tasks
 *   claude-haiku-4-5-20251001  — newer haiku, better quality
 *   claude-sonnet-4-6          — best balance of quality/cost (default for vision)
 *   claude-opus-4-6            — most capable, expensive
 */
const fs = require('fs');
const CONFIG_FILE = '/tmp/surepath-model-config.json';

const DEFAULTS = {
  vision: 'claude-sonnet-4-6',       // Photo analysis (listing, street view, satellite)
  synthesis: 'claude-3-haiku-20240307', // Report generation
  tease: 'claude-sonnet-4-6',        // WhatsApp tease (2-line preview)
  extract: 'claude-3-haiku-20240307', // Feature extraction from description
};

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
    const saved = JSON.parse(raw);
    return { ...DEFAULTS, ...saved };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveConfig(config) {
  const merged = { ...DEFAULTS, ...config };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2));
  return merged;
}

function getModel(role) {
  const config = loadConfig();
  return config[role] || DEFAULTS[role] || 'claude-sonnet-4-6';
}

module.exports = { getModel, loadConfig, saveConfig, DEFAULTS };
