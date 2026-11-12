'use strict';
// State-block stripping — the sim's replies carry a machine-readable
// state block the model emits for its own bookkeeping (phase, vitals,
// mental status, exam findings, intervention log). The learner should
// not see it, but the sim needs it in history, so the proxy stores the
// full reply in the session and returns a stripped display version.
//
// Observed formats (both tools):
//   **State:**
//   timestamp_or_phase: pre-movement (start phase)
//   vitals unchanged: ...
//   mental_status unchanged
//   key_exam_findings unchanged
//   brief_intervention_log: ...
// and the Role1 variant with unlabeled fields:
//   timestamp: Start
//   vitals: HR 118, BP 90/58
//   mental_status: alert
//   key_exam_findings: ...
//   urine_output_if_relevant: ...
//   brief_intervention_log: ...
// The model also renders the same fields as title-case labels with
// spaces ("Mental status:", "Key exam findings:", "Brief intervention
// log:"), sometimes under a bare phase heading ("Pre-movement",
// "Loading", "Airborne"). All of these are the same block, so matching
// is case-insensitive with spaces and underscores equivalent, and bare
// phase headings are stripped too. Only the heading and those field
// lines are removed; narrative prose (including an "Additional data
// now available:" list) is kept.

// Field names, longest first so "timestamp_or_phase" matches before
// "timestamp".
const STATE_FIELDS = [
  'timestamp_or_phase',
  'timestamp',
  'vitals',
  'mental_status',
  'key_exam_findings',
  'brief_intervention_log',
  'transport_constraints_if_relevant',
  'transport_constraints_if_applicable_under_policy',
  'urine_output_if_relevant',
];

const FIELD_LABELS = {
  timestamp_or_phase: 'Phase',
  timestamp: 'Phase',
  vitals: 'Vitals',
  mental_status: 'Mental status',
  key_exam_findings: 'Key findings',
  brief_intervention_log: 'Interventions',
  transport_constraints_if_relevant: 'Transport constraints',
  transport_constraints_if_applicable_under_policy: 'Transport constraints',
  urine_output_if_relevant: 'Urine output',
};

// A state-block heading: a line that is only the word "State" with
// optional markdown bold / heading marks and a colon, in either order
// ("**State:**", "**State**:", "State:"). Anything else on the line
// (e.g. "State your plan") is narrative, not a heading.
function isStateHeading(line) {
  return /^\s*#{0,3}\s*\*{0,2}\s*state[\s*:]*$/i.test(line);
}

// Parse one line as a state-field line. Returns { field, value } or null.
// Forms handled: "vitals: ...", "vitals unchanged: ...",
// "mental_status unchanged", "**vitals:** ...", and the title-case
// renderings ("Mental status:", "Key exam findings:",
// "Brief intervention log:"). Matching is case-insensitive with
// spaces and underscores equivalent.
function parseStateFieldLine(line) {
  const t = line.trim().replace(/^[#*\s]+/, '').trim();
  if (!t) return null;
  for (const field of STATE_FIELDS) {
    // The field name with each underscore matching either an underscore
    // or a space, followed by a colon, a bold marker, the word
    // "unchanged", or the end of the line — so a narrative sentence
    // starting with a field word ("Vitals remain stable") is not
    // mistaken for a state line.
    const pattern = new RegExp(
      `^${field.replace(/_/g, '[ _]')}(?=$|[:*]|\\s+unchanged\\b)`,
      'i',
    );
    const m = pattern.exec(t);
    if (!m) continue;
    // A closing bold marker may sit before the colon ("**vitals**: ...")
    // or after it ("**vitals:** ..."); drop it either way.
    const rest = t.slice(m[0].length).replace(/^\*+/, '');
    if (rest === '') return { field, value: '' };
    if (/^:/.test(rest)) {
      const value = rest.slice(1).trim().replace(/^\*+/, '').trim();
      return { field, value };
    }
    const u = /^\s+unchanged\b\s*:?\s*(.*)$/i.exec(rest);
    if (u) {
      const value = u[1] ? u[1].trim().replace(/^\*+/, '').trim() : 'unchanged';
      return { field, value };
    }
    return null;
  }
  return null;
}

// Phase labels the model uses as bare headings above a state block
// ("Pre-movement", "Loading", "Airborne"). A line that is only one of
// these (with optional markdown or a trailing colon) is a block heading,
// not narrative. Returns the label, or null.
const PHASE_HEADINGS = [
  'pre-movement',
  'loading',
  'airborne',
  'en route',
  'approach / handoff',
  'approach',
  'handoff',
];

function isPhaseHeading(line) {
  const t = line.trim().replace(/^[#*\s]+/, '').replace(/[*:\s]+$/, '').trim();
  if (!t) return null;
  const hit = PHASE_HEADINGS.find((p) => p.toLowerCase() === t.toLowerCase());
  return hit || null;
}

// Short readable status line derived from the stripped field lines, used
// only when stripping would otherwise leave an empty reply.
function stateBlockSummary(strippedLines, phase) {
  const parts = [];
  if (phase) {
    parts.push(`Phase: ${phase.charAt(0).toUpperCase() + phase.slice(1)}`);
  }
  for (const line of strippedLines) {
    const parsed = parseStateFieldLine(line);
    if (!parsed) continue;
    const label = FIELD_LABELS[parsed.field] || parsed.field;
    parts.push(`${label}: ${parsed.value || 'unchanged'}`);
  }
  if (parts.length === 0) return 'Status update received. No new findings.';
  return `Status update — ${parts.join('. ')}.`;
}

// Remove the state block (heading + field lines) from a reply, keeping
// narrative prose. If nothing with real content remains, fall back to a
// short readable status line derived from the block instead of an
// empty message. Replies with no state block are returned unchanged.
function stripStateBlock(reply) {
  if (typeof reply !== 'string') return reply;
  const kept = [];
  const stripped = [];
  let phase = null;
  for (const line of reply.split('\n')) {
    if (isStateHeading(line)) { stripped.push(line); continue; }
    const phaseLabel = isPhaseHeading(line);
    if (phaseLabel) { stripped.push(line); phase = phase || phaseLabel; continue; }
    if (parseStateFieldLine(line)) { stripped.push(line); continue; }
    kept.push(line);
  }
  const out = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  // Real content remains (at least one letter or digit): keep it.
  if (/[A-Za-z0-9]/.test(out)) return out;
  // Nothing real left. If a state block was stripped, summarise it;
  // otherwise return the reply untouched.
  if (stripped.some((line) => parseStateFieldLine(line) || isPhaseHeading(line))) {
    return stateBlockSummary(stripped, phase);
  }
  return reply;
}

module.exports = { stripStateBlock, parseStateFieldLine, isStateHeading, isPhaseHeading };
