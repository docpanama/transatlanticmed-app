'use strict';
// Scenario loader.
//
// Loads the 6 production scenario JSONs from ./scenarios/ and normalises the
// two packaging shapes found in the source files:
//
//   * PFC S1 / S3 (v1.3.2): engine blocks live UNDER `directive`
//     (directive.engine_rules, directive.session_start_behavior, ...).
//   * PFC S2 (v1.3.3) and all three CCT scenarios: the same blocks live at
//     TOP LEVEL (engine_rules, session_start_behavior, ...) alongside a
//     slimmer `directive` that still holds state / time_control /
//     data_release / output_format / termination etc.
//
// The loader merges both locations (directive wins on a shared key) so the
// rest of the server only ever sees one normalised shape. The raw JSON —
// including hidden_state / true_problem_set / answers — is NEVER sent to a
// client; only listScenarios() metadata leaves the server.

const fs = require('fs');
const path = require('path');
const config = require('./config');

// Engine-block keys: any of these may appear under `directive`, at top
// level, or both. Kept as a list (not a guess) so a future scenario version
// that moves a block does not silently drop it.
const ENGINE_BLOCK_KEYS = [
  'engine_rules', 'engine_patch', 'session_start_behavior',
  'session_start_sequence', 'scope_modulation',
  'procedure_friction_behavior', 'cognitive_offloading_policy',
  'debug_policy', 'student_policy', 'time_control', 'intake',
  'data_release', 'teaching_behavior', 'guidance_gating', 'knowledge',
  'assumption_control', 'physiology_model', 'warning_policy', 'state',
  'output_format', 'termination', 'non_disclosure', 'raw',
  'simulation_mode_behavior', 'AAR_policy', 'environmental_context_policy',
  'export_safety', 'pii_policy', 'report_metadata',
  'transport_constraints_policy', 'export_policy', 'version',
];

const SCENARIO_FILES = {
  'pfc-s1': { file: 'pfc-s1.json', tool: 'role1' },
  'pfc-s2': { file: 'pfc-s2.json', tool: 'role1' },
  'pfc-s3': { file: 'pfc-s3.json', tool: 'role1' },
  'cct-s1': { file: 'cct-s1.json', tool: 'foxtwo' },
  'cct-s2': { file: 'cct-s2.json', tool: 'foxtwo' },
  'cct-s3': { file: 'cct-s3.json', tool: 'foxtwo' },
};

function readVignette(id) {
  const p = path.join(config.scenariosDir, `${id}.vignette.txt`);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim() : '';
}

// Level is not a field in the PFC JSONs; it is in the vignette header
// ("Vignette 1, Basic" / "Vignette 2, Advanced" / "Vignette 3, PEDIATRIC").
// CCT JSONs carry scenario.level directly. Normalised to Title Case.
function levelFrom(vignette, scenarioObj) {
  if (scenarioObj && typeof scenarioObj.level === 'string' && scenarioObj.level.trim()) {
    const l = scenarioObj.level.trim().toLowerCase();
    return l.charAt(0).toUpperCase() + l.slice(1);
  }
  const m = vignette.match(/Vignette\s+\d+\s*[,(\[]\s*([A-Za-z]+)/i);
  if (m) {
    const l = m[1].toLowerCase();
    return l.charAt(0).toUpperCase() + l.slice(1);
  }
  return 'Basic';
}

function normalize(raw, id, tool) {
  const directive = (raw && typeof raw.directive === 'object' && raw.directive) || {};
  const scenario = (raw && typeof raw.scenario === 'object' && raw.scenario) || {};

  // Merge engine blocks: top-level first, directive overrides (directive is
  // the newer/authoritative location where both exist).
  const blocks = {};
  for (const key of ENGINE_BLOCK_KEYS) {
    if (raw && raw[key] !== undefined) blocks[key] = raw[key];
    if (directive[key] !== undefined) blocks[key] = directive[key];
  }

  const vignette = readVignette(id);
  return {
    id, // file id, e.g. 'pfc-s1' — what the API uses as scenario_id
    tool,
    canonicalId: scenario.id || id, // e.g. 'S1' / 'CCT_SIM_S1' — what the AAR payload uses
    title: scenario.title || id,
    level: levelFrom(vignette, scenario),
    theme: scenario.theme || '',
    description: scenario.theme || scenario.title || id,
    // Student-facing only. Hidden state stays inside `raw` and is never
    // exposed by listScenarios(); the directive compiler filters it too.
    vignette,
    scenario, // scenario object (contains hidden_state — server-side only)
    blocks, // merged directive/engine blocks
    packageId: raw.package_id || '',
    pkgVersion: raw.pkg_version || '',
    raw, // full parsed JSON, server-side only
  };
}

const cache = new Map();

function loadAll() {
  for (const [id, meta] of Object.entries(SCENARIO_FILES)) {
    if (cache.has(id)) continue;
    const filePath = path.join(config.scenariosDir, meta.file);
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    cache.set(id, normalize(raw, id, meta.tool));
  }
  return [...cache.values()];
}

function getScenario(id) {
  loadAll();
  return cache.get(id) || null;
}

// Metadata only — never raw JSON, never hidden state.
function listScenarios(tool) {
  return loadAll()
    .filter((s) => !tool || s.tool === tool)
    .map((s) => ({ id: s.id, title: s.title, level: s.level, description: s.description }));
}

module.exports = { loadAll, getScenario, listScenarios, SCENARIO_FILES, ENGINE_BLOCK_KEYS };
