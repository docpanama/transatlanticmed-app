# Deployment checklist — Role1 / FoxTwo rebuild

Owner: Matt. You do every account step yourself, in this order. Nothing here
needs anyone else's login. **Never paste the OpenAI API key into chat, code,
email, or a browser form — it goes only into Render environment variables
(step 5).**

Deadline context: OpenAI retires custom GPTs on **Dec 11, 2026**. The old
ChatGPT links stop working then; this app replaces them.

## Layout decision (read first — everything below assumes this)

- **One GitHub repo** (suggested name: `transatlanticmed-app`), containing
  the `build/` folder exactly as built:
  - `build/web/` — static front end (GitHub Pages)
  - `build/server/` — Node proxy: `server.js` + `package.json`
  - `build/prompts/` — system prompts
  - `build/scripts/` — `setup-vector-stores.mjs` + `README.md`
  - `build/DEPLOYMENT_CHECKLIST.md` — this file
- **Render** runs the proxy from that repo with **Root Directory
  `build/server`** and **Start Command `node server.js`**. (If the repo you
  receive has `server.js` somewhere else, change the Root Directory to match
  — do not move files around to fit this checklist.)
- **GitHub Pages** serves the front end via a GitHub Actions workflow (see
  step 6 and Appendix A). Pages' branch settings can only serve the repo
  root or `/docs`, not a nested `build/web/` folder, so the workflow is the
  route — do not try to point Pages at the branch directly.
- **Public URL:** `https://app.transatlanticmed.com` (GoDaddy subdomain,
  step 7). The Render service keeps its own `*.onrender.com` URL; students
  never need it.

Before starting, confirm the repo you received actually contains
`build/server/server.js`, `build/server/package.json`, and `build/web/` with
the front-end files. If any of those are missing, stop — the build is not
ready to deploy.

---

## Step 1 — Create the OpenAI API key

1. Go to [platform.openai.com](https://platform.openai.com) and sign in (or
   create the account).
2. **Billing first:** Settings → Billing → add a payment method and **set a
   monthly spending limit**. Suggested limit: **$20/month** to start — the
   expected bill is well under that (~40–60 sessions/month). You can raise
   it later; the limit is a safety net, not a target.
3. API keys → **Create new key**. Name it `transatlanticmed-app`. Leave
   permissions at default. **Copy the key immediately** — OpenAI shows it
   once. Store it somewhere safe (password manager).
4. ✅ **Check:** the key starts with `sk-` and you can see it listed under
   API keys. Do not paste it anywhere except Render (step 5).

## Step 2 — Download the two source folders from Drive

> **Skip the download if you already have exact local duplicates** (the
> owner does, as of 2026-11-09): point the script at your local folders
> instead. One layout requirement: the script looks for the 12 FoxTwo
> files at the **top level** of the folder — in Drive, 7 of them sat in
> the `Current_JTS_CPGs` subfolders, so a flat copy is needed (the
> owner's local folders are flat). The `--dry-run` in step 3 confirms
> all 26 files are found before anything is spent.
> (Note: re-uploading the folders to Drive gave them new Drive folder
> IDs; nothing in this build references Drive IDs, so that changes
> nothing here.)

1. In Google Drive, open the Shared Drive folder `GPT_dev_files`.
2. Download **`PFC Sources`** and **`FoxTwo_sources`** to your computer
   (right-click → Download; they arrive as zip files — unzip them).
3. Do **not** rename any file inside them. The setup script matches exact
   filenames.
4. ✅ **Check:** `PFC Sources` holds 11 PDFs + the how-to-use, what-is, and
   student-instructions `.docx` files (plus one extra, Crush Syndrome,
   which the script deliberately skips) and `FoxTwo_sources` holds the
   SMOG, CoERCCC files, 5 CPGs, `Critical Care Transport 3rd Edition.pdf`
   (~73 MB), and the how-to-use, what-is, and student-instructions
   `.docx` files. If a file is missing, find it in Drive before
   continuing — the script will warn you, but a store built without a file
   stays incomplete until you re-run it.

## Step 3 — Run the vector-store setup script

1. On your computer, open a terminal. Check Node: `node --version` — you
   need **v24 or newer**. (If you don't have Node, install it from
   [nodejs.org](https://nodejs.org) — the LTS download.)
   **No admin rights?** (e.g. a university laptop) Skip the installer —
   download the macOS **binary (.tar.gz)** instead, no install needed:
   find your chip first (Apple menu → About This Mac → Chip: "Apple M…"
   = ARM64, "Intel" = x64), then download the matching file from
   `https://nodejs.org/dist/v26.13.0/` — `node-v26.13.0-darwin-arm64.tar.gz`
   or `node-v26.13.0-darwin-x64.tar.gz`. Double-click it in Downloads to
   unpack it, then in the terminal run (adjust the folder name to the one
   you downloaded):
   ```bash
   export PATH="$HOME/Downloads/node-v26.13.0-darwin-arm64/bin:$PATH"
   node --version
   ```
   That `export` lasts only for that terminal window — repeat it if you
   open a new one. If macOS ever complains the developer "cannot be
   verified" when you run `node`, say so — there is a one-line fix.
2. In the terminal:
   ```bash
   export OPENAI_API_KEY="sk-..."   # paste the key from step 1
   cd <the folder holding setup-vector-stores.mjs>   # the script file is
   # attached in the chat — save it to a folder on your computer and cd there
   node setup-vector-stores.mjs --dry-run ~/Downloads/"PFC Sources" ~/Downloads/FoxTwo_sources
   ```
   (Adjust the two folder paths to where you unzipped them in step 2.)
   One-folder form — if both source folders sit under one parent (e.g. a
   folder named `GPT Migration`):
   ```bash
   node setup-vector-stores.mjs --dry-run "<path to GPT Migration>"
   ```
   The script finds `PFC Sources` and `FoxTwo_sources` inside it.
3. Read the dry-run output. If it lists missing files, download them and
   repeat. Only proceed when it says `Found 14/14 files` (Role1) and
   `Found 12/12 files` (FoxTwo).
4. Run it for real (same command without `--dry-run`). It uploads the PDFs
   and creates two vector stores. This takes several minutes — the CCT
   textbook is large and indexing is the slow part. Leave the terminal open
   until it prints `DONE`.
5. ✅ **Check:** the final block prints two lines like
   `ROLE1_VECTOR_STORE_ID=vs_...` and `FOXTWO_VECTOR_STORE_ID=vs_...`.
   Copy both IDs into a safe note — you need them in step 5. If any file
   shows `FAILED to index`, see `build/scripts/README.md` ("If a file fails
   to index") before continuing.

## Step 4 — Create the GitHub repo and upload `build/`

1. On [github.com](https://github.com), **New repository**. Name:
   **`transatlanticmed-app`**. Visibility: **Public** (GitHub Pages on a
   free account requires a public repo; the repo holds no secrets — the API
   key lives only in Render). Leave "Add a README" unchecked.
2. Upload the contents of `build/` **preserving the folder layout**
   (`web/`, `server/`, `prompts/`, `scripts/`, `DEPLOYMENT_CHECKLIST.md`).
   Easiest path without git on the command line: on the repo page, **Add
   file → Upload files**, then drag the whole `build/` folder in (GitHub
   accepts folder drag-and-drop). If you use git instead, the repo root
   should contain `build/` as its top-level folder.
3. Also add the Pages workflow file from Appendix A at
   `.github/workflows/pages.yml` in the repo (create the folders in the
   GitHub web UI via Add file → Create new file, pasting the YAML).
4. ✅ **Check:** the repo shows `build/web/`, `build/server/server.js`,
   `build/server/package.json`, `build/prompts/`, `build/scripts/`, and
   `.github/workflows/pages.yml`. **And:** no file in the repo contains your
   API key or a vector store ID — search the repo for `sk-` and confirm
   zero hits. If a key ever lands in the repo, delete that key at
   platform.openai.com immediately and create a fresh one (step 1).

## Step 5 — Render: create the proxy service

1. On [dashboard.render.com](https://dashboard.render.com), **New + → Web
   Service**. Choose **Build and deploy from a Git repository**, connect
   your GitHub account if asked, and select `transatlanticmed-app`.
2. Settings (exact values):
   - **Name:** `transatlanticmed-proxy` (or anything; students never see it)
   - **Region:** Oregon (or nearest to you — any region works)
   - **Branch:** `main`
   - **Root Directory:** `build/server`
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
   - **Instance Type:** Free
3. Before creating, open **Environment** and add these variables:

   | Variable | Value — where it comes from |
   |---|---|
   | `OPENAI_API_KEY` | Step 1 — paste the key here, nowhere else |
   | `ROLE1_VECTOR_STORE_ID` | Step 3 output (`vs_...`) |
   | `FOXTWO_VECTOR_STORE_ID` | Step 3 output (`vs_...`) |
   | `OPENAI_MODEL` | `gpt-5.4` |
   | `OPENAI_MAX_OUTPUT_TOKENS` | `4096` (optional — this is the proxy's default; set explicitly so a later default change can't surprise you) |
   | `OPENAI_TEMPERATURE` | Leave **blank** (optional). GPT-5-family models reject a non-default temperature; the proxy only sends it when explicitly set, and retries without it on a 400. Do not set 0.3 here — the 0.3 value from the decisions is a starting value for play-testing, not a Render default. |
   | `AAR_SERVICE_URL` | `https://fox-two-aar.onrender.com` (the existing, already-working AAR service — do not redeploy it) |
   | `PORT` | Do **not** set this — Render injects it automatically |

4. Click **Create Web Service**. The first deploy takes a few minutes.
   Free-tier services sleep after inactivity: the first request after a
   pause can take ~30–60 seconds to wake. That is normal.
5. ✅ **Check:** open `https://<your-service>.onrender.com/health` in a
   browser (find the URL at the top of the Render service page). You should
   get a JSON reply such as `{"status":"ok"}`. If it 404s or never loads,
   the proxy build failed — open the Render **Logs** tab and look for the
   error; the usual cause is a missing `package.json` or a wrong Root
   Directory (see the layout note at the top). **Do not proceed to step 6
   until `/health` answers.** (Assumption to verify: the proxy exposes
   `GET /health`. If the delivered `server.js` has no health endpoint, that
   is a proxy gap to fix, not a Render problem.)

## Step 5b — Point the front end at the proxy

The deployed site currently points at `http://localhost:3000` (local
testing only), so it cannot reach the Render proxy until this is changed.

1. In the GitHub repo, open `build/web/config.js` and click the pencil
   (Edit this file).
2. Change the `proxyUrl` line to your Render service URL, no trailing
   slash, e.g. `"https://transatlanticmed-proxy.onrender.com"`.
   ⚠️ Make sure the closing quote stays on the SAME line as the URL —
   if it slips onto its own line below, the file breaks and the site
   shows "No service address is configured". The line must read exactly:
   `proxyUrl: "https://transatlanticmed-proxy.onrender.com",`
3. Commit directly to `main`. The Deploy Pages workflow runs again
   automatically and the live site picks up the new address within a
   minute or two.
4. ✅ **Check:** open the Pages URL — the "Checking connection to the
   service…" line should clear and the scenario list should load. (The
   first load after the proxy has been idle can take ~30–60 seconds
   while the free Render service wakes up.)

## Step 6 — GitHub Pages: publish the front end

1. In the repo, go to **Settings → Pages**.
2. Under **Build and deployment → Source**, select **GitHub Actions**.
   (Do not select "Deploy from a branch" — it cannot serve `build/web/`.)
3. Go to the repo's **Actions** tab. The `Deploy Pages` workflow (from
   Appendix A) should run automatically on the next push; if it hasn't,
   click it and **Run workflow**.
4. ✅ **Check:** the workflow run goes green, and the Pages settings page
   shows **"Your site is live at https://\<username\>.github.io/transatlanticmed-app/"**.
   Open that URL — the app landing page should load (tool picker for Role1
   / FoxTwo). Note: at this point the page talks to the Render proxy, so a
   cold Render service may take up to a minute to answer the first chat
   message.

## Step 7 — GoDaddy: create the subdomain

1. In GoDaddy, open **transatlanticmed.com → DNS → Add Record**:
   - **Type:** CNAME
   - **Name:** `app`
   - **Value:** `<your-github-username>.github.io` (exactly — no `https://`)
   - **TTL:** 1 hour (or default)
   - Save. (Do not touch the existing records that serve the Canva site.)
2. Back in the GitHub repo, **Settings → Pages → Custom domain**, enter
   **`app.transatlanticmed.com`**, click Save. GitHub will verify the DNS
   record and issue an HTTPS certificate automatically — check **Enforce
   HTTPS** is ticked once the certificate appears.
3. ✅ **Check:** after DNS propagates (usually minutes, up to 48 hours),
   `https://app.transatlanticmed.com` loads the app and shows a padlock.
   If it doesn't load after a few hours, re-check the CNAME spelling and
   that the Pages custom-domain field shows no error.
4. The Render service URL stays as-is (`*.onrender.com`) — no custom
   domain is needed for it, and students never see it.

## Step 8 — Canva site: repoint the buttons (and fix the 3 dead links)

The rebuild supersedes the old Google Doc links, so the **recommended**
change is: point the site's tool buttons at the new app, not at Docs.

1. In Canva, open the transatlanticmed.com site editor.
2. **Clinical Decision Tools page** — repoint the Role1 and FoxTwo tool
   buttons to `https://app.transatlanticmed.com` (ideally to the app's
   per-tool entry points if the front end provides them — e.g.
   `…/app/?tool=role1` / `…/?tool=foxtwo`; use plain
   `https://app.transatlanticmed.com` if it doesn't).
3. **PFC_EDGE page and CCT_EDGE page** — repoint their "Open the simulator"
   / tool buttons the same way, and **delete the dead "HOW TO USE" and
   "Instructions and Scenario List" Doc links** (they are replaced by the
   in-app how-to-use, per the rebuild decisions).
4. **Rename the link/button text** to the new naming rule while you're
   there: `Role1` and `PFC_EDGE`, `FoxTwo` and `CCT_EDGE` — no `.GPT`
   suffix, no hyphenated EDGE names (so "What is FoxTwo.GPT?" becomes
   "What is FoxTwo?").
5. **Fix the PFC_EDGE page wording:** it currently copy-pastes the CCT
   wording ("three critical care transport scenarios (basic, advanced, or
   pediatric)"). PFC scenarios are prolonged field care, not critical care
   transport — rewrite that line to describe the three PFC scenarios.
6. Publish the Canva site.
7. ✅ **Check:** every tool button on the live site opens
   `app.transatlanticmed.com`; no button still points at
   `chatgpt.com/g/...` (those die Dec 11, 2026) or at a dead Doc.

**If you want the Doc links fixed anyway** (e.g. as a stopgap before the
app is live, or for students who still need the PDFs), the live
replacements from the 2026-11-08 link audit are:

| Dead link on the site | Change it to (live file) |
|---|---|
| Clinical Decision Tools → "What is FoxTwo.GPT?" — Doc `1ezcYS09HOGo_2EhdpBU8NeQKz7e1SA1l0gIx4QFveIE` (404) | `!What Is FoxTwo.GPT.docx` in CCT_EDGE_PUBLIC — Doc `1ezcIZwVxb1ZEooP6JNy5FYGmq5l13-f_Xcs4CWXe3IU` |
| Sim pages → "HOW TO USE" (both pages) — Doc `11oRzaJrBZx-b7ULdRW0y-z9a7d8n64rZ5fZH3ouABlI` (404) | PFC page: `!HOW TO USE THE PFC-EDGE AUSTERE CARE SIMULATOR.docx` — Doc `18ljhzvJPbXo2A4Xd1vNMKFOdxbVDG8sf`; CCT page: `!HOW TO USE THE FoxTwo.GPT CCT-EDGE TRANSPORT SIMULATOR.docx` — Doc `11oRzaJr3DN0lf9qxMpFp6vGmjRdgUXx4y27utBbmF7M` |
| CCT_EDGE → "Instructions and Scenario List" — Doc `12776Z1zQnFhPvx54bwBnL355dC5c-7hTBahO5AVFT8Y` (404) | `!CCT-EDGE_STUDENT_INSTRUCTIONS.docx` in CCT_EDGE_PUBLIC — Doc `12776Zfo-dEpdWrhkpwNGZQtSwl-C84OQ` |

(Doc links are `https://docs.google.com/document/d/<ID>/view`. The PFC
student-instructions link and the "What is Role1.GPT?" link are already
live and need no change.)

## Step 9 — Smoke test (do this before telling anyone the link is live)

1. Open `https://app.transatlanticmed.com` in a fresh browser window.
2. Pick **Role1**. Start a scenario, send 2–3 chat turns (a question, then
   a reassessment), and confirm replies come back and cite CPG content.
3. Pick **FoxTwo**. Same: start a scenario, send a turn, confirm a reply.
4. Complete one scenario end-to-end in either tool: approve the AAR when
   asked, and confirm the **.docx downloads** and opens with your AAR text
   in it.
5. ✅ **Check:** both tools answer; the AAR .docx downloads with a learner
   ID shown. If the first message after a pause is slow, wait up to a
   minute (Render free tier waking up) and retry before concluding
   anything is broken.

## Step 10 — Ongoing

- **Update a CPG:** replace the PDF in your local source folder, re-run
  the setup script (step 3 — it creates a **new** store), paste the new
  store ID into Render (step 5), and restart the service (Render →
  Manual Deploy → Deploy latest commit, or just change the env var —
  Render restarts on env change). Then delete the old store at
  platform.openai.com → Storage → Vector stores.
- **Rotate the API key:** create a new key at platform.openai.com, replace
  `OPENAI_API_KEY` in Render, restart the service, then delete the old key.
  Never commit a key to the repo.
- **If the AAR service is down:** the app must still show the full AAR as
  word-ready text in the chat so the student can copy it (this fallback is
  in the tools' design — CCT brief: "DOCX via action; fallback: display
  the complete AAR as word-ready text if the action fails" — and the
  proxy's `lib/aar.js` module is built around the same contract). Note:
  at checklist-writing time the proxy's `server.js` entry point was not
  yet written, so the fallback could not be verified in code — confirm it
  in the smoke test by asking the builders, or test it by temporarily
  pointing `AAR_SERVICE_URL` at a dead URL in a staging deploy. If instead
  the app shows only an error with no AAR text, that is a proxy bug: check
  `https://fox-two-aar.onrender.com/health` first (if that fails, the AAR
  service itself is down/sleeping — wait a minute and retry, free-tier
  services sleep), then report the missing fallback as a defect.
- **Watch the bill:** check the OpenAI usage dashboard after the first week
  of real use. If spend is tracking above ~$20/month, raise the limit
  deliberately — don't just remove it.
- **Privacy policy: already revised, not still open.** The revised policy is built at `build/web/docs/privacy-policy.html` (OpenAI for inference, Render for hosting) and is published with the site by the Pages workflow — link the site's privacy link to it. The Drive original still names Anthropic and is superseded; do not link to it. The three dead Doc links in step 8 are only worth fixing as Docs if you keep linking to Docs at all.

---

## Appendix A — GitHub Pages workflow (`.github/workflows/pages.yml`)

Create this file in the repo (step 4.3). It publishes `build/web/` on every
push to `main`.

```yaml
name: Deploy Pages

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: false

jobs:
  deploy:
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4
      - name: Setup Pages
        uses: actions/configure-pages@v5
      - name: Upload artifact
        uses: actions/upload-pages-artifact@v3
        with:
          path: build/web
      - name: Deploy to GitHub Pages
        id: deployment
        uses: actions/deploy-pages@v4
```

Note: the workflow deploys `build/web` as the site root, so the app's entry
point must be `build/web/index.html`. If the front end uses a different
entry file, adjust `path` or the file, not the workflow.
