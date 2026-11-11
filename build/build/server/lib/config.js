'use strict';
// Central config. No secrets are ever logged or returned to clients.
const path = require('path');

function envInt(name, fallback) {
  const v = parseInt(process.env[name] || '', 10);
  return Number.isFinite(v) ? v : fallback;
}

const config = {
  port: envInt('PORT', 3000),
  openaiApiKey: process.env.OPENAI_API_KEY || '',
  openaiModel: process.env.OPENAI_MODEL || 'gpt-5.4',
  // Temperature is optional: GPT-5-family reasoning models reject a
  // non-default temperature, so it is only sent when explicitly configured.
  // See lib/openai.js — it also retries once without temperature on a 400.
  openaiTemperature: process.env.OPENAI_TEMPERATURE
    ? parseFloat(process.env.OPENAI_TEMPERATURE)
    : null,
  openaiMaxOutputTokens: envInt('OPENAI_MAX_OUTPUT_TOKENS', 4096),
  role1VectorStoreId: process.env.ROLE1_VECTOR_STORE_ID || '',
  foxtwoVectorStoreId: process.env.FOXTWO_VECTOR_STORE_ID || '',
  aarServiceUrl: (process.env.AAR_SERVICE_URL || 'https://fox-two-aar.onrender.com').replace(/\/$/, ''),
  serverDir: path.join(__dirname, '..'),
  scenariosDir: path.join(__dirname, '..', 'scenarios'),
  // System prompts live two levels up: build/prompts/*.md (composed by a
  // sibling workstream). They are read at startup; see lib/prompts.js.
  promptsDir: path.join(__dirname, '..', '..', 'prompts'),
  webDir: path.join(__dirname, '..', '..', 'web'),
};

config.openaiConfigured = Boolean(config.openaiApiKey);

module.exports = config;
