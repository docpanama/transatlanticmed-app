#!/usr/bin/env node
/**
 * setup-vector-stores.mjs — Role1 / FoxTwo knowledge-base setup
 *
 * Creates two OpenAI vector stores (one per tool) and uploads each tool's
 * source PDFs into its store, so the Render proxy can use OpenAI file search
 * (Responses API `file_search` tool) at run time.
 *
 *   Role1 store  — 14 files (11 CPGs/guidelines + 3 supporting docs)
 *   FoxTwo store — 12 files (SMOG + CoERCCC + 5 CPGs + CCT textbook + 3 supporting docs)
 *
 * USAGE
 *   export OPENAI_API_KEY="sk-..."        # from platform.openai.com; never
 *                                          # paste it into chat, code, or a
 *                                          # file — env var only.
 *   node setup-vector-stores.mjs <pfc-sources-folder> <foxtwo-sources-folder>
 *
 *   The two folders are the local copies of the Drive folders the owner
 *   downloaded:
 *     <pfc-sources-folder>    = GPT_dev_files/PFC Sources
 *     <foxtwo-sources-folder> = GPT_dev_files/FoxTwo_sources
 *
 *   One-folder form also works: pass a folder that CONTAINS both
 *   "PFC Sources" and "FoxTwo_sources" subfolders, e.g.
 *     node setup-vector-stores.mjs ~/Downloads/GPT_dev_files
 *
 *   Options:
 *     --role1-only    only build the Role1 store
 *     --foxtwo-only   only build the FoxTwo store
 *     --dry-run       check which files are present/missing; call no API
 *     --prefix <name> prefix for the store names (default: none)
 *                     e.g. --prefix v2  ->  "v2 Role1", "v2 FoxTwo"
 *
 * WHAT IT PRINTS
 *   At the end it prints the two vector store IDs. Paste them into the
 *   Render dashboard as:
 *     ROLE1_VECTOR_STORE_ID  = vs_...
 *     FOXTWO_VECTOR_STORE_ID = vs_...
 *
 * REQUIREMENTS
 *   Node 24+ (uses native fetch / FormData / Blob — no npm install needed).
 *
 * API ENDPOINTS USED (OpenAI REST API, api.openai.com — verified against
 * OpenAI's public API reference, 2026-11-10; see README.md):
 *   POST https://api.openai.com/v1/files
 *        multipart upload, purpose="assistants"
 *   POST https://api.openai.com/v1/vector_stores
 *   POST https://api.openai.com/v1/vector_stores/{store_id}/file_batches
 *   GET  https://api.openai.com/v1/vector_stores/{store_id}/file_batches/{batch_id}
 *   GET  https://api.openai.com/v1/vector_stores/{store_id}/files
 *
 * LIMITS (OpenAI docs): individual files up to 512 MB and up to 5,000,000
 * tokens each. The CCT textbook (~73 MB) is inside the size limit; if its
 * indexing ever reports "failed", see the fallback in README.md.
 *
 * SAFETY
 *   - The API key is read ONLY from the OPENAI_API_KEY environment variable.
 *     It is never accepted as a command-line argument and is never printed.
 *   - Re-running this script creates NEW vector stores (it never edits or
 *     deletes an existing store). After a re-run, update the two Render env
 *     vars to the new IDs and restart the Render service; the old stores can
 *     then be deleted at platform.openai.com > Storage.
 */

import { existsSync, statSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";

const API_BASE = "https://api.openai.com/v1";
// OpenAI per-file upload limit (docs). Warn, don't hard-fail, just under it.
const MAX_FILE_BYTES = 512 * 1024 * 1024;
const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_MS = 30 * 60 * 1000; // 30 min; the textbook is large

// ---------------------------------------------------------------------------
// Per-tool file lists — exact filenames. Clinical sources from each tool's
// source table, PLUS all three supporting docs (how-to-use, what-is,
// student instructions) so the model understands its function (owner
// decision 2026-11-10; mirrors the original GPTs, which had these docs
// uploaded). These are the ONLY files that go into each store. Do not add
// the rest of the bulk JTS library. The how-to-use guide remains the
// canonical instruction text (decision #6); the student-instructions doc
// is the original, kept for the model's context.
// ---------------------------------------------------------------------------

const ROLE1_FILES = [
  "PFC-WG-Position-Paper-PFC-Capabilities.pdf",
  "Tactical_Combat_Casualty_Care_Guidelines_25_Jan_2024_.pdf",
  "Documentation_Prolonged_Field_Care_13_Nov_2018_ID72_v1.1_.pdf",
  "Damage_Control_Resuscitation_PFC_01_Oct_2018_ID73_.pdf",
  "Traumatic_Brain_Injury_PFC_06_Dec_2017_ID63_Rapid_Update_.pdf",
  "Airway_Management_in_Trauma_28_Jan_2026_ID39_.pdf",
  "Nursing_Interventions_PCC_08_July_2025_ID70_v1.1_.pdf",
  "Wound_Management_PFC_24_Jul_2017_ID62_.pdf",
  "Burn_Management_PFC_13_Jan_2017_ID57_.pdf",
  "prolongedcare.pdf",
  "Prolonged_Casualty_Care_Guidelines_21_Dec_2021_ID91_.pdf",
  "!HOW TO USE THE PFC-EDGE AUSTERE CARE SIMULATOR.docx",
  "!WHAT_IS_ROLE1.docx",
  "!PFC-EDGE_STUDENT_INSTRUCTIONS.docx",
];

const FOXTWO_FILES = [
  "00 FY 26 SMOG.pdf",
  "CoERCCC Guidelines FY26.pdf",
  "Interfacility_Transport_CoERCCC_OPG.pdf",
  "Analgesia_and_Sedation_Management_during_PFC_11_May_2017_ID61.pdf",
  // NOTE: in this folder the DCR/TBI files have NO trailing underscore
  // before ".pdf" (unlike the PFC copies). Names below match the files
  // as they actually sit in FoxTwo_sources (verified 2026-11-10).
  "Damage_Control_Resuscitation_PFC_01_Oct_2018_ID73.pdf",
  "Mechanical Ventilation CPG Final 10 MAR 2025.pdf",
  "Sepsis_Management_PFC_28_Oct_2020_ID83.pdf",
  "Traumatic_Brain_Injury_PFC_06_Dec_2017_ID63_Rapid_Update.pdf",
  // ~73 MB. Inside OpenAI's 512 MB per-file limit; see README.md if its
  // indexing ever fails (fallback: split into chapters and re-run).
  "Critical Care Transport 3rd Edition.pdf",
  "!HOW TO USE THE FoxTwo CCT-EDGE TRANSPORT SIMULATOR.docx",
  "!What Is FoxTwo.docx",
  "!CCT-EDGE_STUDENT_INSTRUCTIONS.docx",
];

const STORES = [
  { key: "role1", label: "Role1", envVar: "ROLE1_VECTOR_STORE_ID", files: ROLE1_FILES },
  { key: "foxtwo", label: "FoxTwo", envVar: "FOXTWO_VECTOR_STORE_ID", files: FOXTWO_FILES },
];

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fail(message) {
  console.error(`\nERROR: ${message}\n`);
  process.exit(1);
}

async function api(path, { method = "GET", body, isForm = false } = {}) {
  const headers = { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` };
  if (body && !isForm) headers["Content-Type"] = "application/json";
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body ? (isForm ? body : JSON.stringify(body)) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON error body */
  }
  if (!res.ok) {
    const detail = json?.error?.message ?? text.slice(0, 500);
    fail(`OpenAI API ${method} ${path} failed (${res.status}): ${detail}`);
  }
  return json;
}

// ---------------------------------------------------------------------------
// Argument handling
// ---------------------------------------------------------------------------

const rawArgs = process.argv.slice(2);
const flags = new Set(rawArgs.filter((a) => a.startsWith("--")));
const positionals = rawArgs.filter((a) => !a.startsWith("--"));

let prefix = "";
const prefixIdx = rawArgs.indexOf("--prefix");
if (prefixIdx !== -1) {
  prefix = rawArgs[prefixIdx + 1] ?? "";
  if (!prefix || prefix.startsWith("--")) fail("--prefix needs a value, e.g. --prefix v2");
}

const dryRun = flags.has("--dry-run");
const role1Only = flags.has("--role1-only");
const foxtwoOnly = flags.has("--foxtwo-only");
if (role1Only && foxtwoOnly) fail("Pick at most one of --role1-only / --foxtwo-only.");
if (positionals.length < 1 || positionals.length > 2) {
  fail(
    "Usage: node setup-vector-stores.mjs <pfc-sources-folder> <foxtwo-sources-folder>\n" +
      "   or: node setup-vector-stores.mjs <folder-containing-both-subfolders>\n" +
      "  (see the header comment / README.md for the folder layout)",
  );
}

// Resolve the two source folders.
let pfcDir;
let foxtwoDir;
if (positionals.length === 2) {
  [pfcDir, foxtwoDir] = positionals;
} else {
  const parent = positionals[0];
  pfcDir = join(parent, "PFC Sources");
  foxtwoDir = join(parent, "FoxTwo_sources");
}
for (const [label, dir] of [
  ["PFC Sources", pfcDir],
  ["FoxTwo_sources", foxtwoDir],
]) {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    fail(
      `Folder not found: ${dir} (${label}).\n` +
        "Download the Drive folders GPT_dev_files/PFC Sources and " +
        "GPT_dev_files/FoxTwo_sources, then pass their local paths.",
    );
  }
}

if (!dryRun && !process.env.OPENAI_API_KEY) {
  fail(
    "OPENAI_API_KEY is not set.\n" +
      "Create a key at platform.openai.com (API keys), then run:\n" +
      "  export OPENAI_API_KEY=\"sk-...\"\n" +
      "  node setup-vector-stores.mjs <pfc-sources-folder> <foxtwo-sources-folder>\n" +
      "The key is never accepted as a command-line argument.",
  );
}

// ---------------------------------------------------------------------------
// Per-store build
// ---------------------------------------------------------------------------

async function buildStore(store) {
  const dir = store.key === "role1" ? pfcDir : foxtwoDir;
  console.log(`\n=== ${store.label} ===`);
  console.log(`Source folder: ${dir}`);

  // 1. Check every expected file; warn LOUDLY about missing ones, continue
  //    with the rest. A missing file means the store ships incomplete — the
  //    summary at the end repeats the warning so it can't be missed.
  const missing = [];
  const present = [];
  for (const name of store.files) {
    const path = join(dir, name);
    if (!existsSync(path)) {
      missing.push(name);
      continue;
    }
    const size = statSync(path).size;
    if (size > MAX_FILE_BYTES) {
      console.error(
        `  ⚠ WARNING: ${name} is ${(size / 1024 / 1024).toFixed(1)} MB — over OpenAI's ` +
          `512 MB per-file limit. It will be SKIPPED; split it and re-run (see README.md).`,
      );
      missing.push(`${name} (over 512 MB limit)`);
      continue;
    }
    if (size > 50 * 1024 * 1024) {
      console.log(`  (large file, ${(size / 1024 / 1024).toFixed(1)} MB — upload/indexing will take a while): ${name}`);
    }
    present.push({ name, path, size });
  }

  if (missing.length > 0) {
    console.error(`\n  ⚠⚠⚠ WARNING — ${missing.length} expected file(s) MISSING for ${store.label}:`);
    for (const name of missing) console.error(`      MISSING: ${name}`);
    console.error(
      "  The store will be created WITHOUT these files. Find them in Drive\n" +
        "  (GPT_dev_files/PFC Sources or FoxTwo_sources), download them into\n" +
        "  the folder above, and re-run this script — it creates a fresh store.\n",
    );
  }
  if (present.length === 0) fail(`No files found for ${store.label} — nothing to upload.`);
  console.log(`  Found ${present.length}/${store.files.length} files.`);

  if (dryRun) {
    console.log("  --dry-run: stopping before any API call.");
    return { store, id: "(dry run — no store created)", missing };
  }

  // 2. Upload each file to the Files API (purpose="assistants").
  console.log("  Uploading files to OpenAI (POST /v1/files) …");
  const fileIds = [];
  for (const { name, path } of present) {
    const form = new FormData();
    form.append("purpose", "assistants");
    const contentType = path.endsWith(".docx")
      ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      : "application/pdf";
    form.append("file", new Blob([readFileSync(path)], { type: contentType }), basename(path));
    const uploaded = await api("/files", { method: "POST", body: form, isForm: true });
    fileIds.push(uploaded.id);
    console.log(`    uploaded ${name} -> ${uploaded.id}`);
  }

  // 3. Create the vector store.
  const storeName = prefix ? `${prefix} ${store.label}` : store.label;
  console.log(`  Creating vector store "${storeName}" (POST /v1/vector_stores) …`);
  const created = await api("/vector_stores", { method: "POST", body: { name: storeName } });
  console.log(`    store id: ${created.id}`);

  // 4. Attach all files in one batch, then poll until indexing finishes.
  console.log("  Attaching files (POST /v1/vector_stores/{id}/file_batches) …");
  const batch = await api(`/vector_stores/${created.id}/file_batches`, {
    method: "POST",
    body: { file_ids: fileIds },
  });
  console.log(`    batch id: ${batch.id} — polling for indexing to complete …`);
  const started = Date.now();
  for (;;) {
    const status = await api(`/vector_stores/${created.id}/file_batches/${batch.id}`);
    const counts = status.file_counts ?? {};
    const done = (counts.completed ?? 0) + (counts.failed ?? 0);
    console.log(
      `    … ${status.status} (completed ${counts.completed ?? 0}, failed ${counts.failed ?? 0}, ` +
        `in progress ${counts.in_progress ?? 0}, total ${counts.total ?? fileIds.length})`,
    );
    if (status.status === "completed") break;
    if (status.status === "failed" || status.status === "cancelled") {
      fail(`File batch ${status.status}. Check the per-file status below / in the OpenAI dashboard.`);
    }
    if (Date.now() - started > POLL_TIMEOUT_MS) {
      fail(
        `Indexing did not finish within ${POLL_TIMEOUT_MS / 60000} minutes. ` +
          `The store ${created.id} still exists — check its status at ` +
          `platform.openai.com > Storage > Vector stores, or re-run the script.`,
      );
    }
    await sleep(POLL_INTERVAL_MS);
  }

  // 5. Per-file verdict, so a single failed file (e.g. the textbook) is visible.
  const listing = await api(`/vector_stores/${created.id}/files?limit=100`);
  const failed = (listing.data ?? []).filter((f) => f.status === "failed");
  for (const f of failed) {
    console.error(
      `    ⚠ FAILED to index: file ${f.id} — ${f.last_error?.message ?? "no detail returned"}. ` +
        `See README.md "If a file fails to index".`,
    );
  }
  const completed = (listing.data ?? []).filter((f) => f.status === "completed").length;
  console.log(`  Indexed: ${completed}/${fileIds.length} files completed${failed.length ? `, ${failed.length} failed` : ""}.`);

  return { store, id: created.id, missing, failed: failed.map((f) => f.id) };
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const selected = STORES.filter((s) => {
  if (role1Only) return s.key === "role1";
  if (foxtwoOnly) return s.key === "foxtwo";
  return true;
});

console.log("Vector-store setup — Role1 / FoxTwo");
if (dryRun) console.log("(dry run — no API calls will be made)");

const results = [];
for (const store of selected) results.push(await buildStore(store));

// ---------------------------------------------------------------------------
// Summary — the part the owner copies into Render
// ---------------------------------------------------------------------------

console.log("\n============================================================");
console.log("DONE — paste these into Render (Dashboard > your service >");
console.log("Environment). Do NOT paste them into chat or code.");
console.log("------------------------------------------------------------");
for (const r of results) {
  console.log(`${r.store.envVar}=${r.id}`);
}
console.log("============================================================");
const allMissing = results.flatMap((r) => r.missing.map((m) => `${r.store.label}: ${m}`));
if (allMissing.length > 0) {
  console.error("\n⚠⚠⚠ REMINDER — these files were MISSING and are NOT in the stores:");
  for (const m of allMissing) console.error(`  - ${m}`);
  console.error("Download them from Drive and re-run this script to build complete stores.\n");
} else {
  console.log("\nAll expected files were present. Both stores are complete.");
}
