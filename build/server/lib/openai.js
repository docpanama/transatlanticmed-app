'use strict';
// OpenAI client — isolated in this one module so the request shape is easy
// to correct if OpenAI changes it.
//
// VERIFIED against OpenAI's public docs (2026-11-10, developers.openai.com):
//   POST https://api.openai.com/v1/responses
//   {
//     "model": "gpt-5.4",
//     "instructions": "<system prompt>",          // system-level instructions
//     "input": [ { "role": "user",
//                  "content": [{ "type": "input_text", "text": "..." }] } ],
//     "tools": [{ "type": "file_search",
//                 "vector_store_ids": ["vs_..."], "max_num_results": 5 }],
//     "max_output_tokens": 4096,
//     "temperature": 0.3                         // see note below
//   }
//   Response: JSON with `output` — an array of items; the assistant's text
//   is in items of type "message" -> content[] of type "output_text" -> text.
//   (The SDK also exposes this as response.output_text; raw REST does not.)
//
// Temperature caveat (documented assumption, not verified live — no API key
// exists yet): GPT-5-family reasoning models are documented in third-party
// integration notes as rejecting a non-default temperature (only 1 is
// accepted). The settled decision is temperature 0.3, so this module SENDS
// it when OPENAI_TEMPERATURE is set, but if OpenAI answers 400 and the
// error mentions temperature, it retries once WITHOUT temperature and logs
// a warning. If OPENAI_TEMPERATURE is unset, temperature is omitted
// entirely (the safe default for gpt-5.4). Either way a live call is needed
// to confirm which behaviour gpt-5.4 actually has.

const config = require('./config');

const OPENAI_URL = 'https://api.openai.com/v1/responses';

function extractText(data) {
  if (typeof data.output_text === 'string' && data.output_text) return data.output_text;
  const chunks = [];
  for (const item of data.output || []) {
    if (item.type !== 'message' || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (part.type === 'output_text' && typeof part.text === 'string') chunks.push(part.text);
    }
  }
  return chunks.join('');
}

async function callResponsesOnce({ instructions, input, vectorStoreId, temperature }) {
  const body = {
    model: config.openaiModel,
    instructions,
    input,
    max_output_tokens: config.openaiMaxOutputTokens,
  };
  if (temperature !== null && temperature !== undefined) body.temperature = temperature;
  if (vectorStoreId) {
    body.tools = [{
      type: 'file_search',
      vector_store_ids: [vectorStoreId],
      max_num_results: 5,
    }];
  }

  const res = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.openaiApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data.error && data.error.message) || `OpenAI API error ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return extractText(data);
}

// history: [{ role: 'user'|'assistant', content: string }, ...]
// Returns the assistant's reply text.
async function chatCompletion({ instructions, history, vectorStoreId }) {
  // The Responses API distinguishes content by role: user messages carry
  // input_text, assistant messages carry output_text. Sending an assistant
  // message as input_text is a 400 — which broke every second turn (turn 1
  // has only a user message, so it worked; turn 2 includes the sim's reply).
  const input = history.map((m) => ({
    role: m.role,
    content: [{ type: m.role === 'assistant' ? 'output_text' : 'input_text', text: m.content }],
  }));
  const temperature = config.openaiTemperature;
  try {
    return await callResponsesOnce({ instructions, input, vectorStoreId, temperature });
  } catch (err) {
    // GPT-5 reasoning models reject non-default temperature: retry once
    // without it rather than failing the whole turn.
    if (err.status === 400 && temperature !== null
      && /temperature/i.test(err.message || '')) {
      console.warn('[openai] temperature rejected by model; retrying without temperature');
      return await callResponsesOnce({ instructions, input, vectorStoreId, temperature: null });
    }
    throw err;
  }
}

module.exports = { chatCompletion, extractText };
