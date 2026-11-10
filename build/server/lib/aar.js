'use strict';
// AAR (After Action Report) handling.
//
// Two parts:
//   1. parseAarBlock(reply) — detect the model's fenced ```json payload block
//      (exactly the keys certification_level, experience, scenario_id,
//      scenario_title, aar_text) in a chat reply.
//   2. requestAar(payload) — PII-scrub + normalise + POST exactly those 5
//      fields to the AAR service, which returns { learner_id, download_url }.
//
// The AAR service was probe-confirmed working 2026-11-09:
//   POST {AAR_SERVICE_URL}/generate-aar -> 200 { learner_id, download_url }
//   download at {AAR_SERVICE_URL}{download_url}.
// It takes NO learner_id input — the service generates it.

const config = require('./config');

const AAR_KEYS = ['certification_level', 'experience', 'scenario_id', 'scenario_title', 'aar_text'];
const AAR_KEYS_SORTED = [...AAR_KEYS].sort();

const EXPERIENCE_MAP = {
  beginner: 'novice',
  novice: 'novice',
  intermediate: 'intermediate',
  expert: 'experienced',
  experienced: 'experienced',
};

function normalizeExperience(value) {
  const v = String(value || '').trim().toLowerCase();
  return EXPERIENCE_MAP[v] || v;
}

// Parse a fenced ```json block with exactly the 5 AAR keys.
// Returns the payload object, or null if no such block is present.
// A block with extra/missing keys is NOT treated as a payload (the model
// is instructed to emit exactly these keys).
function parseAarBlock(reply) {
  if (typeof reply !== 'string') return null;
  const fence = /```json\s*([\s\S]*?)```/gi;
  let m;
  while ((m = fence.exec(reply)) !== null) {
    let obj;
    try {
      obj = JSON.parse(m[1]);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) continue;
    const keys = Object.keys(obj).sort();
    if (keys.length === AAR_KEYS_SORTED.length
      && keys.every((k, i) => k === AAR_KEYS_SORTED[i])
      && typeof obj.aar_text === 'string' && obj.aar_text.trim()) {
      return {
        certification_level: String(obj.certification_level),
        experience: String(obj.experience),
        scenario_id: String(obj.scenario_id),
        scenario_title: String(obj.scenario_title),
        aar_text: obj.aar_text,
      };
    }
  }
  return null;
}

function stripAarBlock(reply) {
  return reply.replace(/```json\s*[\s\S]*?```/g, '').replace(/\n{3,}/g, '\n\n').trim();
}

// Best-effort PII scrub of aar_text before it leaves the server. The model
// is also instructed (system prompt) not to include PII in the first place;
// this is a safety net, not a guarantee — see README. Patterns covered:
// email addresses, phone numbers (international + NANP), SSN-style numbers,
// dates of birth written as DOB, and "Name:"-style labelled name lines.
// Free-text personal names cannot be reliably detected by regex and are
// NOT scrubbed here — that is why the no-PII instruction to the model
// matters.
function scrubPii(text) {
  if (typeof text !== 'string') return text;
  let out = text;
  out = out.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email removed]');
  out = out.replace(/\+?\d[\d\s().-]{7,}\d/g, (m) => {
    const digits = m.replace(/\D/g, '');
    // Only scrub strings that look like phone numbers (7-15 digits, and
    // not a plausible vital sign / year / dose already in context).
    return digits.length >= 7 && digits.length <= 15 ? '[phone removed]' : m;
  });
  out = out.replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[ID removed]');
  out = out.replace(/\b(?:DOB|date of birth)\s*[:=]?\s*[^\n,;]{1,40}/gi, 'DOB: [removed]');
  out = out.replace(/^(?:learner|student|patient|provider)\s+name\s*[:=].*$/gim,
    (line) => line.replace(/[:=].*$/, ': [removed]'));
  return out;
}

async function requestAar(payload) {
  const body = {
    certification_level: payload.certification_level,
    experience: normalizeExperience(payload.experience),
    scenario_id: payload.scenario_id,
    scenario_title: payload.scenario_title,
    aar_text: scrubPii(payload.aar_text),
  };
  const res = await fetch(`${config.aarServiceUrl}/generate-aar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`AAR service error ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
  }
  const downloadUrl = typeof data.download_url === 'string' && data.download_url.startsWith('http')
    ? data.download_url
    : `${config.aarServiceUrl}${data.download_url || ''}`;
  return { learner_id: data.learner_id, download_url: downloadUrl };
}

module.exports = { parseAarBlock, stripAarBlock, scrubPii, normalizeExperience, requestAar, AAR_KEYS };
