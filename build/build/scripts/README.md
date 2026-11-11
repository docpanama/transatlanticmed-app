# Vector-store setup — README

One script, run once by the owner on his own computer:

```
node setup-vector-stores.mjs <pfc-sources-folder> <foxtwo-sources-folder>
```

It uploads each tool's source PDFs to OpenAI and creates two vector stores
(one per tool) for OpenAI file search. It prints the two store IDs, which go
into Render as `ROLE1_VECTOR_STORE_ID` and `FOXTWO_VECTOR_STORE_ID`.

## Prerequisites

- **Node.js 24 or newer.** Check with `node --version`. No packages to
  install — the script uses only Node's built-in `fetch`, `FormData`, and
  `Blob`. (It deliberately does **not** use the `openai` npm package, so
  there is nothing to `npm install`.)
- **An OpenAI API key** with billing enabled (see the deployment checklist,
  step 1). The key is read **only** from the `OPENAI_API_KEY` environment
  variable. It is never a command-line argument, never written to a file,
  and never printed.
- **The two source folders downloaded from Google Drive:**
  - `GPT_dev_files/PFC Sources` (Role1's 11 files)
  - `GPT_dev_files/FoxTwo_sources` (FoxTwo's 9 files)
  - Download each folder as-is — do not rename any file. The script matches
    exact filenames from each tool's source table and warns loudly about
    anything missing.

## Run it

```bash
export OPENAI_API_KEY="sk-..."
node setup-vector-stores.mjs ~/Downloads/"PFC Sources" ~/Downloads/FoxTwo_sources
```

One-folder form (if both subfolders sit under one parent):

```bash
node setup-vector-stores.mjs ~/Downloads/GPT_dev_files
```

First do a dry run to check your downloads — it calls no API and spends
nothing:

```bash
node setup-vector-stores.mjs --dry-run ~/Downloads/"PFC Sources" ~/Downloads/FoxTwo_sources
```

Options: `--role1-only`, `--foxtwo-only`, `--dry-run`,
`--prefix <name>` (names the stores e.g. `v2 Role1` when re-running after a
CPG update — useful to tell old and new stores apart in the dashboard).

## What it does, step by step

1. Checks every expected filename in each folder. Missing files are listed
   as warnings and the store is built **without** them — the summary at the
   end repeats the missing list, so re-download the files and re-run.
2. Uploads each present file with `POST /v1/files` (`purpose="assistants"`).
3. Creates the store with `POST /v1/vector_stores` (name `Role1` / `FoxTwo`).
4. Attaches all files in one batch
   (`POST /v1/vector_stores/{id}/file_batches`) and polls the batch until
   indexing completes (up to 30 minutes; the CCT textbook is large).
5. Prints the per-file indexing result and the two store IDs for Render.

## File lists (exact — from each tool's source table)

**Role1 store — 14 files** (all in `PFC Sources`): the PFC Working Group
position paper, TCCC Guidelines (25 Jan 2024), Documentation PFC, Damage
Control Resuscitation PFC, Traumatic Brain Injury PFC, Airway Management in
Trauma, Nursing Interventions PCC, Wound Management PFC, Burn Management
PFC, `prolongedcare.pdf`, Prolonged Casualty Care Guidelines (21 Dec 2021), plus the how-to-use and what-is docs (`!HOW TO USE THE PFC-EDGE AUSTERE CARE SIMULATOR.docx`, `!WHAT_IS_ROLE1_GPT.docx`) and the student-instructions doc (`!PFC-EDGE_STUDENT_INSTRUCTIONS.docx`).

**FoxTwo store — 12 files** (all in `FoxTwo_sources`): `00 FY 26 SMOG.pdf`,
CoERCCC Guidelines FY26, Interfacility Transport CoERCCC OPG, Analgesia and
Sedation Management during PFC, Damage Control Resuscitation PFC,
Mechanical Ventilation CPG (10 Mar 2025), Sepsis Management PFC, Traumatic
Brain Injury PFC, `Critical Care Transport 3rd Edition.pdf`, plus the how-to-use and what-is docs (`!HOW TO USE THE FoxTwo.GPT CCT-EDGE TRANSPORT SIMULATOR.docx`, `!What Is FoxTwo.GPT.docx`) and the student-instructions doc (`!CCT-EDGE_STUDENT_INSTRUCTIONS.docx`).

Deliberately **not** included: the rest of the bulk JTS CPG library in Drive
(`Current_JTS_CPGs_A-H` / `_I-Z`). Each tool's prompt defines its own source
subset; the folders hold the full library behind them. (One extra file,
Crush Syndrome, sits in `PFC Sources` but is not in Role1's 11 — it is not
uploaded.) The student-instructions docs (originals) ARE included in the
stores; the revised landing-page versions are the website pages in
`build/web/docs/`.

## The CCT textbook (~73 MB) — limits check

Verified against OpenAI's public API reference (2026-11-10): the per-file
upload limit is **512 MB**, and each file may contain up to **5,000,000
tokens**. At ~73 MB the textbook is well inside the size limit, so no
splitting is needed up front. Two caveats:

- If the textbook is unusually text-dense it could approach the 5M-token
  ceiling. The script reports per-file indexing status at the end — if the
  textbook shows `failed`, that is the likely cause.
- **Fallback if it fails to index:** split the PDF into chapters (any PDF
  tool), place the chapter PDFs in the folder, add their filenames to the
  `FOXTWO_FILES` list at the top of the script, and re-run. A re-run creates
  a fresh store — update `FOXTWO_VECTOR_STORE_ID` in Render afterwards.

## If a file fails to index

The script names the failed file at the end. Common causes: a corrupt or
password-protected PDF, or the 5M-token ceiling above. Fix or split the file
and re-run — re-running always creates a **new** store, so remember to update
the Render env var to the new ID (and delete the old store at
platform.openai.com → Storage → Vector stores once the new one is live).

## Endpoints used (verified 2026-11-10)

Base: `https://api.openai.com/v1` — OpenAI API reference
(`developers.openai.com/api/docs/guides/tools-file-search` and the API
reference pages for Files and Vector Stores):

| Call | Purpose |
|---|---|
| `POST /v1/files` | Upload one PDF (`purpose="assistants"`, multipart) |
| `POST /v1/vector_stores` | Create a store (`{"name": "Role1"}` / `{"name": "FoxTwo"}`) |
| `POST /v1/vector_stores/{id}/file_batches` | Attach all uploaded files at once |
| `GET /v1/vector_stores/{id}/file_batches/{batch_id}` | Poll indexing status |
| `GET /v1/vector_stores/{id}/files` | Final per-file indexing verdict |

Assumption documented: the script uses the plain REST API with native
`fetch` rather than the `openai` SDK, so the endpoint paths above are the
contract. If OpenAI changes them, the script fails with the API's error
message naming the bad endpoint — check the reference pages above.

## Cost

Uploads and vector-store storage for ~20 PDFs are a few dollars at most;
file-search usage is billed per 1,000 calls plus storage. Watch the first
OpenAI invoice after go-live and adjust the spending limit if needed.
