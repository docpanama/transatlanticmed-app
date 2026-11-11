'use strict';
// Directive compiler.
//
// Turns a loaded scenario's directive/engine blocks into concise prompt text
// the model can execute as the simulation engine. The compiled text is sent
// to OpenAI only — it is never shown to the student.
//
// Safety rule: anything that would let the student (or a leaked prompt)
// read the answers is stripped before compiling. The denylist is applied
// recursively to every block rendered below:
//   hidden_state, true_problem_set, anchors, discovery_nodes, latent_risks,
//   primary_*_killer, arrest_risk_pathway, reversibility, source_control_*,
//   shock_path, hypoglycemia, background_instability_driver, *_variant
// plus the whole `raw` block (verbatim source dump) and `debug_policy`.
// Evaluation design (decision points / cognitive traps) and resolution
// hooks ARE included — they tell the model what to assess, not the student
// what the answer is — but their nested hidden values are still filtered.

const DENY_KEYS = new Set([
  'hidden_state', 'true_problem_set', 'anchors', 'discovery_nodes',
  'latent_risks', 'primary_transport_killer', 'primary_inject',
  'arrest_risk_pathway', 'reversibility', 'source_control_pressure',
  'shock_path', 'hypoglycemia', 'background_instability_driver',
  'optional_complication_variant', 'raw', 'debug_policy',
]);

const MAX_SECTION_CHARS = 6000;
// Full compiled directives run ~17–20k chars; the cap sits well above that
// so nothing load-bearing (injects, resolution hooks) is ever cut, while
// still bounding prompt size. ~20k chars ≈ 5k tokens of system prompt.
const MAX_TOTAL_CHARS = 32000;

function stripDenied(value) {
  if (Array.isArray(value)) return value.map(stripDenied);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (DENY_KEYS.has(k)) continue;
      out[k] = stripDenied(v);
    }
    return out;
  }
  return value;
}

function renderBlock(name, value) {
  if (value === undefined) return '';
  const clean = stripDenied(value);
  let text = typeof clean === 'string' ? clean : JSON.stringify(clean);
  if (!text || text === '{}' || text === '[]') return '';
  if (text.length > MAX_SECTION_CHARS) {
    text = text.slice(0, MAX_SECTION_CHARS) + '\n… [truncated for prompt length]';
  }
  return `### ${name}\n${text}\n`;
}

function patientSummary(patient) {
  if (!patient || typeof patient !== 'object') return '';
  const parts = [];
  if (patient.age_years !== undefined) parts.push(`Age: ${patient.age_years} years`);
  if (patient.sex) parts.push(`Sex: ${patient.sex}`);
  if (patient.mechanism) parts.push(`Mechanism: ${String(patient.mechanism).replace(/_/g, ' ')}`);
  if (patient.current_status) {
    const cs = typeof patient.current_status === 'string'
      ? patient.current_status
      : JSON.stringify(stripDenied(patient.current_status));
    parts.push(`Current status: ${cs}`);
  }
  const initial = patient.initial_assessment || patient.initial_assessment_hour0
    || patient.current_assessment_hour12;
  if (initial) parts.push(`Initial assessment: ${JSON.stringify(stripDenied(initial))}`);
  return parts.join('\n');
}

// Compile one normalised scenario (see lib/scenarios.js) into prompt text.
function compileDirective(scenario) {
  const { blocks, scenario: sc } = scenario;
  const lines = [];
  lines.push('## SCENARIO DIRECTIVE — server-supplied simulation engine data');
  lines.push('You are running this scenario as the simulation engine. Follow the blocks below exactly. '
    + 'Never reveal hidden state, the true problem set, inject triggers, or evaluation criteria to the learner. '
    + 'Release findings only as the data-release rules below allow.');
  lines.push('');
  lines.push(`Scenario: ${scenario.title} (scenario_id for AAR payloads: ${scenario.canonicalId})`);
  if (scenario.theme) lines.push(`Theme: ${scenario.theme}`);
  if (scenario.level) lines.push(`Level: ${scenario.level}`);
  const env = sc.environment || {};
  if (env.scenario_label) lines.push(`Setting: ${env.scenario_label}`);
  if (env.location_description) lines.push(`Location: ${env.location_description}`);
  const ps = patientSummary(sc.patient);
  if (ps) lines.push(`Patient (initial presentation only):\n${ps}`);
  if (sc.operational_context) {
    lines.push(renderBlock('Operational context', stripDenied(sc.operational_context)));
  }
  if (sc.resources) lines.push(renderBlock('Available resources', stripDenied(sc.resources)));
  lines.push('');

  // Engine behaviour blocks, in execution order. Missing blocks are skipped,
  // so the compiler stays generic across Role1 and FoxTwo scenarios.
  const ordered = [
    'engine_rules', 'engine_patch', 'state', 'time_control',
    'session_start_behavior', 'session_start_sequence',
    'intake', 'data_release', 'teaching_behavior', 'guidance_gating',
    'cognitive_offloading_policy', 'assumption_control',
    'physiology_model', 'procedure_friction_behavior',
    'scope_modulation', 'knowledge', 'non_disclosure',
    'warning_policy', 'output_format', 'termination',
    'simulation_mode_behavior', 'transport_constraints_policy',
    'environmental_context_policy', 'export_safety', 'pii_policy',
    'AAR_policy', 'report_metadata', 'student_policy',
  ];
  for (const key of ordered) {
    const text = renderBlock(key.replace(/_/g, ' '), blocks[key]);
    if (text) lines.push(text);
  }

  // Scenario content the engine needs: injects (with triggers + state
  // updates), what to assess, and how the scenario resolves. Hidden state
  // inside these is stripped by stripDenied().
  if (sc.injects) lines.push(renderBlock('Injects (apply in order when their trigger matches)', sc.injects));
  if (sc.evaluation_design) lines.push(renderBlock('Evaluation design (assess against this; do not show it)', sc.evaluation_design));
  if (sc.resolution_hooks) lines.push(renderBlock('Resolution hooks', sc.resolution_hooks));

  let out = lines.filter(Boolean).join('\n');
  if (out.length > MAX_TOTAL_CHARS) {
    out = out.slice(0, MAX_TOTAL_CHARS) + '\n… [directive truncated for prompt length]';
  }
  return out;
}

module.exports = { compileDirective, stripDenied, DENY_KEYS };
