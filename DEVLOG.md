# Development Log

## How I used CC during development

Built using Claude Code (CC) as the primary coding agent. Below is an account of what I delegated, what I wrote or significantly modified myself, and the decisions and issues that came up along the way. Disclaimer: I don't write devlogs routinely — this was written by me with CC assistance after the fact.

---

### What I delegated to AI

**Project setup** — The `/tmp/chromium-app` Vite + React + Tailwind scaffold already existed from a prior project. I reused it rather than generating a new one. CC handled dropping the investigator component in and wiring it to the entry point.

**UI components** — The full component tree (`Badge`, `Tags`, `Row`, `Card`, `Report`) was generated from a description of the layout and color scheme I wanted. I reviewed the Tailwind classes and adjusted some padding/colors but didn't rewrite any of it.

**Normalization layer** — The `normalizeTriage`, `normalizeBisect`, `normalizeFix`, and `normalizePatch` functions were written by CC after I described the problem: the model kept returning nested objects instead of flat strings, crashing React with "Objects are not valid as a React child." CC wrote the key normalization helpers (`toStr`, `toArr`, `toBool`) and I reviewed them.

**Diff formatting** — The `formatDiffForModel` function that converts Gerrit's structured JSON diff format (chunks of `ab`/`a`/`b` arrays) into readable unified diff text was generated. I didn't know the Gerrit diff schema off the top of my head.

**Fix generation prompt** — The 7-step prompt that asks the model to identify culprit lines and decide between targeted fix vs. revert was written by CC. I reviewed and kept it as-is because the output quality was good.

---

### What I wrote or significantly modified myself

**The Vite proxy config** — When we hit the Gerrit 503 problem, CC gave me three options (Vite proxy, Gitiles fallback, Google OAuth). I picked the proxy because it was the right call for a local dev demo — one config change, no new infrastructure. CC wrote the actual config but the architectural decision was mine.

**The `bug:` + `message:` fallback strategy** — After discovering the sample issue IDs were fictional and the real Gerrit `bug:` search was returning empty, I decided the right approach was a two-pass search: `bug:{id}` first, then `message:{id}` as fallback. CC wrote the implementation after I described the logic.

**Sample issue IDs** — The original samples (40278933, 41493243, 40940701) were placeholder IDs from the initial Claude Chat prototype. I ran the Gerrit searches manually in the browser console to find real issues with verified CLs (491157766, 488803411, 488137265) before swapping them in.

**Framing and scope decisions** — Specifically: the decision not to attempt a full Chromium checkout, not to try to submit a real CL without build verification, and to frame the tool as the pipeline rather than any single output of it. These were judgment calls I made.

---

## Pipeline iterations

### v1 — Straight LLM wrapper

Initial version from Claude Chat: four chained API calls (triage → subsystem → bisect → fix), no real data. The model hallucinated plausible-sounding CLs, commit hashes, and reviewer names. Looked good on the surface, completely made up underneath.

Problem: this doesn't actually help anyone. It's a well-formatted guess.

### v2 — Added Gerrit + Gitiles integration

Added `fetchGerritCLs` and `fetchGitRange` to pull real data and inject it into the bisect and fix prompts. The model would then reason about actual CLs rather than invented ones.

Hit two problems immediately:
1. **Gerrit 503** — every request from the browser returned 503. Not a CORS error (the requests were reaching the server), Gerrit just doesn't serve unauthenticated browser API calls. Discovered this by running raw `fetch()` calls in the browser console and reading the network tab.
2. **Fake sample IDs** — the sample issues I'd been testing against didn't exist in the real tracker. The `bug:` search returned empty arrays. Verified by running `message:regression is:merged` against Gerrit directly — that worked, which confirmed the search mechanism was fine and the issue IDs were the problem.

### v3 — Vite proxy + real issue IDs

Added the Vite proxy (`/gerrit` → `chromium-review.googlesource.com`, `/gitiles` → `chromium.googlesource.com/chromium/src`). Requests now go through the Node dev server, which doesn't have the browser restrictions. Gerrit started returning real data.

Replaced the sample issue IDs by querying Gerrit for real merged perf regression CLs, extracting their bug footer IDs, and verifying each one returned CLs when searched. Landed on 491157766 (AriaRoleToInternalRole), 488803411 (cc::LayerImpl tracking), 488137265 (multicol gap decoration).

### v4 — Diff fetching + fix generation

Added two more pipeline steps: fetch the actual diffs for MERGED CLs from Gerrit's file diff API, then pass the real diff to the model with instructions to either produce a targeted patch or recommend a revert. This is the step that makes the tool useful rather than just informative — the output is something an engineer can actually apply.

---

## Issues

**1. `max_tokens: 1000` — bisect and fix always empty**

The bisect and fix sections were showing blank/`—` for all fields. Checked the console logs and found the model was returning `{ raw: "..." }` for both steps — meaning JSON.parse was failing. The raw content was getting cut off mid-JSON because the model's response was exceeding 1000 tokens. Bumped to 4000 and the truncation stopped.

**2. Model returning nested objects — React crash**

After fixing the token limit, bisect and fix started rendering but then React crashed with "Objects are not valid as a React child." The model was ignoring the flat schema and returning things like `searchStrategy: { summary: "...", v8Analysis: "..." }` and `alternatives: [{ scope: "...", estimatedImpact: "..." }]`. Added the normalization layer (`toStr`, `safeStr`) and it stopped crashing. Still shows the data, just stringified when the model goes off-schema.

**3. Gerrit 503 from browser**

Described above in pipeline iterations. The fix (Vite proxy) was straightforward once I understood what was happening. The misleading part was that `Failed to fetch` in the JS console looked like a CORS error, but checking the network tab showed actual 503 responses — meaning the requests were reaching Gerrit, Gerrit just didn't want them.

**4. `o=DETAILED_ACCOUNTS` was not the problem**

My first instinct was that the 503 was caused by a bad query parameter. Tested removing `o=DETAILED_ACCOUNTS` — still 503. Tested the most minimal possible query — still 503. The issue was the browser origin, not the query.

**5. Blank screen on hot reload**

The app went blank a few times during development after file saves. This turned out to be HMR (hot module replacement) briefly re-mounting while the new module loaded. Not a real bug — the page recovered on its own within a second or two each time.
