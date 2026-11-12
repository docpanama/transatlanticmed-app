'use strict';
// Local checks — run with `npm test`. No API key needed; nothing here calls
// OpenAI or the network except the optional AAR probe (see below).
//
// Checks:
//   1. Loader handles BOTH scenario JSON shapes (nested-under-directive and
//      top-level engine blocks) and exposes metadata only.
//   2. Directive compiler strips hidden state / answers.
//   3. AAR payload-block parsing (exact keys only) + stripping.
//   4. Experience normalisation + PII scrub.
//   5. CDT mode: a null scenario_id session has no scenario and null vignette
//      (session creation itself is exercised over HTTP in the curl tests;
//      the contract is asserted here against the loader/session rules).
//
// Optional: set AAR_PROBE=1 to make ONE test POST to the AAR service with a
// clearly-marked test payload (verifies the AAR client end to end).

const assert = require('assert');
const scenarios = require('../lib/scenarios');
const { compileDirective } = require('../lib/directive');
const { parseAarBlock, stripAarBlock, scrubPii, normalizeExperience, requestAar } = require('../lib/aar');
const { stripStateBlock } = require('../lib/stateblock');

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

check('loader loads all 6 scenarios', () => {
  const all = scenarios.loadAll();
  assert.strictEqual(all.length, 6);
});

check('loader accepts nested shape (pfc-s1: engine_rules under directive)', () => {
  const s = scenarios.getScenario('pfc-s1');
  assert.ok(s.blocks.engine_rules, 'engine_rules missing');
  assert.ok(s.blocks.session_start_behavior, 'session_start_behavior missing');
  assert.strictEqual(s.title, 'Easy');
  assert.strictEqual(s.level, 'Basic');
});

check('loader accepts top-level shape (pfc-s2 v1.3.3: engine blocks at top level)', () => {
  const s = scenarios.getScenario('pfc-s2');
  assert.ok(s.blocks.engine_rules, 'engine_rules missing');
  assert.ok(s.blocks.engine_patch, 'engine_patch missing');
  assert.ok(s.blocks.cognitive_offloading_policy, 'cognitive_offloading_policy missing');
  assert.strictEqual(s.title, 'Hard');
  assert.strictEqual(s.level, 'Advanced');
});

check('loader accepts top-level shape (cct-s1..s3)', () => {
  for (const id of ['cct-s1', 'cct-s2', 'cct-s3']) {
    const s = scenarios.getScenario(id);
    assert.ok(s.blocks.engine_rules, `${id}: engine_rules missing`);
    assert.ok(s.blocks.simulation_mode_behavior, `${id}: simulation_mode_behavior missing`);
    assert.ok(s.blocks.time_control, `${id}: time_control missing`);
  }
  assert.strictEqual(scenarios.getScenario('cct-s1').title, 'Easy');
  assert.strictEqual(scenarios.getScenario('cct-s2').level, 'Advanced');
  assert.strictEqual(scenarios.getScenario('cct-s3').level, 'Pediatric');
});

check('listScenarios returns metadata only (no raw JSON, no hidden state)', () => {
  const list = scenarios.listScenarios('role1');
  assert.strictEqual(list.length, 3);
  for (const m of list) {
    assert.deepStrictEqual(Object.keys(m).sort(), ['id', 'title']);
    assert.ok(!JSON.stringify(m).includes('hidden_state'));
  }
  assert.strictEqual(scenarios.listScenarios('foxtwo').length, 3);
});

check('vignettes loaded for all 6 scenarios', () => {
  for (const id of ['pfc-s1', 'pfc-s2', 'pfc-s3', 'cct-s1', 'cct-s2', 'cct-s3']) {
    const s = scenarios.getScenario(id);
    assert.ok(s.vignette.length > 500, `${id}: vignette too short`);
    assert.ok(!s.vignette.includes('true_problem_set'));
  }
});

check('directive compiler includes engine rules and injects, strips hidden state', () => {
  const s = scenarios.getScenario('pfc-s2');
  const text = compileDirective(s);
  assert.ok(text.includes('Scenario: Hard'));
  assert.ok(text.includes('Injects'));
  // Hidden-state BLOCKS must be gone (checked as JSON keys). Note the bare
  // phrase "hidden_state" legitimately appears inside engine_rules prose
  // ("Do not show hidden_state") — that is an instruction, not content.
  for (const key of ['"hidden_state"', '"true_problem_set"', '"primary_inject"',
    '"optional_complication_variant"', '"discovery_nodes"', '"latent_risks"']) {
    assert.ok(!text.includes(key), `${key} leaked into compiled directive`);
  }
});

check('directive compiler works for a CCT scenario (resolution hooks included)', () => {
  const text = compileDirective(scenarios.getScenario('cct-s1'));
  assert.ok(text.includes('Resolution hooks'));
  assert.ok(text.includes('Scenario: Easy'));
  for (const key of ['"hidden_state"', '"true_problem_set"', '"primary_transport_killer"',
    '"arrest_risk_pathway"', '"discovery_nodes"', '"latent_risks"']) {
    assert.ok(!text.includes(key), `${key} leaked into compiled directive`);
  }
});

check('parseAarBlock accepts exact 5-key block', () => {
  const reply = 'Here is your review.\n\n```json\n'
    + JSON.stringify({
      certification_level: 'Paramedic', experience: 'beginner',
      scenario_id: 'S2', scenario_title: 'The Hypoxic Patient at Hour 14',
      aar_text: '## Case Overview\nA ventilated patient deteriorated.',
    })
    + '\n```\n\nWell done.';
  const p = parseAarBlock(reply);
  assert.ok(p);
  assert.strictEqual(p.scenario_id, 'S2');
  assert.strictEqual(p.experience, 'beginner');
  const stripped = stripAarBlock(reply);
  assert.ok(!stripped.includes('```json'), 'JSON block not stripped');
  assert.ok(stripped.includes('Here is your review.'));
});

check('parseAarBlock rejects blocks with wrong keys', () => {
  const bad = '```json\n{"certification_level":"x","experience":"y","scenario_id":"S1","aar_text":"t","extra":1}\n```';
  assert.strictEqual(parseAarBlock(bad), null);
  assert.strictEqual(parseAarBlock('no json here'), null);
  assert.strictEqual(parseAarBlock('```json\n{not json}\n```'), null);
});

check('experience normalisation', () => {
  assert.strictEqual(normalizeExperience('beginner'), 'novice');
  assert.strictEqual(normalizeExperience('Beginner'), 'novice');
  assert.strictEqual(normalizeExperience('intermediate'), 'intermediate');
  assert.strictEqual(normalizeExperience('expert'), 'experienced');
  assert.strictEqual(normalizeExperience('experienced'), 'experienced');
});

check('PII scrub removes emails, phones, SSN-style numbers', () => {
  const out = scrubPii('Contact me at matt@example.com or 928-555-0147. SSN 123-45-6789. DOB: 1 Jan 1990.');
  assert.ok(!out.includes('matt@example.com'));
  assert.ok(!out.includes('928-555-0147'));
  assert.ok(!out.includes('123-45-6789'));
  assert.ok(!out.includes('1 Jan 1990'));
});

check('state block stripped from display reply, narrative kept', () => {
  const reply = 'You arrive at the aircraft. The patient is loaded and the crew is ready.\n\n'
    + '**State:**\n'
    + 'timestamp_or_phase: loading\n'
    + 'vitals unchanged: HR 110, BP 100/60\n'
    + 'mental_status unchanged\n'
    + 'key_exam_findings unchanged\n'
    + 'brief_intervention_log: IV access established';
  const out = stripStateBlock(reply);
  assert.ok(out.includes('You arrive at the aircraft.'));
  assert.ok(!out.includes('timestamp_or_phase'));
  assert.ok(!out.includes('brief_intervention_log'));
  assert.ok(!out.includes('**State:**'));
});

check('state-block-only reply falls back to readable text, not empty', () => {
  const reply = 'timestamp: after initial assessment/actions\n'
    + 'vitals: HR 118, BP 90/58\n'
    + 'mental_status: alert\n'
    + 'key_exam_findings: tense left calf\n'
    + 'urine_output_if_relevant: 10-15 mL/hr\n'
    + 'brief_intervention_log: 2L crystalloids given';
  const out = stripStateBlock(reply);
  assert.ok(out.length > 0, 'fallback must not be empty');
  assert.ok(!out.includes('timestamp:'));
  assert.ok(!out.includes('brief_intervention_log'));
  assert.ok(out.includes('HR 118'), 'fallback should carry the vitals');
});

check('reply with no state block is unchanged', () => {
  const reply = 'The patient remains stable.\nVitals remain steady and the crew is ready to move.';
  assert.strictEqual(stripStateBlock(reply), reply);
});

(async () => {
  if (process.env.AAR_PROBE === '1') {
    console.log('probe - POSTing ONE clearly-marked test payload to the AAR service…');
    const result = await requestAar({
      certification_level: 'TEST — proxy self-test, not a real learner',
      experience: 'beginner',
      scenario_id: 'TEST',
      scenario_title: 'Proxy self-test (please ignore)',
      aar_text: '## Case Overview\nTEST payload from the clinical-tools proxy local checks.\n\n## Cognitive and Operational Strengths\nNone — test only.\n\n## Areas of Risk, Delay, or Degradation\nNone — test only.\n\n## Training Takeaways\nNone — test only.\n\n## Recommended Focus for Future Training\nNone — test only.',
    });
    console.log(`probe - AAR service returned learner_id=${result.learner_id} download_url=${result.download_url}`);
    assert.ok(result.learner_id);
    assert.ok(result.download_url);
    passed += 1;
    console.log('ok - AAR service probe (single test payload)');
  }
  console.log(`\n${passed} checks passed.`);
})().catch((err) => {
  console.error(`FAILED: ${err.message}`);
  process.exit(1);
});
