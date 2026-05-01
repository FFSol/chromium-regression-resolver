import { useState, useRef } from "react";

// ── Config ────────────────────────────────────────────────────────────────────

const SAMPLES = [
  { id: "491157766", label: "#491157766 — AriaRole perf regression" },
  { id: "488803411", label: "#488803411 — cc::LayerImpl tracking" },
  { id: "488137265", label: "#488137265 — Multicol perf regression" },
];

const PIPELINE_STEPS = [
  { id: "triage",    label: "Triaging regression",        pct: 10  },
  { id: "subsystem", label: "Identifying subsystems",     pct: 25  },
  { id: "fetch",     label: "Fetching real CLs",          pct: 40  },
  { id: "bisect",    label: "Building bisect strategy",   pct: 55  },
  { id: "fix",       label: "Generating fix hypothesis",  pct: 70  },
  { id: "diffs",     label: "Fetching CL diffs",          pct: 85  },
  { id: "patch",     label: "Generating fix / revert",    pct: 100 },
];

// ── API ───────────────────────────────────────────────────────────────────────

const SYSTEM = `You are a Chromium performance engineer with deep knowledge of Blink, V8, //net,
and the Performance Manager subsystem. Respond with valid JSON only — no fences, no preamble.`;

async function ask(prompt, apiKey) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 4000,
      system: SYSTEM,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  const text = data.content[0].text;
  const cleaned = text.replace(/^```(?:json)?\n?/m, "").replace(/\n?```$/m, "").trim();
  try { return JSON.parse(cleaned); }
  catch { return { raw: text }; }
}

// ── Real data fetching ────────────────────────────────────────────────────────

const GERRIT  = "/gerrit";
const GITILES = "/gitiles";

function parseGJSON(text) {
  return JSON.parse(text.replace(/^\)\]\}'\n?/, ""));
}

async function fetchGerritCLs(issueId) {
  const mapCLs = (data) => Array.isArray(data) ? data.map(cl => ({
    number: cl._number,
    subject: cl.subject,
    status: cl.status,
    author: cl.owner?.name ?? cl.owner?.email ?? "unknown",
    updated: cl.updated,
    url: `https://chromium-review.googlesource.com/c/chromium/src/+/${cl._number}`,
  })) : [];

  try {
    const bugQ = encodeURIComponent(`project:chromium/src bug:${issueId}`);
    const res = await fetch(`${GERRIT}/changes/?q=${bugQ}&o=CURRENT_REVISION&n=20`);
    if (res.ok) {
      const cls = mapCLs(parseGJSON(await res.text()));
      if (cls.length > 0) return cls;
    }
  } catch {}

  // Fallback: search commit messages for the issue ID
  try {
    const msgQ = encodeURIComponent(`project:chromium/src message:${issueId}`);
    const res = await fetch(`${GERRIT}/changes/?q=${msgQ}&o=CURRENT_REVISION&n=20`);
    if (res.ok) return mapCLs(parseGJSON(await res.text()));
  } catch {}

  return [];
}

async function fetchGitRange(startRef, endRef) {
  try {
    const url = `${GITILES}/+log/${startRef}..${endRef}?format=JSON&n=50`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = parseGJSON(await res.text());
    return (data.log || []).map(c => ({
      hash: c.commit?.slice(0, 12) ?? "",
      subject: c.message?.split("\n")[0] ?? "",
      author: c.author?.name ?? "",
      url: `${GITILES}/+/${c.commit}`,
    }));
  } catch { return []; }
}

async function fetchCLDiffs(clNumber, relevantDirs = []) {
  try {
    const filesRes = await fetch(`${GERRIT}/changes/${clNumber}/revisions/current/files`);
    if (!filesRes.ok) return null;
    const filesData = parseGJSON(await filesRes.text());
    const allFiles = Object.keys(filesData).filter(f => f !== "/COMMIT_MSG");
    const files = (relevantDirs.length > 0
      ? allFiles.filter(f => relevantDirs.some(d => f.startsWith(d.replace(/^\//, ""))))
      : allFiles
    ).slice(0, 6);

    const diffs = await Promise.all(files.map(async (file) => {
      try {
        const res = await fetch(`${GERRIT}/changes/${clNumber}/revisions/current/files/${encodeURIComponent(file)}/diff`);
        if (!res.ok) return null;
        const diff = parseGJSON(await res.text());
        return { file, diff };
      } catch { return null; }
    }));
    return diffs.filter(Boolean);
  } catch { return null; }
}

function formatDiffForModel(fileDiffs) {
  return fileDiffs.map(({ file, diff }) => {
    const lines = [`--- a/${file}`, `+++ b/${file}`];
    let contextBuffer = [];
    for (const chunk of (diff.content || [])) {
      if (chunk.ab) {
        // show max 3 context lines around changes
        contextBuffer = chunk.ab.slice(-3);
        contextBuffer.forEach(l => lines.push(` ${l}`));
      }
      if (chunk.a) chunk.a.forEach(l => lines.push(`-${l}`));
      if (chunk.b) chunk.b.forEach(l => lines.push(`+${l}`));
    }
    return lines.join("\n");
  }).join("\n\n");
}

function normalizePatch(r) {
  if (!r || r.raw) return null;
  return {
    approach:          r.approach === "fix" ? "fix" : "revert",
    reasoning:         toStr(r.reasoning ?? r.rationale ?? r.explanation),
    patch:             typeof r.patch === "string" ? r.patch : null,
    culpritLines:      toStr(r.culpritLines ?? r.culprit ?? ""),
    expectedRecovery:  toStr(r.expectedRecovery ?? r.recovery ?? r.expectedDelta),
    risks:             toArr(r.risks ?? r.caveats),
  };
}

async function resolveCommitRange(issueId, triage, apiKey) {
  const raw = await ask(`Issue ${issueId}. Triage: ${JSON.stringify(triage)}

If you know the git commit hashes or Chromium commit position range for this regression,
return them. Otherwise return nulls.

Return JSON: { "startHash": string|null, "endHash": string|null,
               "startPos": number|null, "endPos": number|null }`, apiKey);
  return raw;
}

// ── Normalization — flatten whatever shape the model returns ──────────────────

const toStr = (v) => {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "object") return v.summary ?? v.scope ?? v.rationale ?? v.description ?? JSON.stringify(v);
  return String(v);
};

const toArr = (v) => {
  if (!v) return [];
  if (Array.isArray(v)) return v.map(toStr);
  if (typeof v === "string") return [v];
  return [toStr(v)];
};

const toBool = (v) => {
  if (typeof v === "boolean") return v;
  if (typeof v === "object" && v !== null) return v.viable ?? v.value ?? true;
  return !!v;
};

const toConfidence = (v) => {
  if (typeof v === "string") return v;
  if (typeof v === "number") return v >= 0.8 ? "high" : v >= 0.5 ? "medium" : "low";
  return "medium";
};

function normalizeTriage(r) {
  return {
    regressionClass: toStr(r.regressionClass ?? r.regression_class ?? ""),
    severity: r.severity ?? "medium",
    confidence: toConfidence(r.confidence),
    rationale: toStr(r.rationale),
    affectedUsers: toStr(r.affectedUsers ?? r.affected_users),
    bisectViable: toBool(r.bisectViable ?? r.bisect_viable),
  };
}

function normalizeBisect(r) {
  if (r.raw) return { metric: "", benchmarks: [], suspectPatterns: [], falsePositiveRisks: [], searchStrategy: r.raw.slice(0, 500) };
  const metric = r.metric ? (typeof r.metric === "object" ? r.metric.full_path ?? JSON.stringify(r.metric) : r.metric) : "";
  return {
    metric,
    benchmarks: toArr(r.benchmarks?.map?.(b => typeof b === "object" ? (b.name ?? b.story ?? JSON.stringify(b)) : b) ?? r.benchmarks),
    suspectPatterns: toArr(r.suspectPatterns?.map?.(p => typeof p === "object" ? (p.pattern ?? p.id ?? JSON.stringify(p)) : p) ?? r.suspectPatterns),
    falsePositiveRisks: toArr(r.falsePositiveRisks ?? r.false_positive_risks),
    searchStrategy: toStr(r.searchStrategy ?? r.strategy),
  };
}

function normalizeFix(r) {
  if (r.raw) return { hypothesis: r.raw.slice(0, 500), proposedApproach: "", clScope: "", riskLevel: "", expectedDelta: "", validationSteps: [], alternatives: [], suggestedReviewers: [] };
  const clScope = r.clScope ? (typeof r.clScope === "object" ? r.clScope.estimatedCLCount ? `~${r.clScope.estimatedCLCount} CLs` : JSON.stringify(r.clScope) : r.clScope) : "";
  return {
    hypothesis: toStr(r.hypothesis ?? r.rootCause),
    proposedApproach: toStr(r.proposedApproach ?? r.approach),
    clScope,
    riskLevel: toStr(r.riskLevel ?? r.risk_level),
    expectedDelta: toStr(r.expectedDelta ?? r.expected_delta),
    validationSteps: toArr(r.validationSteps ?? r.validation_steps),
    alternatives: toArr(r.alternatives),
    suggestedReviewers: toArr(r.suggestedReviewers ?? r.reviewers),
  };
}

// ── Pipeline ──────────────────────────────────────────────────────────────────

async function investigate(issueId, context, apiKey, onStep) {
  const ctx = context ? `\nEngineer context: ${context}` : "";
  const base = `Issue: https://issues.chromium.org/issues/${issueId}${ctx}`;

  onStep(PIPELINE_STEPS[0]);
  const triageRaw = await ask(`${base}

Return JSON with exactly these string fields:
{ "regressionClass": string, "severity": "critical"|"high"|"medium"|"low",
  "confidence": "high"|"medium"|"low", "rationale": string,
  "affectedUsers": string, "bisectViable": boolean }`, apiKey);
  const triage = normalizeTriage(triageRaw);

  onStep(PIPELINE_STEPS[1]);
  const subsystem = await ask(`${base}
Triage: ${JSON.stringify(triage)}

Return JSON with exactly these fields:
{ "primarySubsystem": string, "sourceDirectories": string[],
  "keyClasses": string[], "investigationPriority": string }`, apiKey);

  onStep(PIPELINE_STEPS[2]);
  const [gerritCLs, rangeInfo] = await Promise.all([
    fetchGerritCLs(issueId),
    resolveCommitRange(issueId, triage, apiKey),
  ]);
  const gitCommits = (rangeInfo?.startHash && rangeInfo?.endHash)
    ? await fetchGitRange(rangeInfo.startHash, rangeInfo.endHash)
    : [];
  const realCLs = { gerritCLs, gitCommits, hasReal: gerritCLs.length > 0 || gitCommits.length > 0 };

  const realCLContext = realCLs.hasReal ? `
Real CLs from Gerrit/Gitiles:
${gerritCLs.length > 0 ? "Gerrit CLs referencing this bug:\n" + gerritCLs.map(cl =>
    `  CL ${cl.number} [${cl.status}]: "${cl.subject}" by ${cl.author} — ${cl.url}`
  ).join("\n") : ""}
${gitCommits.length > 0 ? "Commits in regression range:\n" + gitCommits.map(c =>
    `  ${c.hash}: "${c.subject}" by ${c.author} — ${c.url}`
  ).join("\n") : ""}

Reason about the ACTUAL CLs above when forming your strategy.` : "";

  onStep(PIPELINE_STEPS[3]);
  const bisectRaw = await ask(`${base}
Triage: ${JSON.stringify(triage)}
Subsystem: ${JSON.stringify(subsystem)}
${realCLContext}

Return JSON with exactly these fields — all values must be plain strings or string arrays, no nested objects:
{ "metric": string, "benchmarks": string[], "suspectPatterns": string[],
  "falsePositiveRisks": string[], "searchStrategy": string }`, apiKey);
  const bisect = normalizeBisect(bisectRaw);

  onStep(PIPELINE_STEPS[4]);
  const fixRaw = await ask(`${base}
Triage: ${JSON.stringify(triage)}
Subsystem: ${JSON.stringify(subsystem)}
Bisect: ${JSON.stringify(bisect)}
${realCLContext}

Return JSON with exactly these fields — all values must be plain strings or string arrays, no nested objects:
{ "hypothesis": string, "proposedApproach": string,
  "clScope": "trivial"|"small"|"medium"|"large",
  "riskLevel": "low"|"medium"|"high", "expectedDelta": string,
  "validationSteps": string[], "alternatives": string[],
  "suggestedReviewers": string[] }`, apiKey);
  const fix = normalizeFix(fixRaw);

  // ── Steps 6+7: fetch real diffs and generate fix/revert ───────────────────
  onStep(PIPELINE_STEPS[5]);
  const mergedCLs = realCLs.gerritCLs.filter(cl => cl.status === "MERGED").slice(0, 2);
  const clDiffResults = await Promise.all(
    mergedCLs.map(async (cl) => {
      const diffs = await fetchCLDiffs(cl.number, subsystem.sourceDirectories ?? []);
      return diffs?.length > 0 ? { cl, formatted: formatDiffForModel(diffs) } : null;
    })
  );
  const clDiffs = clDiffResults.filter(Boolean);

  onStep(PIPELINE_STEPS[6]);
  let patch = null;
  if (clDiffs.length > 0) {
    const { cl, formatted } = clDiffs[0];
    const patchRaw = await ask(`You are a Chromium performance engineer.

Regression: ${triage.regressionClass} — ${triage.rationale}
Metric impact: ${fix.expectedDelta}
Subsystem: ${subsystem.primarySubsystem}
Hypothesis: ${fix.hypothesis}

The following CL has been identified as the likely culprit:
CL ${cl.number}: "${cl.subject}" by ${cl.author}
${cl.url}

Actual diff:
${formatted.slice(0, 6000)}

Your task:
1. Identify the specific lines that caused the performance regression.
2. Decide: can this be fixed with a targeted change, or should the whole CL be reverted?
   - Prefer a targeted fix if the regression is caused by a small subset of the changes.
   - Recommend revert if the entire CL approach is flawed or the fix is too risky.
3. If targeted fix: generate a unified diff patch that surgically addresses only the regression.
   The patch must compile and not break the CL's intended functionality.
4. If revert: explain exactly why a targeted fix is not appropriate.

Return JSON (no fences):
{
  "approach": "fix" | "revert",
  "reasoning": string,
  "culpritLines": string,
  "patch": string | null,
  "expectedRecovery": string,
  "risks": string[]
}`, apiKey);
    patch = normalizePatch(patchRaw);
  }

  return { issueId, triage, subsystem, bisect, fix, realCLs, patch, clDiffs };
}

// ── UI Primitives ─────────────────────────────────────────────────────────────

const cx = (...classes) => classes.filter(Boolean).join(" ");

const safeStr = (v) => {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (typeof v === "number") return String(v);
  return JSON.stringify(v);
};

const BADGE_COLORS = {
  critical: "bg-red-500/20 text-red-300 border-red-500/30",
  high:     "bg-orange-500/20 text-orange-300 border-orange-500/30",
  medium:   "bg-yellow-500/20 text-yellow-300 border-yellow-500/30",
  low:      "bg-green-500/20 text-green-300 border-green-500/30",
  blue:     "bg-blue-500/20 text-blue-300 border-blue-500/30",
  purple:   "bg-purple-500/20 text-purple-300 border-purple-500/30",
  gray:     "bg-gray-700/40 text-gray-400 border-gray-600/30",
};

function Badge({ children, color = "gray" }) {
  return (
    <span className={cx("inline-flex items-center px-2 py-0.5 rounded text-xs font-mono border", BADGE_COLORS[color])}>
      {children}
    </span>
  );
}

function Tags({ items = [], color }) {
  const safe = (Array.isArray(items) ? items : []).map(safeStr).filter(Boolean);
  return safe.length
    ? <div className="flex flex-wrap gap-1.5">{safe.map((t, i) => <Badge key={i} color={color}>{t}</Badge>)}</div>
    : <span className="text-xs text-gray-600">—</span>;
}

function Row({ label, children }) {
  return (
    <div className="flex gap-3 py-1.5 border-b border-gray-800/60 last:border-0 text-xs">
      <span className="text-gray-500 font-mono w-32 shrink-0 pt-0.5">{label}</span>
      <div className="flex-1 text-gray-300">{children}</div>
    </div>
  );
}

function Card({ title, icon, children }) {
  return (
    <div className="border border-gray-700/60 rounded-lg overflow-hidden mb-4">
      <div className="flex items-center gap-2 px-4 py-2 bg-gray-800/60 border-b border-gray-700/60">
        <span>{icon}</span>
        <span className="text-xs font-mono font-semibold text-gray-300 tracking-widest uppercase">{title}</span>
      </div>
      <div className="px-4 py-3">{children}</div>
    </div>
  );
}

// ── Report ────────────────────────────────────────────────────────────────────

function FixPatchCard({ patch, clDiffs, realCLs }) {
  const [copied, setCopied] = useState(false);
  const mergedCLs = realCLs?.gerritCLs?.filter(cl => cl.status === "MERGED") ?? [];

  if (!patch && clDiffs?.length === 0) return (
    <div className="border border-gray-800/40 rounded-lg px-4 py-3 mb-4 text-xs text-gray-600 font-mono">
      No MERGED CLs found to diff — fix generation requires real Gerrit CLs referencing this issue.
    </div>
  );
  if (!patch) return null;

  const copy = (text) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Card title={patch.approach === "fix" ? "Targeted Fix" : "Revert Recommendation"} icon={patch.approach === "fix" ? "⚙️" : "↩️"}>
      <div className="flex flex-wrap gap-2 mb-3">
        <Badge color={patch.approach === "fix" ? "low" : "medium"}>
          {patch.approach === "fix" ? "targeted fix" : "revert"}
        </Badge>
        {patch.expectedRecovery && <Badge color="blue">recovery: {patch.expectedRecovery}</Badge>}
      </div>

      <Row label="culprit lines">
        <span className="text-gray-400 leading-relaxed">{safeStr(patch.culpritLines)}</span>
      </Row>
      <Row label="reasoning">
        <span className="text-gray-400 leading-relaxed">{safeStr(patch.reasoning)}</span>
      </Row>

      {patch.approach === "fix" && patch.patch && (
        <div className="mt-4">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-xs font-mono text-gray-500 uppercase tracking-widest">Patch</span>
            <button onClick={() => copy(patch.patch)}
              className="text-xs font-mono text-cyan-400 hover:text-cyan-300 transition-colors">
              {copied ? "✓ copied" : "copy patch"}
            </button>
          </div>
          <pre className="bg-gray-900/80 border border-gray-800 rounded-lg p-3 text-xs overflow-x-auto leading-relaxed">
            {patch.patch.split("\n").map((line, i) => (
              <div key={i} className={
                line.startsWith("+") && !line.startsWith("+++") ? "text-green-400" :
                line.startsWith("-") && !line.startsWith("---") ? "text-red-400" :
                line.startsWith("@@") ? "text-cyan-500" : "text-gray-400"
              }>{line}</div>
            ))}
          </pre>
        </div>
      )}

      {patch.risks?.length > 0 && (
        <Row label="risks"><Tags items={patch.risks} color="medium" /></Row>
      )}

      <div className="flex flex-wrap gap-3 mt-4 pt-3 border-t border-gray-800/60">
        {patch.approach === "revert"
          ? mergedCLs.map(cl => (
              <a key={cl.number} href={`${GERRIT}/c/chromium/src/+/${cl.number}`}
                target="_blank" rel="noreferrer"
                className="text-xs px-3 py-1.5 rounded border border-orange-500/40 text-orange-300 bg-orange-500/10 hover:bg-orange-500/20 font-mono transition-colors">
                Open CL {cl.number} in Gerrit to revert →
              </a>
            ))
          : patch.patch && (
              <button onClick={() => copy(patch.patch)}
                className="text-xs px-3 py-1.5 rounded border border-cyan-500/40 text-cyan-300 bg-cyan-500/10 hover:bg-cyan-500/20 font-mono transition-colors">
                Copy patch · apply with git apply
              </button>
            )
        }
        {clDiffs?.[0]?.cl && (
          <a href={clDiffs[0].cl.url} target="_blank" rel="noreferrer"
            className="text-xs px-3 py-1.5 rounded border border-gray-700 text-gray-400 hover:text-gray-300 font-mono transition-colors">
            View CL {clDiffs[0].cl.number} diff in Gerrit →
          </a>
        )}
      </div>
    </Card>
  );
}

function RealCLsCard({ realCLs }) {
  if (!realCLs?.hasReal) return (
    <div className="border border-gray-800/40 rounded-lg px-4 py-3 mb-4 text-xs text-gray-600 font-mono">
      No CLs found in Gerrit or Gitiles for this issue — analysis is based on model knowledge only.
    </div>
  );
  return (
    <Card title="Real CLs (Gerrit + Gitiles)" icon="📡">
      {realCLs.gerritCLs.length > 0 && (
        <div className="mb-3">
          <p className="text-xs text-gray-500 font-mono mb-2 uppercase tracking-widest">Gerrit CLs referencing this bug</p>
          {realCLs.gerritCLs.map(cl => (
            <div key={cl.number} className="flex items-start gap-3 py-1.5 border-b border-gray-800/40 last:border-0">
              <Badge color={cl.status === "MERGED" ? "low" : cl.status === "ABANDONED" ? "gray" : "blue"}>
                {cl.status}
              </Badge>
              <div className="flex-1 min-w-0">
                <a href={cl.url} target="_blank" rel="noreferrer"
                  className="text-xs text-cyan-400 hover:text-cyan-300 font-mono block truncate">
                  CL {cl.number}: {cl.subject}
                </a>
                <span className="text-xs text-gray-600">{cl.author}</span>
              </div>
            </div>
          ))}
        </div>
      )}
      {realCLs.gitCommits.length > 0 && (
        <div>
          <p className="text-xs text-gray-500 font-mono mb-2 uppercase tracking-widest">Commits in regression range</p>
          {realCLs.gitCommits.map(c => (
            <div key={c.hash} className="flex items-start gap-3 py-1.5 border-b border-gray-800/40 last:border-0">
              <span className="text-xs font-mono text-gray-500 shrink-0">{c.hash}</span>
              <div className="flex-1 min-w-0">
                <a href={c.url} target="_blank" rel="noreferrer"
                  className="text-xs text-cyan-400 hover:text-cyan-300 block truncate">
                  {c.subject}
                </a>
                <span className="text-xs text-gray-600">{c.author}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function Report({ result: { issueId, triage, subsystem, bisect, fix, realCLs, patch, clDiffs } }) {
  return (
    <div className="mt-6">
      <div className="flex items-start justify-between mb-5">
        <div>
          <p className="text-xs text-gray-500 font-mono mb-1">INVESTIGATION REPORT · #{issueId}</p>
          <h2 className="text-lg font-bold text-white font-mono">
            {(triage.regressionClass || "unknown").replace(/_/g, " ").toUpperCase()} REGRESSION
          </h2>
        </div>
        <div className="flex gap-2">
          <Badge color={triage.severity}>{triage.severity}</Badge>
          <Badge color="purple">{triage.confidence} confidence</Badge>
        </div>
      </div>

      <Card title="Triage" icon="⚡">
        <Row label="affected users">{safeStr(triage.affectedUsers)}</Row>
        <Row label="bisect viable">{triage.bisectViable ? "yes" : "no"}</Row>
        <Row label="rationale"><span className="text-gray-400 leading-relaxed">{safeStr(triage.rationale)}</span></Row>
      </Card>

      <RealCLsCard realCLs={realCLs} />

      <Card title="Subsystem" icon="🏗">
        <Row label="primary">{safeStr(subsystem.primarySubsystem)}</Row>
        <Row label="source dirs"><Tags items={subsystem.sourceDirectories} color="blue" /></Row>
        <Row label="key classes"><Tags items={subsystem.keyClasses} color="purple" /></Row>
        <Row label="start here"><span className="text-gray-400 leading-relaxed">{safeStr(subsystem.investigationPriority)}</span></Row>
      </Card>

      <Card title="Bisect Strategy" icon="🔬">
        <Row label="metric"><span className="font-mono">{safeStr(bisect.metric)}</span></Row>
        <Row label="benchmarks"><Tags items={bisect.benchmarks} color="blue" /></Row>
        <Row label="suspect patterns"><Tags items={bisect.suspectPatterns} color="gray" /></Row>
        <Row label="false positives"><Tags items={bisect.falsePositiveRisks} color="medium" /></Row>
        <Row label="strategy"><span className="text-gray-400 leading-relaxed">{safeStr(bisect.searchStrategy)}</span></Row>
      </Card>

      <Card title="Fix Hypothesis" icon="🛠">
        <div className="flex gap-2 py-2">
          <Badge color={{ trivial:"low", small:"low", medium:"medium", large:"high" }[fix.clScope] || "gray"}>
            CL: {safeStr(fix.clScope)}
          </Badge>
          <Badge color={fix.riskLevel || "gray"}>risk: {safeStr(fix.riskLevel)}</Badge>
          <Badge color="blue">Δ {safeStr(fix.expectedDelta)}</Badge>
        </div>
        <div className="bg-gray-800/50 rounded p-3 my-2 border border-gray-700/40">
          <p className="text-xs text-cyan-300 font-mono leading-relaxed">{safeStr(fix.hypothesis)}</p>
        </div>
        <Row label="approach"><span className="text-gray-400 leading-relaxed">{safeStr(fix.proposedApproach)}</span></Row>
        <Row label="validation">
          <ol className="space-y-1">
            {(Array.isArray(fix.validationSteps) ? fix.validationSteps : []).map((s, i) => (
              <li key={i} className="flex gap-2 text-xs text-gray-400">
                <span className="text-gray-600 font-mono shrink-0">{i + 1}.</span>{safeStr(s)}
              </li>
            ))}
          </ol>
        </Row>
        <Row label="alternatives"><Tags items={fix.alternatives} color="gray" /></Row>
        <Row label="reviewers"><Tags items={fix.suggestedReviewers} color="purple" /></Row>
      </Card>

      <FixPatchCard patch={patch} clDiffs={clDiffs} realCLs={realCLs} />

      <div className="flex gap-4 mt-2">
        {[
          [`https://issues.chromium.org/issues/${issueId}`, "issues.chromium.org"],
          ["https://chromium.googlesource.com/chromium/src", "chromium source"],
          ["https://pinpoint-dot-chromeperf.appspot.com", "pinpoint"],
        ].map(([href, label]) => (
          <a key={label} href={href} target="_blank" rel="noreferrer"
            className="text-xs font-mono text-cyan-400 hover:text-cyan-300 underline underline-offset-2">
            → {label}
          </a>
        ))}
      </div>
    </div>
  );
}

// ── App ───────────────────────────────────────────────────────────────────────

export default function App() {
  const [apiKey,  setApiKey]  = useState(() => localStorage.getItem("anthropic_key") || "");
  const [issueId, setIssueId] = useState("");
  const [context, setContext] = useState("");
  const [status,  setStatus]  = useState(null);
  const [result,  setResult]  = useState(null);
  const [error,   setError]   = useState(null);
  const [running, setRunning] = useState(false);
  const resultRef = useRef(null);

  const run = async (id) => {
    const target = (id || issueId).trim().replace("#", "");
    if (!target || !apiKey.trim()) return;
    setRunning(true); setResult(null); setError(null);
    setStatus({ label: "Starting…", pct: 0 });
    try {
      const r = await investigate(target, context, apiKey.trim(), setStatus);
      setResult(r);
      setTimeout(() => resultRef.current?.scrollIntoView({ behavior: "smooth" }), 100);
    } catch (e) {
      setError(e.message);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100" style={{ fontFamily: "monospace" }}>
      {/* Header */}
      <div className="border-b border-gray-800 px-6 py-5 max-w-3xl mx-auto">
        <div className="flex items-center gap-2 mb-1">
          <div className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse" />
          <span className="text-xs text-gray-500 tracking-widest uppercase">Chromium Performance</span>
        </div>
        <h1 className="text-xl font-bold text-white">Regression Investigator</h1>
        <p className="text-xs text-gray-500 mt-1">
          AI-assisted triage · subsystem mapping · bisect strategy · fix hypothesis
        </p>
      </div>

      <div className="max-w-3xl mx-auto px-6 py-6">
        {/* API Key */}
        <div className="border border-gray-700 rounded-lg overflow-hidden mb-5">
          <div className="flex items-center gap-3 px-4 py-2 bg-gray-900">
            <span className="text-gray-600 text-xs font-mono shrink-0">ANTHROPIC_API_KEY</span>
            <input
              type="password"
              value={apiKey}
              onChange={e => { setApiKey(e.target.value); localStorage.setItem("anthropic_key", e.target.value); }}
              placeholder="sk-ant-…"
              className="flex-1 bg-transparent text-sm text-cyan-300 placeholder-gray-700 outline-none"
            />
            {apiKey && <span className="text-xs text-green-500 font-mono shrink-0">✓ saved</span>}
          </div>
        </div>

        {/* Sample bugs */}
        <div className="flex flex-wrap gap-2 mb-4">
          {SAMPLES.map(s => (
            <button key={s.id} onClick={() => { setIssueId(s.id); run(s.id); }} disabled={running}
              className="text-xs px-3 py-1.5 rounded border border-gray-700 text-gray-400 hover:border-cyan-500/50 hover:text-cyan-300 transition-colors disabled:opacity-40">
              {s.label}
            </button>
          ))}
        </div>

        {/* Input */}
        <div className="border border-gray-700 rounded-lg overflow-hidden mb-3">
          <div className="flex items-center gap-3 px-4 py-2 border-b border-gray-700 bg-gray-900">
            <span className="text-gray-600 text-xs font-mono">ISSUE_ID</span>
            <input value={issueId} onChange={e => setIssueId(e.target.value)}
              onKeyDown={e => e.key === "Enter" && run()} placeholder="e.g. 40278933"
              disabled={running}
              className="flex-1 bg-transparent text-sm text-cyan-300 placeholder-gray-700 outline-none" />
          </div>
          <textarea value={context} onChange={e => setContext(e.target.value)} rows={3}
            placeholder="Optional: paste bug description, trace output, suspect commit message…"
            disabled={running}
            className="w-full bg-gray-900/50 px-4 py-3 text-xs text-gray-300 placeholder-gray-700 outline-none resize-none" />
        </div>

        <button onClick={() => run()} disabled={running || !issueId.trim() || !apiKey.trim()}
          className="w-full py-3 rounded-lg bg-cyan-500 hover:bg-cyan-400 disabled:bg-gray-800 disabled:text-gray-600 text-black font-bold text-sm transition-colors mb-4">
          {running ? "Investigating…" : !apiKey.trim() ? "Enter API key to continue" : "Run Investigation"}
        </button>

        {/* Progress */}
        {running && status && (
          <div className="mb-4">
            <div className="flex justify-between text-xs text-gray-500 mb-1">
              <span>{status.label}</span><span>{status.pct}%</span>
            </div>
            <div className="w-full bg-gray-800 rounded-full h-1 mb-3">
              <div className="h-1 rounded-full bg-gradient-to-r from-cyan-500 to-blue-500 transition-all duration-700"
                style={{ width: `${status.pct}%` }} />
            </div>
            {PIPELINE_STEPS.map(step => (
              <div key={step.id} className={cx("flex items-center gap-2 text-xs mb-1",
                status.pct >= step.pct ? "text-cyan-400" : "text-gray-700")}>
                <span>{status.pct >= step.pct ? "✓" : "○"}</span>
                <span>{step.label}</span>
              </div>
            ))}
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="border border-red-500/30 rounded-lg p-4 bg-red-500/10 mb-4">
            <p className="text-xs text-red-400 font-mono">{error}</p>
          </div>
        )}

        <div ref={resultRef}>{result && <Report result={result} />}</div>
      </div>
    </div>
  );
}
