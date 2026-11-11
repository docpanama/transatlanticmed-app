# Prompt composition notes — FoxTwo system prompt & Role1 API adaptation

Prepared 2026-11-09. Decisions referenced are the settled decisions in `decision-sheet-2026-11-08.md` (#2 OpenAI, #3 reuse AAR service, #4 shared 5-section `aar_text`, #5 owner uploads CPGs, #6 how-to-use guide canonical, #7 layered FoxTwo prompt on Role1's structure; model gpt-5.4, temp 0.3, max output 4,096 tokens).

## Key composition choices — FoxTwo prompt

- **Base + layers, on Role1's skeleton.** The recovered FoxTwo doc is the base; Core Rules v1.0 and System Context v1.0 are layered in as engine rules; the whole thing is structured on the Role1 prompt's section order (CORE ROLE → … → PII POLICY → EXPERIENCE NORMALIZATION), with FoxTwo-unique sections added where the Role1 skeleton has no home for them (PRE-SCENE GATE, TRANSPORT PHASE MODEL, ENVIRONMENT CONSTRAINTS (HH-60), PROCEDURAL FRICTION, ERROR PROPAGATION, AI UTILIZATION TRACKING, AUTHORITY HIERARCHY).
- **Authority hierarchy stated in the prompt itself** (Core Rules > JSON directive > System Context > user), per Core Rules #1. The JSON directive sits above System Context because the scenario data is authoritative for that run.
- **Pre-scene gate moved to the app UI.** Core Rules #2 / System Context §4B require certification level + experience before any scenario content is revealed. In the web app the start screen collects these, so the prompt states they are provided by the application at session start, tells the model not to ask for them in chat, and not to proceed if they are missing. The model never collects them.
- **AAR is two artifacts.** The human-readable AAR shown in chat uses the Core Rules #16 structure (timeline, interventions, monitoring/trends, transport management quality, contingency planning, errors/delays, outcome, AI utilization analysis) and keeps the transport-specific assessment. The machine payload `aar_text` uses exactly the decided 5 sections, in order, with the neutral-language rule. Same split as Role1 (whose human-readable AAR carries teleconsult / evacuation strategy).
- **AAR mechanism identical in both prompts.** At completion: display human-readable AAR → display exactly "Your AAR is ready. Approve the next prompt to generate your downloadable report." → output a fenced ```json block with exactly the 5 keys (`certification_level`, `experience`, `scenario_id`, `scenario_title`, `aar_text`). The application calls the AAR service after user approval; the model must NOT claim it called anything. After the service responds the application displays "Scenario complete. Learner ID: {learner_id}. Download AAR (.docx): https://fox-two-aar.onrender.com{download_url}". The old `generateAAR` action-call wording and the stale `cct_experience_level` field (only in `instructions_v1`) are gone; the live field is `experience`.
- **FoxTwo identity kept distinct from Role1.** "Not a decision tool. No direct treatment orders." — non-directive language, transport physiology + CPG/SMOG/CoERCCC, sim output field `transport_constraints_if_relevant`, guidance gate includes transport readiness, sim exit on transport endpoints (arrival + coherent handoff, diversion/abort, death, endpoint reached).
- **Content focus + preceptor tone carried over from `instructions_v1`** (airway/RSI, vent, hemodynamics, sedation, trauma, blood, packaging, transport physiology, equipment; experienced flight-medic preceptor tone) — the only place that material lives.
- **Sources table:** taken from the recovered doc, names normalized (FoxTwo, CCT_EDGE, PFC_EDGE). The `!READ_ME_FIRST_CCT Sim Instructions_all_levels_v1.docx` row was removed — READ_ME_FIRST is retired, per the 2026-11-09 supporting-docs decision.
- **Experience normalization** (beginner→novice, intermediate→intermediate, expert→experienced) was carried over from Role1 into the FoxTwo prompt. The recovered FoxTwo doc does not state it, but the section was specified for the composition and the `experience` field is shared with the same service.

## Tensions resolved

1. **Learner level — resolved in favor of the recovered doc: do NOT adjust by learner level.**
   The recovered doc says "Do not adjust based on learner level"; `instructions_v1` says the same for difficulty; but System Context §4B (cognitive offloading) and §11 say the system "adapts prompting intensity / guidance structure / expectation of autonomy" to the declared level, and decision #7's tension note flagged exactly this. Resolution: no adjustment, stated explicitly in DIFFICULTY ("Do not adjust based on learner level… Difficulty must emerge from patient physiology, scenario injects, resource limitations, and time pressure — not from model assistance"). The declared level is still collected (pre-scene gate) because it is a required AAR field, but it must not change model behavior. If the owner later wants scaffolding-by-level, that is a deliberate reversal of this call, not a silent drift.
2. **Time control — resolved as compatible: time advances only on user cue, and reassessment / intervention declaration / explicit time request / phase transition all count as user cues.**
   The recovered doc says "Advance ONLY on user cue"; Core Rules #5 / System Context §4A list the four cue types. These read as the same rule with the cue types spelled out, so the prompt lists all four explicitly (including reassessment phrases such as "repeat vitals" / "check patient", which matches how Role1 treats reassessment triggers — the difference is only that Role1's list is phrased as triggers while FoxTwo's is phrased as cues; behaviorally they now match).

## Ambiguous or contradictory items in the source docs

- **AAR section count: "9-section" vs 8 listed items.** Core Rules #16 is described as a 9-section AAR, but it enumerates 8 items (timeline of decisions; interventions; monitoring and trends; transport management quality; contingency planning; errors and delays; outcome; AI utilization analysis). The FoxTwo prompt lists those 8. The ninth section is not identified anywhere in the sources — owner to confirm whether one is missing (e.g. a separate "transport phase decisions" or "destination/handoff" section) or whether "9" is a miscount.
- **Old `instructions_v1` AAR PII block invents a `student_name` field** ("generate a random 4-digit number for `student_name`") that does not exist in the live API's 5 fields and contradicts the recovered doc ("NO extra fields, NO PII"). Dropped; the live API generates `learner_id` itself (probe-confirmed).
- **`instructions_v1` and the recovered doc disagree on the AAR display line.** The old override block omits "Learner ID:" from the post-response display; the recovered doc and the Role1 prompt include it. Included it — it matches the live API response.
- **Role1 source typo:** the source opens "ou are a clinical decision-support assistant…" (missing "Y"). Fixed to "You are…" in the Role1 prompt; flagged here in case the source text is the reference.
- **Role1 source SOURCES note** says "These are the 11 documents available to me in this GPT's supplied resources" — left as-is (the "GPT" there refers to the supplied-resources origin, not a user-facing product name). Owner may want it reworded in a later pass.
- **"Do not adjust based on user level" appears in Role1's DIFFICULTY section and in FoxTwo's**, but Role1's TIME CONTROL advances on reassessment phrases while FoxTwo's TIME CONTROL (recovered doc) says user cue only — now reconciled as above; no behavioral difference remains between the two prompts on time.

## Deliberately left out, and why

- **Template Spec** — authoring reference for scenario writers (JSON schema / authoring rules), not runtime behavior. Excluded from both prompts per decision #7.
- **`instructions_v1`'s stale `cct_experience_level` field** — superseded by the live API field `experience` (recovered doc + probe). Not used anywhere.
- **READ_ME_FIRST references** — retired per the 2026-11-09 supporting-docs decision; removed from the FoxTwo sources table rather than fulfilled.
- **The old `base instructions.docx` / `new instructions.docx` Role1 texts** — superseded by the canonical `role1_gpt_instructions.txt`. Not used.
- **System Context §2–§3 architecture / file-system description** (two-layer GPT→JSON architecture, file types A/B/C) — describes how the system is built, not how the model should behave at runtime; the behavioral content (time model, friction, phases, evaluation) was carried in, the plumbing description was not.
- **Core Rules #22 version control and System Context §15 versioning philosophy** — process rules for scenario authors, not model behavior. Not included.
- **No new clinical content invented.** Where the sources were silent (e.g. Role1 has no defined human-readable AAR section list), the prompt says only what the decisions support and flags the gap here rather than inventing structure.

## Things the owner still needs to decide / confirm

- The AAR 9th section (see above) — is one missing, or is "9" a miscount?
- Whether the FoxTwo EXPERIENCE NORMALIZATION carry-over is wanted (the recovered doc never stated it).
- Whether the Role1 SOURCES note's "in this GPT's supplied resources" wording should be reworded for the post-GPT product.
- Nothing else in these two prompts is blocked on the owner; both are ready for the proxy/app build.
