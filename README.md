# Chromium Regression Investigator

An AI-assisted tool for triaging Chromium performance regressions end-to-end — from issue ID to a ready-to-apply fix patch or revert recommendation, grounded in real data from Gerrit and Gitiles.

Built as a demonstration of using AI tooling to actively improve Chromium performance, in response to the Microsoft Edge engineering prompt.

---

## Prerequisites

- Node.js 18+
- An [Anthropic API key](https://console.anthropic.com/)

---

## Setup

```bash
cd /tmp/chromium-app
npm install
npm run dev
```

The app runs at `http://localhost:5174`.

> **Note:** The Vite dev server proxies all Gerrit and Gitiles API requests server-side. This is required — Chromium's Gerrit instance returns 503 for unauthenticated browser-originated fetch requests. The proxy routes `/gerrit/*` → `chromium-review.googlesource.com` and `/gitiles/*` → `chromium.googlesource.com/chromium/src`. This means the tool only works in local dev. A production deployment would need a backend service with proper auth.

---

## Usage

1. Open `http://localhost:5174`
2. Enter your Anthropic API key in the `ANTHROPIC_API_KEY` field — it's saved to localStorage
3. Either click a sample issue or enter a real Chromium issue ID (e.g. `491157766`)
4. Click **Run Investigation**

The pipeline runs 7 steps and takes 60–90 seconds depending on the issue.

---

## What It Does — Pipeline

### Step 1 — Triage
Classifies the regression: type, severity, confidence, affected users, rationale, and whether a bisect is viable. This is the same first-pass a Chromium performance engineer does manually when a Pinpoint alert lands in their inbox.

### Step 2 — Subsystem Identification
Identifies the primary Chromium subsystem (Blink, V8, //net, cc, etc.), relevant source directories, and key C++ classes to investigate. Narrows the search space before fetching real data.

### Step 3 — Fetch Real CLs
Queries the real Chromium Gerrit instance for CLs linked to the issue ID. Uses the `bug:{id}` operator first, falls back to `message:{id}` if that returns nothing (catches CLs that mention the issue in the body rather than the footer). Also resolves any known commit hash ranges from Gitiles.

This step is what separates the tool from a straight LLM wrapper — subsequent steps reason about actual code that landed, not hallucinated CLs.

### Step 4 — Bisect Strategy
Suggests the metric, benchmarks, suspect commit patterns, false positive risks, and search strategy. When real CLs are available from Step 3, the model ranks them by likelihood rather than guessing. Produces a Pinpoint-ready description.

### Step 5 — Fix Hypothesis
Root cause analysis: what changed, why it caused the regression, CL scope, risk level, expected performance delta, validation steps, alternative explanations, and suggested reviewers (sourced from OWNERS files the model knows about).

### Step 6 — Fetch CL Diffs
For every MERGED CL found in Step 3, fetches the actual unified diff from Gerrit's REST API — filtered to the source directories identified in Step 2 to keep context tight. This is the real code that caused the regression.

### Step 7 — Generate Fix / Revert
The model reads the actual diff line by line, identifies the specific lines responsible for the regression, and decides:

- **Targeted fix** — if the regression is caused by a subset of the changes, produces a unified diff patch that surgically addresses it while preserving the CL's intended functionality. Syntax-highlighted, copyable, `git apply`-ready.
- **Revert recommendation** — if the whole CL approach is flawed or a targeted fix is too risky, explains why and links directly to the Gerrit revert UI for that CL.

---

## Components

| File | Purpose |
|---|---|
| `src/App.jsx` | Entire application — pipeline, data fetching, normalization, UI |
| `vite.config.js` | Dev server + Gerrit/Gitiles proxy configuration |

### External sources used

| Source | What it provides |
|---|---|
| `chromium-review.googlesource.com` (Gerrit) | Real CLs linked to the issue, file diffs |
| `chromium.googlesource.com/chromium/src` (Gitiles) | Commit range resolution, git log |
| `api.anthropic.com` | All AI inference (claude-sonnet-4-6) |

### Why these sources

Gerrit and Gitiles are the canonical, public, unauthenticated-readable sources of truth for what code landed in Chromium and when. There's no scraping — both have documented REST APIs. The Gerrit `bug:` operator searches commit footers for issue references; the `message:` fallback catches anything the footer search misses.

---

## Applicability

This tool is built around Chromium but the pattern applies to any large C++ project with:
- A public Gerrit instance
- A Gitiles-hosted source tree
- Performance regression tracking (Pinpoint equivalent)

The pipeline structure (triage → subsystem → real data fetch → diff analysis → fix generation) is project-agnostic. Swapping the Gerrit/Gitiles URLs and the system prompt's domain knowledge adapts it to WebKit, LLVM, or any other open-source project with similar infrastructure.

---

## Limitations

- **No build verification** — generated patches are not compiled or tested. An engineer must review before applying.
- **Dev proxy only** — the Vite proxy is a local dev shortcut. Deployed versions need a backend with proper Google OAuth to call Gerrit authenticated.
- **Model knowledge cutoff** — for issues the model doesn't have training data on, triage and subsystem identification are best-effort reasoning rather than recall.
- **Diff size cap** — diffs are capped at 6 files and 6000 characters to fit in context. Large CLs touching many files may have partial coverage.
- **No Pinpoint integration** — the tool generates the bisect strategy and job configuration but cannot submit a Pinpoint job (requires Google auth and infrastructure access).
