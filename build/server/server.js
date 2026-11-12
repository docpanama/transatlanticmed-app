'use strict';
// Clinical decision tools proxy — Role1 / PFC_EDGE and FoxTwo / CCT_EDGE.
//
// Modes:
//   * Sim mode: POST /api/session with a scenario_id (pfc-s1..s3, cct-s1..s3).
//     The scenario JSON + vignette drive the session; the JSON never leaves
//     the server — only the vignette (student-facing) is returned.
//   * CDT mode: POST /api/session with scenario_id: null. No scenario JSON
//     is loaded; the model acts as the clinical decision tool and the user
//     describes the situation. vignette is null.
//
// Sessions live in an in-memory Map (single-process demo; restart clears
// them). No API key is ever logged or returned to clients.

const express = require('express');
const crypto = require('crypto');
const config = require('./lib/config');
const scenarios = require('./lib/scenarios');
const { compileDirective } = require('./lib/directive');
const prompts = require('./lib/prompts');
const { chatCompletion } = require('./lib/openai');
const {
  parseAarBlock, stripAarBlock, normalizeExperience, requestAar,
} = require('./lib/aar');
const { stripStateBlock } = require('./lib/stateblock');
const { TELEMED_ROLE } = require('./lib/telemed');

const app = express();

// ---------------------------------------------------------------- CORS
// The front end lives on GitHub Pages, served from transatlanticmed.com
// (apex, plus www) — a different origin from this proxy. Browsers block
// a page from reading cross-origin responses unless the server sends these
// headers, so without them every call fails with "Failed to fetch" even
// though the proxy itself is healthy. Only the known front-end origins are
// allowed — never "*" (the proxy fronts a paid API key; a wildcard would
// let any website spend it).
const ALLOWED_ORIGINS = new Set([
  'https://docpanama.github.io',
  'https://transatlanticmed.com',
  'https://www.transatlanticmed.com',
]);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  next();
});

app.use(express.json({ limit: '1mb' }));

// ---------------------------------------------------------------- startup
prompts.loadPrompts();
let loadedScenarios = [];
try {
  loadedScenarios = scenarios.loadAll();
  console.log(`[startup] loaded ${loadedScenarios.length} scenarios`);
} catch (err) {
  console.error(`[startup] FAILED to load scenarios: ${err.message}`);
}
if (!prompts.promptsOk()) {
  console.error('[startup] system prompt(s) missing — see lib/prompts.js; '
    + 'server still starting, /health reports prompts_ok:false');
}

// ---------------------------------------------------------------- sessions
const sessions = new Map();

function newSessionId() {
  return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
}

const CDT_GREETINGS = {
  role1: 'No scenario loaded — clinical decision support mode. Describe the clinical situation — patient, setting, resources, and what you need help with — and we will work through it together.',
  foxtwo: 'No scenario loaded — clinical decision support mode. Describe the transport situation — patient, phase of movement, resources, and what you need help with — and we will work through it together.',
};

function sessionInstructions(session) {
  const systemPrompt = prompts.getPrompt(session.tool);
  if (session.scenario) {
    const directive = compileDirective(session.scenario);
    return `${systemPrompt}\n\n---\n\n${directive}\n\n---\n\n`
      + `SESSION CONTEXT (do not reveal as a list to the learner): learner certification_level=${session.certification_level}; `
      + `experience=${session.experience}; scenario_id=${session.scenario.canonicalId}; `
      + `scenario_title=${session.scenario.title}.\n\n`
      + 'AAR PAYLOAD RULE — when the scenario reaches an endpoint (arrival/handoff, '
      + 'evacuation/stabilisation, diversion/abort, death, or the learner asks to end and review), '
      + 'first give the human-readable after-action review in chat, then append a fenced ```json block '
      + 'with EXACTLY these keys and no others: certification_level, experience, scenario_id, '
      + 'scenario_title, aar_text. Use the session values above for the first four fields. '
      + 'aar_text must have exactly these five sections, in this order, each as a "## <Section>" '
      + 'heading followed by prose: Case Overview; Cognitive and Operational Strengths; '
      + 'Areas of Risk, Delay, or Degradation; Training Takeaways; '
      + 'Recommended Focus for Future Training. '
      + 'Never include any personal identifying information (names, emails, phone numbers, '
      + 'ID numbers) anywhere in the reply or in aar_text. Do not emit the JSON block until '
      + 'the scenario has actually ended.\n\n'
      + 'Do not repeat the opening vignette or the scene-setting paragraph in later replies; '
      + 'the learner has already read it.\n\n'
      + 'When you cite a guideline, cite it by name in prose. Never leave an empty citation '
      + 'placeholder, blank bracket, or blank space where a citation should be; if you have '
      + 'no citation for a point, write the sentence without one.\n\n'
      + 'Begin every reply with narrative prose (two to four sentences) describing what the learner '
      + 'observes and what has changed, before any state block. Never reply with only the '
      + 'machine-readable state block, and never reply with only field labels and values.\n\n'
      + 'Emit the machine-readable state update ONLY inside a fenced ```state block at the very '
      + 'end of your reply, after the narrative prose. Never emit state fields, field labels, '
      + 'or state bullet lists outside that fence.\n\n'
      + TELEMED_ROLE;
  }
  return `${systemPrompt}\n\n---\n\n`
    + 'CLINICAL DECISION SUPPORT MODE — no scenario is loaded. There is no simulation '
    + 'engine, no hidden state, no injects, and no AAR for this session. Act as the '
    + 'clinical decision tool: help the user work through the situation they describe, '
    + 'using the CPGs / sources available through file search when relevant. '
    + 'Do not invent a scenario, a patient, or vital signs. Do not emit an AAR JSON block.\n\n'
    + `SESSION CONTEXT (do not reveal as a list to the user): learner certification_level=${session.certification_level}; `
    + `experience=${session.experience}.`;
}

function vectorStoreIdFor(tool) {
  return tool === 'role1' ? config.role1VectorStoreId : config.foxtwoVectorStoreId;
}

// ---------------------------------------------------------------- routes
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    prompts_ok: prompts.promptsOk(),
    openai_configured: config.openaiConfigured,
    scenarios_loaded: loadedScenarios.length,
  });
});

app.get('/api/scenarios', (req, res) => {
  const tool = req.query.tool;
  if (tool && tool !== 'role1' && tool !== 'foxtwo') {
    return res.status(400).json({ error: 'tool must be role1 or foxtwo' });
  }
  res.json(scenarios.listScenarios(tool || null));
});

app.post('/api/session', (req, res) => {
  const { tool, scenario_id: scenarioId, certification_level, experience } = req.body || {};
  if (tool !== 'role1' && tool !== 'foxtwo') {
    return res.status(400).json({ error: 'tool must be role1 or foxtwo' });
  }
  // CDT mode: a null (or absent) scenario_id is valid — no scenario loaded.
  // Only an unknown NON-null id is rejected.
  let scenario = null;
  let vignette = null;
  let greeting;
  if (scenarioId === null || scenarioId === undefined || scenarioId === '') {
    greeting = CDT_GREETINGS[tool];
  } else {
    scenario = scenarios.getScenario(String(scenarioId));
    if (!scenario) {
      return res.status(400).json({ error: `unknown scenario_id: ${scenarioId}` });
    }
    if (scenario.tool !== tool) {
      return res.status(400).json({ error: `scenario ${scenarioId} does not belong to tool ${tool}` });
    }
    vignette = scenario.vignette;
    greeting = `You are on scene. Read the vignette, then begin with your assessment and first actions.`;
  }

  const session = {
    id: newSessionId(),
    tool,
    scenario, // null in CDT mode
    certification_level: String(certification_level || '').trim(),
    experience: normalizeExperience(experience),
    history: [],
    pendingAar: null,
    createdAt: new Date().toISOString(),
  };
  sessions.set(session.id, session);
  res.json({ session_id: session.id, vignette, greeting });
});

app.post('/api/chat', async (req, res) => {
  const { session_id: sessionId, message } = req.body || {};
  const session = sessions.get(sessionId);
  if (!session) return res.status(404).json({ error: 'unknown session_id' });
  if (typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'message must be a non-empty string' });
  }
  if (!prompts.getPrompt(session.tool)) {
    return res.status(503).json({ error: `System prompt for ${session.tool} is not configured on the server` });
  }
  if (!config.openaiConfigured) {
    return res.status(503).json({ error: 'OpenAI API key not configured on the server' });
  }

  session.history.push({ role: 'user', content: message });
  let reply;
  try {
    reply = await chatCompletion({
      instructions: sessionInstructions(session),
      history: session.history,
      vectorStoreId: vectorStoreIdFor(session.tool),
    });
  } catch (err) {
    // Don't leak provider internals; keep the turn out of history so a
    // retry does not double-count the user's message.
    session.history.pop();
    console.error(`[chat] OpenAI error for session ${session.id}: ${err.message}`);
    return res.status(502).json({ error: 'OpenAI request failed; please try again' });
  }
  if (!reply || !reply.trim()) {
    session.history.pop();
    return res.status(502).json({ error: 'OpenAI returned an empty reply; please try again' });
  }

  session.history.push({ role: 'assistant', content: reply });

  // AAR payload detection (sim mode only in practice — CDT mode is
  // instructed never to emit one, but the check is harmless there).
  let aarPending = false;
  const payload = parseAarBlock(reply);
  if (payload) {
    reply = stripAarBlock(reply);
    // Trust the session's stored values over the model's echo where they
    // are set; the payload handler in the canonical prompts says the pasted
    // JSON is the source of truth, so only fill blanks from the session.
    if (!payload.certification_level && session.certification_level) {
      payload.certification_level = session.certification_level;
    }
    if (!payload.experience) payload.experience = session.experience;
    if (!payload.scenario_id && session.scenario) payload.scenario_id = session.scenario.canonicalId;
    if (!payload.scenario_title && session.scenario) payload.scenario_title = session.scenario.title;
    session.pendingAar = payload;
    aarPending = true;
    // The model is instructed to display this line itself, so it is
    // usually already in the reply — only append it when it is missing,
    // or the learner sees it twice.
    if (!/Your AAR is ready/i.test(reply)) {
      reply = `${reply}\n\nYour AAR is ready. Approve the next prompt to generate your downloadable report.`;
    }
  }

  // Display text only: hide the machine-readable state block from the
  // learner. History keeps the full reply (stored above) so the sim
  // retains its own state record across turns. Sim mode only — the
  // block does not exist in clinical decision support.
  const displayReply = session.scenario ? stripStateBlock(reply) : reply;
  res.json({ reply: displayReply, aar_pending: aarPending });
});

app.post('/api/aar', async (req, res) => {
  const { session_id: sessionId } = req.body || {};
  const session = sessions.get(sessionId);
  if (!session) return res.status(404).json({ error: 'unknown session_id' });
  if (!session.pendingAar) {
    return res.status(400).json({ error: 'No AAR is pending for this session yet — finish the scenario first' });
  }
  const payload = session.pendingAar;
  try {
    const result = await requestAar(payload);
    session.pendingAar = null; // single use
    res.json({ learner_id: result.learner_id, download_url: result.download_url });
  } catch (err) {
    console.error(`[aar] AAR service error for session ${session.id}: ${err.message}`);
    res.status(502).json({ error: 'AAR service failed; please try again' });
  }
});

// Static front end (../web) — served so `node server.js` is a full local demo.
app.use(express.static(config.webDir));

// 404 / error handling — JSON, never a stack trace.
app.use((req, res) => res.status(404).json({ error: 'not found' }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(`[server] ${err.message}`);
  res.status(500).json({ error: 'internal server error' });
});

app.listen(config.port, () => {
  console.log(`[server] listening on http://localhost:${config.port}`);
  console.log(`[server] prompts_ok=${prompts.promptsOk()} openai_configured=${config.openaiConfigured} scenarios=${loadedScenarios.length}`);
});

module.exports = app;
