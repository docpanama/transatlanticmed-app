'use strict';
// Hybrid AAR completion gate.
//
// The model may emit an AAR payload when a learner declares the exercise
// complete. For CE integrity, the server accepts that payload only after
// verifiable engagement: enough learner turns, scenario state advancement,
// and scenario progress markers. If the gate is not met, server.js replaces
// the model reply with AAR_GATE_CONTINUE_MESSAGE and does not set pendingAar.

const { parseStateFieldLine, isPhaseHeading } = require('./stateblock');

const MIN_LEARNER_TURNS = 8;
const MIN_MARKERS = 4;
const AAR_GATE_CONTINUE_MESSAGE = 'The scenario has not reached a completion point yet. Continue your assessment, management, reassessment, and evacuation planning. When you reach a disposition or handoff decision, declare the exercise complete.';

function isDeclarationMessage(text) {
  return /declare.*complete|exercise complete|end scenario|present the after-action|after-action review|aar please/i.test(String(text || ''));
}

function learnerMessages(history) {
  return (history || [])
    .filter((m) => m && m.role === 'user' && typeof m.content === 'string')
    .map((m) => m.content.trim())
    .filter((text) => text.length >= 3 && !isDeclarationMessage(text));
}

function stateLinesFromReply(reply) {
  const lines = [];
  const text = String(reply || '');
  const fenced = text.match(/```state\r?\n([\s\S]*?)```/g) || [];
  for (const block of fenced) {
    const inner = block.replace(/^```state\r?\n/, '').replace(/```$/, '');
    lines.push(...inner.split('\n'));
  }
  lines.push(...text.split('\n'));
  return lines;
}

function extractStateEvidence(history) {
  const timestamps = new Set();
  const phases = new Set();
  const interventionEntries = new Set();
  const interventionLogs = [];
  let stateUpdates = 0;

  for (const msg of history || []) {
    if (!msg || msg.role !== 'assistant' || typeof msg.content !== 'string') continue;
    let sawState = false;
    for (const line of stateLinesFromReply(msg.content)) {
      const phase = isPhaseHeading(line);
      if (phase) { phases.add(phase.toLowerCase()); sawState = true; }
      const parsed = parseStateFieldLine(line);
      if (!parsed) continue;
      sawState = true;
      const value = String(parsed.value || '').trim();
      if (parsed.field === 'timestamp_or_phase' || parsed.field === 'timestamp') {
        if (value) timestamps.add(value.toLowerCase());
      }
      if (parsed.field === 'brief_intervention_log' && value && !/^unchanged$/i.test(value)) {
        interventionLogs.push(value);
        for (const part of value.split(/[;\n]/)) {
          const entry = part.trim().toLowerCase();
          if (entry && entry !== 'none' && entry !== 'unchanged') interventionEntries.add(entry);
        }
      }
    }
    if (sawState) stateUpdates += 1;
  }

  const timestampText = [...timestamps].join(' ');
  const phaseText = [...phases].join(' ');
  const nonStartTimestamp = [...timestamps].some((t) => !/^(start|initial|pre-movement.*start|start phase)/.test(t));
  const advancedPattern = /(h\s*4|hour\s*[2-9]|hours?\s*[2-9]|[2-9]\s*hours|loading|airborne|en route|approach|handoff|stabilized|transport)/i;
  const stateAdvanced = interventionEntries.size >= 3
    || nonStartTimestamp
    || advancedPattern.test(`${timestampText} ${phaseText}`)
    || (stateUpdates >= 4 && interventionEntries.size >= 1);

  return {
    timestamps: [...timestamps],
    phases: [...phases],
    interventionEntries: [...interventionEntries],
    interventionLogs,
    stateUpdates,
    stateAdvanced,
  };
}

function has(text, pattern) {
  return pattern.test(text);
}

function evaluateMarkers(corpus, scenarioId) {
  const text = String(corpus || '').toLowerCase();
  const markers = {
    assessment: has(text, /\b(assess|assessment|vitals|exam|airway|breathing|circulation|mental status|blood pressure|heart rate|respiratory|lactate|urine output|passive stretch|calf|leg exam)\b/),
    recognition: has(text, /\b(sepsis|septic|shock|hypoperfusion|deteriorat|worsening|necrotiz|compartment|limb[- ]threatening|tension pneumothorax|respiratory failure|concerning for|likely)\b/),
    intervention: has(text, /\b(oxygen|fluid|bolus|antibiotic|source control|surgical|consult|decompress|ventilate|intubat|sedat|blood|transfus|perfusion|vasopressor|treat|intervention)\b/),
    reassessment: has(text, /\b(reassess|recheck|trend|repeat|serial|response|monitor|urine output|lactate|mental status|vitals again|follow[- ]up)\b/),
    escalation: has(text, /\b(telemed|medical direction|evac|evacuation|handoff|transport|receiving|higher care|consult|disposition)\b/),
  };

  if (scenarioId === 'pfc-s1') {
    markers.recognition = has(text, /\b(sepsis|septic|shock|hypoperfusion|necrotiz|compartment|limb[- ]threatening)\b/);
    const perfusion = has(text, /\b(oxygen|fluid|bolus|perfusion|blood pressure support|map|vasopressor|crystalloid)\b/);
    const antibiotic = has(text, /\b(antibiotic|cef|pip|zosyn|meropenem|ertapenem|vancomycin)\b/);
    const sourceControl = has(text, /\b(source control|surgical|surgeon|consult|debrid|fasciotomy|drainage|operative)\b/);
    markers.intervention = perfusion && (antibiotic || sourceControl);
  }

  const met = Object.entries(markers).filter(([, v]) => v).map(([k]) => k);
  return { markers, met, count: met.length };
}

function evaluateAarGate(session) {
  const history = (session && session.history) || [];
  const turns = learnerMessages(history);
  const state = extractStateEvidence(history);
  const corpus = [...turns, ...state.interventionLogs].join('\n');
  const scenarioId = session && session.scenario ? (session.scenario.id || session.scenario.canonicalId) : null;
  const markerResult = evaluateMarkers(corpus, scenarioId);
  const reasons = [];
  if (turns.length < MIN_LEARNER_TURNS) reasons.push(`learner_turns_${turns.length}_of_${MIN_LEARNER_TURNS}`);
  if (!state.stateAdvanced) reasons.push('state_not_advanced');
  if (markerResult.count < MIN_MARKERS) reasons.push(`markers_${markerResult.count}_of_${MIN_MARKERS}`);
  return {
    met: reasons.length === 0,
    learnerTurns: turns.length,
    minLearnerTurns: MIN_LEARNER_TURNS,
    stateAdvanced: state.stateAdvanced,
    stateUpdates: state.stateUpdates,
    interventionEntryCount: state.interventionEntries.length,
    markers: markerResult.markers,
    markersMet: markerResult.met,
    markerCount: markerResult.count,
    minMarkers: MIN_MARKERS,
    reasons,
  };
}

module.exports = {
  MIN_LEARNER_TURNS,
  MIN_MARKERS,
  AAR_GATE_CONTINUE_MESSAGE,
  learnerMessages,
  extractStateEvidence,
  evaluateMarkers,
  evaluateAarGate,
};
