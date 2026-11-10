# Clinical decision tools — proxy (backend)

Node.js + Express server for the **Role1 / PFC_EDGE** and **FoxTwo / CCT_EDGE**
clinical decision tools (rebuild of the former custom GPTs, which OpenAI
retires Dec 11, 2026). It serves scenario metadata, runs chat sessions
against the OpenAI Responses API with file search, and generates AAR
reports through the `fox-two-aar` service.

Run it with no front end and it still works: `node server.js` also serves
`../web` statically, so it is a full local demo once the front end exists.

## Quick start

```bash
cd build/server
npm install
cp .env.example .env   # then fill in OPENAI_API_KEY and the vector store IDs
node server.js          # listens on http://localhost:3000 by default
```

No API key is required to start the server or browse scenarios; only
`/api/chat` needs one (it returns HTTP 503 without it).

## Environment variables

| Variable | Required | Default | Notes |
|---|---|---|---|
| `OPENAI_API_KEY` | for chat | — | Never commit it. Without it, `/api/chat` returns 503 `"OpenAI API key not configured on the server"`. |
| `ROLE1_VECTOR_STORE_ID` | no | — | OpenAI vector store holding Role1's CPGs/sources; used as `file_search` `vector_store_ids`. Blank = chat works without file search. |
| `FOXTWO_VECTOR_STORE_ID` | no | — | Same, for FoxTwo. |
| `PORT` | no | `3000` | |
| `OPENAI_MODEL` | no | `gpt-5.4` | Settled decision (temp 0.3, max output 4,096 tokens). |
| `OPENAI_TEMPERATURE` | no | *(unset)* | Only sent when set; see "OpenAI request shape". |
| `OPENAI_MAX_OUTPUT_TOKENS` | no | `4096` | |
| `AAR_SERVICE_URL` | no | `https://fox-two-aar.onrender.com` | AAR report service. |

## API contract (what the front end implements against)

### `GET /health`
```json
{ "status": "ok", "prompts_ok": true, "openai_configured": false, "scenarios_loaded": 6 }
```
`prompts_ok` is false until `../prompts/role1_system_prompt.md` and
`../prompts/foxtwo_system_prompt.md` exist (a sibling workstream composes
them). The server still starts without them.

### `GET /api/scenarios?tool=role1|foxtwo`
Metadata only — never raw scenario JSON, never hidden state:
```json
[{ "id": "pfc-s1", "title": "The Delayed Evacuation", "level": "Basic",
   "description": "Sepsis + Prolonged Stabilization + Telemedicine Friction" }]
```
Scenario ids: `pfc-s1`, `pfc-s2`, `pfc-s3`, `cct-s1`, `cct-s2`, `cct-s3`.

### `POST /api/session`
```json
{ "tool": "role1", "scenario_id": "pfc-s2",
  "certification_level": "Paramedic", "experience": "beginner" }
```
→
```json
{ "session_id": "<uuid>", "vignette": "<student-facing vignette text>",
  "greeting": "You are on scene — The Hypoxic Patient at Hour 14. …" }
```
**CDT mode:** send `"scenario_id": null` for clinical decision support with
no scenario. The session starts with no scenario JSON loaded, `vignette`
is `null`, and the greeting invites the user to describe the clinical
situation. A null `scenario_id` is never rejected; only an unknown
non-null id returns 400. `experience` is stored normalised
(beginner→novice, intermediate→intermediate, expert→experienced).

### `POST /api/chat`
```json
{ "session_id": "<uuid>", "message": "I check the airway…" }
```
→ `{ "reply": "…", "aar_pending": false }`. History is kept server-side
per session. When the model ends a scenario it appends a fenced ` ```json `
block with exactly `certification_level, experience, scenario_id,
scenario_title, aar_text`; the server strips the block from the displayed
reply, holds the payload pending approval, sets `aar_pending: true`, and
the reply includes the exact line:
`Your AAR is ready. Approve the next prompt to generate your downloadable report.`

Without an API key: HTTP 503 `{ "error": "OpenAI API key not configured on the server" }`.

### `POST /api/aar`
```json
{ "session_id": "<uuid>" }
```
→ `{ "learner_id": "9EBA", "download_url": "https://fox-two-aar.onrender.com/download/9EBA.docx" }`
Only works while a payload is pending (single use); otherwise 400
`"No AAR is pending for this session yet — finish the scenario first"`.
The server PII-scrubs `aar_text` first (best-effort regex — see below),
normalises `experience`, and POSTs exactly the 5 fields to the AAR service.

## How it is put together

```
server.js            Express app, routes, in-memory session Map
lib/config.js        env vars (no secrets logged or returned)
lib/scenarios.js     loads the 6 JSONs, merges both packaging shapes
lib/directive.js     compiles directive blocks into model prompt text
lib/prompts.js       reads ../prompts/*.md at startup (missing = prompts_ok:false)
lib/openai.js        the ONE place that calls OpenAI (Responses API + file search)
lib/aar.js           AAR payload-block parsing, PII scrub, AAR service client
scenarios/           copies of the 6 production JSONs + *.vignette.txt
test/local-checks.js `npm test` — loader, compiler, AAR parsing, scrub (no key needed)
```

### Scenario loader — two shapes
The source files package engine blocks two ways, and the loader accepts
both (verified by `npm test`):
- PFC S1/S3 (v1.3.2): blocks nested under `directive` (`directive.engine_rules`, …).
- PFC S2 (v1.3.3) and all CCT scenarios: the same blocks at **top level**,
  alongside a slimmer `directive`. The loader merges both locations
  (`directive` wins on a shared key). Note the task brief's stated source
  filenames (`PFC_SIM_S*_production…`) do not match the files actually in
  `source/` / `source-cct/`; the copies here come from the real files
  (`pfc-sim-s1-v1.3.2.min.json`, `pfc-sim-s2-v1.3.3.pretty.json`,
  `pfc-sim-s3-v1.3.2.min.json`, `CCT_SIM_S{1,2,3}_production.v*.min.json`),
  byte-identical copies (md5-checked for pfc-s1).

### Vignettes
Extracted with python-docx from the `.docx` files for PFC S1–S3 and CCT S1.
**CCT vignettes 2 and 3 have no `.docx` in `source-cct/`** (only Vignette 1
exists there); their text comes from the recovered plain-text copies in
`source-docs/cct_vig2.txt` / `cct_vig3.txt` (recovered from Google Docs
2026-11-08). If the real CCT vignette 2/3 `.docx` files surface later,
re-extract and replace `cct-s2.vignette.txt` / `cct-s3.vignette.txt`.
The vignette IS shown to the student at session start; the JSON hidden
state NEVER leaves the server.

### Directive compiler
`lib/directive.js` renders the merged engine blocks (state, time control,
data release, guidance gating, injects with triggers + state updates,
evaluation design, resolution hooks, output format, termination) as prompt
text for the model. A recursive denylist strips `hidden_state`,
`true_problem_set`, `anchors`, `discovery_nodes`, `latent_risks`,
`primary_transport_killer`, `arrest_risk_pathway`, `reversibility`,
`source_control_pressure`, `shock_path`, `hypoglycemia`,
`background_instability_driver`, `raw`, `debug_policy`, etc. before
anything is rendered. Evaluation criteria (decision points / cognitive
traps) are included — they tell the model what to assess, not the student
what the answer is.

### PII
`aar_text` is scrubbed before it is sent to the AAR service: email
addresses, phone numbers, SSN-style numbers, `DOB:` lines, and labelled
name lines are replaced. This is best-effort regex only — free-text
personal names cannot be reliably detected that way — so the system
prompts also instruct the model never to include PII. That instruction is
the primary control; the scrub is the safety net.

## OpenAI request shape (verified, with one documented assumption)

Verified 2026-11-10 against OpenAI's public docs
(`developers.openai.com` — File Search guide and Responses API reference):
`POST https://api.openai.com/v1/responses` with
`model`, `instructions` (system prompt + compiled directive + session
context), `input` (array of `{ role, content: [{ type: "input_text",
text }] }`), `tools: [{ type: "file_search", vector_store_ids: ["vs_…"],
max_num_results: 5 }]` (only when a vector store id is configured), and
`max_output_tokens`. The reply text is extracted from `output[]` items of
type `message` → `content[]` of type `output_text` → `text`. All of this
lives in `lib/openai.js` so it is easy to correct.

**Assumption — temperature:** the settled decision is temperature 0.3, but
third-party GPT-5 integration notes say GPT-5-family reasoning models
reject a non-default temperature (only 1 accepted). This was **not**
verifiable without an API key. Handling: `OPENAI_TEMPERATURE` is only sent
when explicitly set; if OpenAI answers 400 mentioning temperature, the
call is retried once without it (logged as a warning). A live call with a
real key is needed to confirm which behaviour `gpt-5.4` actually has.

## Local test results (2026-11-10, no API key — live OpenAI calls NOT tested)

`npm test` — 13 checks passed (see `test/local-checks.js` for the list):
loader loads all 6 scenarios; both JSON shapes accepted (nested S1/S3,
top-level S2 + CCT); metadata-only listing; vignettes present for all 6;
directive compiler includes engine rules/injects/resolution hooks and
strips hidden state; AAR block parsing accepts the exact 5-key block and
rejects wrong keys; experience normalisation; PII scrub; plus the AAR
probe below.

HTTP smoke tests against a running server (no key configured):
- `GET /health` → `{"status":"ok","prompts_ok":true,"openai_configured":false,"scenarios_loaded":6}`
  (The sibling prompts workstream has since landed `../prompts/*.md`, so
  `prompts_ok` is now true; before they landed it correctly reported false
  and the server still started.)
- `GET /api/scenarios?tool=role1` → 3 scenarios; `?tool=foxtwo` → 3.
- `POST /api/session` (sim, pfc-s2) → 200 with vignette text + greeting.
- `POST /api/session` (CDT, `scenario_id: null`, both tools) → 200,
  `vignette: null`, greeting inviting the user to describe the situation.
- `POST /api/session` (unknown id) → 400; (null id) is NOT rejected.
- `POST /api/chat` → 503 `{"error":"OpenAI API key not configured on the server"}`.
- `POST /api/aar` with nothing pending → 400 with the "finish the scenario first" message.
- `POST /api/chat` with an unknown session → 404.

AAR service probe: one clearly-marked test payload was POSTed to
`POST /generate-aar` (see `test/local-checks.js`, `AAR_PROBE=1`) and
returned 200 with `learner_id=74D2` and
`download_url=https://fox-two-aar.onrender.com/download/74D2.docx` — the
AAR client works end to end. (Sent once only, as instructed, labelled TEST.)

## Still needs the owner (not completable from this workspace)

- **No OpenAI API key exists yet**, so no live chat call has been made:
  the Responses API request shape, the `gpt-5.4` temperature behaviour,
  file-search wiring, and the system prompts + compiled directive in a
  real session are all untested against the live API.
- **Vector store IDs** (`ROLE1_VECTOR_STORE_ID`, `FOXTWO_VECTOR_STORE_ID`)
  do not exist yet — the CPG/source files still need uploading to OpenAI
  and the stores creating (owner / deployment step).
- **System prompts** (`../prompts/role1_system_prompt.md`,
  `../prompts/foxtwo_system_prompt.md`) are being composed by a sibling
  workstream; until they land, `/health` reports `prompts_ok:false` and
  `/api/chat` returns 503 for that tool.
- **CCT vignettes 2/3 `.docx` files** were not in `source-cct/`; the
  `.vignette.txt` files here come from the recovered text copies (see above).
- The AAR probe above creates a real (test-marked) report on the shared
  AAR service; it was sent once only, as instructed, and is labelled TEST.
