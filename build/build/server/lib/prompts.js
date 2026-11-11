'use strict';
// System prompts.
//
// Read once at startup from ../prompts/role1_system_prompt.md and
// ../prompts/foxtwo_system_prompt.md (composed by a sibling workstream).
// If a file is missing, that tool is reported prompts_ok:false, /health
// reflects it, and /api/chat for that tool returns 503 — but the server
// still starts, so scenario browsing and the rest of the API keep working.

const fs = require('fs');
const path = require('path');
const config = require('./config');

const PROMPT_FILES = {
  role1: 'role1_system_prompt.md',
  foxtwo: 'foxtwo_system_prompt.md',
};

const prompts = { role1: null, foxtwo: null };
const errors = {};

function loadPrompts() {
  for (const [tool, file] of Object.entries(PROMPT_FILES)) {
    const p = path.join(config.promptsDir, file);
    try {
      const raw = fs.readFileSync(p, 'utf8').trim();
      if (!raw) {
        prompts[tool] = null;
        errors[tool] = `${file} is empty`;
      } else {
        // Prompt files carry a short human-readable header (title, model,
        // provenance) above a bare `---` separator. Only the prompt body
        // below it is sent to the model; the header is documentation.
        const lines = raw.split('\n');
        const sep = lines.findIndex((l) => l.trim() === '---');
        const body = (sep >= 0 ? lines.slice(sep + 1).join('\n') : raw).trim();
        prompts[tool] = body;
        delete errors[tool];
      }
    } catch (err) {
      prompts[tool] = null;
      errors[tool] = `missing ${file} (${err.code || err.message})`;
      console.error(`[prompts] ${tool}: ${errors[tool]} — expected at ${p}`);
    }
  }
  return prompts;
}

function getPrompt(tool) {
  return prompts[tool] || null;
}

function promptsOk() {
  return Boolean(prompts.role1 && prompts.foxtwo);
}

function promptStatus() {
  return { role1: Boolean(prompts.role1), foxtwo: Boolean(prompts.foxtwo), errors };
}

module.exports = { loadPrompts, getPrompt, promptsOk, promptStatus };
