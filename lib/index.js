/**
 * dsh-token-saver — token-saving plugin for DeepSeek Harness.
 *
 * v0.3.0 adds three capabilities on top of the conservative v0.2 line:
 *
 *   - count-first output modes for grep/glob (dsh-ops style):
 *     large result sets become counts / file lists first; the full result stays
 *     one `read` away in the spill file.
 *   - structure-aware compression with a never-worse gate:
 *     JSON/JSONL -> TOON-style tables, tables -> line-numbered stride samples,
 *     logs -> error-line preserving elision, other text -> head/tail. A
 *     candidate is only adopted when it is <= keepRatioMax bytes, saves at
 *     least minSavingBytes and strictly reduces estimated tokens.
 *   - cross-turn dedupe and shadow mode (dsh-plugin-save-token / dsh-sieve style):
 *     byte-identical results inside the TTL become a short duplicate stub;
 *     shadow mode records what would have happened without changing a result.
 *
 * The plugin still never changes the tool set and never rewrites history, so
 * the KV-cache prefix stays stable. Full originals are always saved before a
 * result is rewritten; read/edit/write are never touched.
 *
 * @license Apache-2.0
 */
import { createHash } from "node:crypto";
import z from "@deepseek-ai/schemastery";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { estimateContent } from "@deepseek-ai/dsh-token-meter/estimate";

export const name = "dsh-token-saver";
export const inject = ["tools", "systemPrompt"];

const DEFAULT_SPILL_TOOLS = [
  "pwsh",
  "bash",
  "ops_bash",
  "web_fetch",
  "grep",
  "ops_grep",
  "glob",
  "ops_glob",
];

const DEFAULT_EXCLUDE_TOOLS = [
  "read",
  "edit",
  "write",
  "compress",
  "decompress",
  "search_context",
  "acp_status",
  "ops_edit_file",
  "ops_write_file",
  "ops_stat",
  "ops_inspect_local_file",
  "ops_read_files",
];

const DEFAULT_PROFILE_ROWS = [
  { tool: "grep", profile: "matches", maxTokens: 0 },
  { tool: "ops_grep", profile: "matches", maxTokens: 0 },
  { tool: "glob", profile: "paths", maxTokens: 0 },
  { tool: "ops_glob", profile: "paths", maxTokens: 0 },
  { tool: "pwsh", profile: "log", maxTokens: 0 },
  { tool: "bash", profile: "log", maxTokens: 0 },
  { tool: "ops_bash", profile: "log", maxTokens: 0 },
  { tool: "web_fetch", profile: "article", maxTokens: 0 },
];

export const Config = z.object({
  /** Master switch. */
  enabled: z.boolean().default(true),
  /** A1: inject the plan-first / parallel-batching guidance section. */
  batchGuidance: z.boolean().default(true),
  /** A2: per-turn step counts that trigger an advisory notice; empty disables. */
  stepThresholds: z.array(z.number()).default([12, 20]),
  /** A3: nudge redundant re-reads of an unchanged file (subset of an earlier range). */
  redundantReadReminder: z.boolean().default(true),
  /** B: tools whose oversized text results get a tighter inline budget. */
  spillTools: z.array(z.string()).default(DEFAULT_SPILL_TOOLS),
  /** B: estimated-token inline cap used when a tool profile does not override it. */
  spillMaxTokens: z.number().default(4000),
  /** Per-tool profiles: { tool, profile, maxTokens }. maxTokens=0 falls back to spillMaxTokens. */
  toolProfiles: z.array(z.object({
    tool: z.string(),
    profile: z.string().default("auto"),
    maxTokens: z.number().default(0),
  })).default(DEFAULT_PROFILE_ROWS),
  /** Shadow mode: evaluate and record but never change a result. */
  shadow: z.boolean().default(false),
  /** Never-worse gate: compressed bytes must be at most this ratio of the original. */
  keepRatioMax: z.number().default(0.72),
  /** Never-worse gate: minimum absolute byte saving. */
  minSavingBytes: z.number().default(500),
  /** Cross-turn byte-identical result dedupe. */
  dedupe: z.boolean().default(true),
  /** Dedupe validity window in milliseconds. */
  dedupeTtlMs: z.number().default(600000),
  /** Include tool calls made inside subagents. */
  includeSubagents: z.boolean().default(true),
  /** Tools that are never rewritten (read/edit/write and history-compression tools). */
  excludeTools: z.array(z.string()).default(DEFAULT_EXCLUDE_TOOLS),
  /** Keep in-memory counters and expose /token-saver stats. */
  stats: z.boolean().default(true),
});

/** Producer source stamped on every advisory notice (an unlabeled context would render as a user prompt). */
const SOURCE = { kind: "dsh-token-saver" };

const BATCH_GUIDANCE = [
  "Work in as few model steps as possible:",
  "- Plan briefly before acting; decide the full set of reads/searches/commands a task needs up front.",
  "- Issue independent tool calls together in a single response (they run in parallel). Do not serialize calls that do not depend on each other's results.",
  "- Reuse results already in context instead of re-reading the same file or re-running the same search.",
  "- Prefer one precise search/read over several speculative ones; batch related shell commands into a single invocation when practical.",
].join("\n");

function stepReminder(step) {
  return `Step budget notice: this turn has used ${step} model steps. Each step re-sends the whole context and costs a request. Consolidate the remaining work: batch independent tool calls into one response, reuse results already in context, and finish as soon as the task is complete. This is advisory, not a limit.`;
}

function redundantReadReminder(path) {
  return `You already read ${path} earlier this turn and the requested lines are within a range you have already seen (the file has not been edited since). Reuse the earlier result instead of re-reading; read again only if you need a different range or the file changed.`;
}

/* ── Small helpers ── */

const byteLength = (text) => Buffer.byteLength(text, "utf8");
const priceText = (text) => estimateContent([{ type: "text", text }]);
const textBlock = (text) => [{ type: "text", text }];
const fullTextOf = (content) => content.map((block) => block.text).join("");

function normPath(p) {
  const normalized = String(p).replaceAll("\\", "/");
  // Windows paths are case-insensitive; POSIX paths are case-sensitive.
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function notice(text, summary) {
  return createUserMessage({
    content: [{ type: "text", text }],
    source: { ...SOURCE, form: "notice", summary },
  });
}

function matchesTool(toolName, pattern) {
  const name = String(toolName ?? "").toLowerCase();
  const rule = String(pattern ?? "").toLowerCase();
  if (!name || !rule) return false;
  if (rule.endsWith("*")) return name.startsWith(rule.slice(0, -1));
  if (name === rule) return true;
  // `grep` matches `ops_grep`, `pwsh` matches `ops_bash`/`pwsh_persistent`, etc.
  return name.endsWith(`_${rule}`) || name.startsWith(`${rule}_`);
}

function normalizeConfig(config = {}) {
  return {
    enabled: config.enabled !== false,
    batchGuidance: config.batchGuidance !== false,
    stepThresholds: Array.isArray(config.stepThresholds) ? config.stepThresholds : [12, 20],
    redundantReadReminder: config.redundantReadReminder !== false,
    spillTools: Array.isArray(config.spillTools) ? config.spillTools : DEFAULT_SPILL_TOOLS,
    spillMaxTokens: Number.isSafeInteger(config.spillMaxTokens) && config.spillMaxTokens > 0
      ? config.spillMaxTokens
      : 4000,
    toolProfiles: Array.isArray(config.toolProfiles) && config.toolProfiles.length > 0
      ? config.toolProfiles
      : DEFAULT_PROFILE_ROWS,
    shadow: config.shadow === true,
    keepRatioMax: Number.isFinite(config.keepRatioMax) && config.keepRatioMax > 0 && config.keepRatioMax < 1
      ? config.keepRatioMax
      : 0.72,
    minSavingBytes: Number.isSafeInteger(config.minSavingBytes) && config.minSavingBytes >= 0
      ? config.minSavingBytes
      : 500,
    dedupe: config.dedupe !== false,
    dedupeTtlMs: Number.isSafeInteger(config.dedupeTtlMs) && config.dedupeTtlMs >= 0
      ? config.dedupeTtlMs
      : 600000,
    includeSubagents: config.includeSubagents !== false,
    excludeTools: Array.isArray(config.excludeTools) ? config.excludeTools : DEFAULT_EXCLUDE_TOOLS,
    stats: config.stats !== false,
  };
}

function profileFor(toolName, cfg) {
  for (const row of cfg.toolProfiles) {
    if (row && matchesTool(toolName, row.tool)) {
      return {
        profile: row.profile || "auto",
        maxTokens: Number.isSafeInteger(row.maxTokens) && row.maxTokens > 0 ? row.maxTokens : cfg.spillMaxTokens,
      };
    }
  }
  if (/grep/i.test(toolName)) return { profile: "matches", maxTokens: cfg.spillMaxTokens };
  if (/glob/i.test(toolName)) return { profile: "paths", maxTokens: cfg.spillMaxTokens };
  if (/pwsh|bash/i.test(toolName)) return { profile: "log", maxTokens: cfg.spillMaxTokens };
  if (/web[_-]?fetch|fetch/i.test(toolName)) return { profile: "article", maxTokens: cfg.spillMaxTokens };
  return { profile: "auto", maxTokens: cfg.spillMaxTokens };
}

/* ── Head/tail retention ── */

/** Preserve a UTF-16 code point when a text budget cuts between its surrogates. */
function textSlice(text, length, tail) {
  let cut = tail ? text.length - length : length;
  if (cut <= 0) return tail ? text : "";
  if (cut >= text.length) return tail ? "" : text;
  const previous = text.charCodeAt(cut - 1);
  const current = text.charCodeAt(cut);
  if (previous >= 55296 && previous <= 56319 && current >= 56320 && current <= 57343) cut += tail ? 1 : -1;
  return tail ? text.slice(cut) : text.slice(0, cut);
}

/** Largest contiguous text end fitting a monotonic token estimate. */
function fitText(text, budget, tail) {
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = textSlice(text, middle, tail);
    if (candidate.length === 0 || priceText(candidate) <= budget) low = middle;
    else high = middle - 1;
  }
  return textSlice(text, low, tail);
}

function headTail(text, budget) {
  const headBudget = Math.max(0, Math.ceil(budget / 2));
  const tailBudget = Math.max(0, Math.floor(budget / 2));
  const head = fitText(text, headBudget, false);
  const rest = text.slice(head.length);
  const tail = fitText(rest, tailBudget, true);
  return `${head}\n\n[...]\n\n${tail}`;
}

const SPILL_PLACEHOLDER = "<<dsh-token-saver-spill>>";
const RETRIEVAL_HINT = "Use read with offset/limit, or grep this path to search within it.";

/** Notice wording identical to the built-in spill-policy so the model recognizes it. */
function spillNotice(omittedBytes, locator) {
  return `(Omitted ${omittedBytes} bytes. Full formatted result stored at: ${locator}. ${RETRIEVAL_HINT})`;
}

/* ── Structure-aware compression ── */

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function findUniformArray(value, path = "$", depth = 0) {
  if (Array.isArray(value) && value.length >= 8 && value.every(isPlainObject)) {
    const keys = Object.keys(value[0]);
    if (keys.length > 0 && keys.length <= 24 && value.every((row) => keys.every((key) => Object.hasOwn(row, key)))) {
      return { path, rows: value, keys };
    }
  }
  if (depth >= 2 || !isPlainObject(value)) return null;
  for (const [key, child] of Object.entries(value)) {
    const found = findUniformArray(child, path === "$" ? key : `${path}.${key}`, depth + 1);
    if (found) return found;
  }
  return null;
}

function encodeCell(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "string") {
    return /[",\n\r\t]/.test(value) ? JSON.stringify(value) : value;
  }
  return JSON.stringify(value);
}

function jsonToToon(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const found = findUniformArray(parsed);
  if (!found) return null;
  const header = `${found.path === "$" ? "root" : found.path}[${found.rows.length}]{${found.keys.join(",")}}:`;
  const rows = found.rows.map((row) => found.keys.map((key) => encodeCell(row[key])).join(","));
  return {
    kind: "json-toon",
    text: [
      "[dsh-token-saver: lossless JSON → TOON table; each row is one object, keys are in the header]",
      header,
      ...rows,
    ].join("\n"),
  };
}

function jsonlToToon(text) {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "");
  if (lines.length < 8) return null;
  const rows = [];
  for (const line of lines) {
    try {
      const value = JSON.parse(line);
      if (!isPlainObject(value)) return null;
      rows.push(value);
    } catch {
      return null;
    }
  }
  const keys = Object.keys(rows[0]);
  if (keys.length === 0 || keys.length > 24) return null;
  if (!rows.every((row) => keys.every((key) => Object.hasOwn(row, key)))) return null;
  return {
    kind: "jsonl-toon",
    text: [
      "[dsh-token-saver: lossless JSONL → TOON table; each row is one object, keys are in the header]",
      `jsonl[${rows.length}]{${keys.join(",")}}:`,
      ...rows.map((row) => keys.map((key) => encodeCell(row[key])).join(",")),
    ].join("\n"),
  };
}

function splitTableLine(line, delimiter) {
  if (delimiter === "  ") return line.trim().split(/ {2,}/);
  return line.split(delimiter).map((cell) => cell.trim());
}

function tableShape(lines) {
  const candidates = [
    { delimiter: "|", min: 2 },
    { delimiter: "\t", min: 1 },
    { delimiter: "  ", min: 1 },
  ];
  let best = null;
  for (const candidate of candidates) {
    const matching = lines.filter((line) => {
      if (line.trim() === "") return false;
      if (candidate.delimiter === "  ") return / {2,}/.test(line);
      return line.split(candidate.delimiter).length - 1 >= candidate.min;
    });
    if (matching.length < Math.max(10, Math.ceil(lines.length * 0.6))) continue;
    const counts = new Map();
    for (const line of matching) {
      const count = splitTableLine(line, candidate.delimiter).length;
      counts.set(count, (counts.get(count) ?? 0) + 1);
    }
    const [columns, hits] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? [0, 0];
    if (columns < 2 || hits < Math.max(10, Math.ceil(matching.length * 0.7))) continue;
    if (!best || hits > best.hits) best = { ...candidate, columns, hits };
  }
  return best;
}

function tableToStride(text, maxRows = 60, tailRows = 40, samples = 50) {
  const lines = text.split(/\r?\n/);
  if (lines.length < 40) return null;
  const shape = tableShape(lines);
  if (!shape) return null;
  const headerCount = /^[\s|:\-]+$/.test(lines[1] ?? "") ? 2 : 1;
  const body = lines.slice(headerCount);
  if (body.length <= maxRows + tailRows + 5) return null;
  const head = body.slice(0, maxRows);
  const tail = body.slice(-tailRows);
  const middle = body.slice(maxRows, body.length - tailRows);
  const step = Math.max(1, Math.ceil(middle.length / samples));
  const sampled = [];
  for (let i = 0; i < middle.length; i += step) {
    sampled.push(`L${headerCount + maxRows + i + 1}: ${middle[i]}`);
  }
  const out = [
    `[dsh-token-saver: table stride sample; ${body.length} data rows, ${shape.columns} columns]`,
    ...lines.slice(0, headerCount),
    ...head,
    `[... ${Math.max(0, middle.length - sampled.length)} rows omitted between head and tail; sampled rows keep original line numbers ...]`,
    ...sampled,
    ...tail,
  ];
  return { kind: "table-stride", text: out.join("\n") };
}

const ERROR_LINE = /\b(error|fatal|traceback|exception|timeout|timed out|failed|failure|panic|assertionerror|assert failed|✗|×)\b/i;
const SUMMARY_LINE = /^\s*(?:FAIL|PASS|ERROR|WARNING|Tests?|Test Files|Test Suites|Suites?)\b.*(?:\d+|passed|failed|skipped)/i;

function logToElision(text) {
  const lines = text.split(/\r?\n/);
  if (lines.length < 30) return null;
  const keep = new Set();
  for (let i = 0; i < lines.length; i++) {
    if (ERROR_LINE.test(lines[i]) || SUMMARY_LINE.test(lines[i])) {
      keep.add(i - 1);
      keep.add(i);
      keep.add(i + 1);
    }
  }
  if (keep.size === 0) return null;
  for (let i = 0; i < Math.min(15, lines.length); i++) keep.add(i);
  for (let i = Math.max(0, lines.length - 15); i < lines.length; i++) keep.add(i);
  const out = [];
  let omitted = 0;
  let runStart = -1;
  const flush = (end) => {
    if (runStart < 0) return;
    const count = end - runStart;
    if (count >= 3) {
      out.push(`[... ${count} lines omitted (L${runStart + 1}-L${end}) ...]`);
      omitted += count;
    } else {
      for (let i = runStart; i < end; i++) out.push(lines[i]);
    }
    runStart = -1;
  };
  for (let i = 0; i < lines.length; i++) {
    if (keep.has(i)) {
      flush(i);
      out.push(lines[i]);
    } else if (runStart < 0) {
      runStart = i;
    }
  }
  flush(lines.length);
  if (omitted < 5) return null;
  return { kind: "log-elision", text: out.join("\n") };
}

function looksLikePath(value) {
  const line = String(value ?? "").trim();
  if (!line || line.length > 500) return false;
  if (/^Line\s+\d+/i.test(line)) return false;
  if (/^(Found|Total)\b/i.test(line)) return false;
  return /[\\/]/.test(line) || /\.[A-Za-z0-9]{1,10}$/.test(line);
}

function parseGrep(text) {
  const files = new Map();
  let current = null;
  let declared = null;
  const add = (file, lineNumber, content) => {
    const key = file.trim();
    if (!key) return;
    let entry = files.get(key);
    if (!entry) {
      entry = { count: 0, samples: [] };
      files.set(key, entry);
    }
    entry.count += 1;
    if (entry.samples.length < 2) entry.samples.push({ line: lineNumber, text: String(content ?? "").trim() });
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    const found = line.match(/^(?:Found\s+)?(\d+)\s+matches?\b/i);
    if (found) {
      declared = Number(found[1]);
      continue;
    }
    const lineMatch = line.match(/^Line\s+(\d+):\s?(.*)$/i);
    if (lineMatch) {
      if (current) add(current, Number(lineMatch[1]), lineMatch[2]);
      continue;
    }
    const colonMatch = line.match(/^(.+?):(\d+):(.*)$/);
    if (colonMatch && looksLikePath(colonMatch[1])) {
      current = colonMatch[1].trim();
      add(current, Number(colonMatch[2]), colonMatch[3]);
      continue;
    }
    if (looksLikePath(line)) {
      current = line.trim();
      if (!files.has(current)) files.set(current, { count: 0, samples: [] });
      continue;
    }
    current = null;
  }
  const entries = [...files.entries()].filter(([, entry]) => entry.count > 0);
  if (entries.length === 0) return null;
  entries.sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]));
  const total = declared ?? entries.reduce((sum, [, entry]) => sum + entry.count, 0);
  return { files: entries, total, declared };
}

function grepToCountFirst(text) {
  const parsed = parseGrep(text);
  if (!parsed) return null;
  const top = parsed.files.slice(0, 12);
  const lines = [
    `[dsh-token-saver: count-first mode — ${parsed.total} matches in ${parsed.files.length} files; full output: ${SPILL_PLACEHOLDER}]`,
    "Top files:",
    ...top.map(([file, entry]) => `  ${String(entry.count).padStart(5)}  ${file}`),
  ];
  if (parsed.files.length > top.length) lines.push(`  … ${parsed.files.length - top.length} more files (see full output)`);
  lines.push("Samples:");
  for (const [file, entry] of parsed.files.slice(0, 3)) {
    for (const sample of entry.samples.slice(0, 1)) {
      lines.push(`  ${file}:${sample.line}: ${sample.text.slice(0, 200)}`);
    }
  }
  return { kind: "grep-count-first", text: lines.join("\n") };
}

function globToPaths(text) {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "");
  let declared = null;
  const paths = [];
  for (const line of lines) {
    const found = line.match(/^(?:Found\s+)?(\d+)\s+files?\b/i);
    if (found) {
      declared = Number(found[1]);
      continue;
    }
    if (looksLikePath(line)) paths.push(line.trim());
  }
  if (paths.length < 30) return null;
  const extensions = new Map();
  const directories = new Map();
  for (const file of paths) {
    const ext = (file.match(/\.[A-Za-z0-9]{1,10}$/)?.[0] ?? "(none)").toLowerCase();
    extensions.set(ext, (extensions.get(ext) ?? 0) + 1);
    const parts = file.replaceAll("\\", "/").split("/").filter(Boolean);
    const dir = parts.slice(0, Math.min(2, Math.max(1, parts.length - 1))).join("/") || "(root)";
    directories.set(dir, (directories.get(dir) ?? 0) + 1);
  }
  const top = (map, count) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, count);
  const linesOut = [
    `[dsh-token-saver: paths mode — ${declared ?? paths.length} files; full list: ${SPILL_PLACEHOLDER}]`,
    "By extension:",
    ...top(extensions, 8).map(([ext, count]) => `  ${String(count).padStart(5)}  ${ext}`),
    "By directory:",
    ...top(directories, 10).map(([dir, count]) => `  ${String(count).padStart(5)}  ${dir}`),
    "First paths:",
    ...paths.slice(0, 10).map((file) => `  ${file}`),
  ];
  return { kind: "glob-paths", text: linesOut.join("\n") };
}

function articleCleanup(text) {
  const lines = text.split(/\r?\n/);
  const counts = new Map();
  for (const line of lines) {
    if (line.trim().length >= 20) counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  const out = [];
  let blankRun = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      blankRun += 1;
      if (blankRun <= 1) out.push("");
      continue;
    }
    blankRun = 0;
    if ((counts.get(line) ?? 0) > 3) continue; // repeated navigation/banner line
    out.push(line.replace(/[ \t]+$/g, ""));
  }
  return out.join("\n").trim();
}

function fitStructuredBudget(res, budget) {
  if (!res) return null;
  const maxTokens = Math.max(200, budget - 200);
  if (priceText(res.text) <= maxTokens) return res;
  const lines = res.text.split("\n");
  const header = lines[0]?.startsWith("[dsh-token-saver:") ? `${lines[0]}\n` : "";
  const body = header ? lines.slice(1).join("\n") : res.text;
  const headerTokens = header ? priceText(header) : 0;
  const bounded = headTail(body, Math.max(100, maxTokens - headerTokens));
  return { kind: `${res.kind}+capped`, text: `${header}${bounded}` };
}

function compressText(text, profile, budget) {
  const normalized = String(text ?? "");
  if (!normalized) return null;
  const tryJson = () => jsonToToon(normalized);
  const tryJsonl = () => jsonlToToon(normalized);
  const tryGrep = () => grepToCountFirst(normalized);
  const tryGlob = () => globToPaths(normalized);
  const tryLog = () => logToElision(normalized);
  const tryTable = () => tableToStride(normalized);
  const fallback = () => ({ kind: "head-tail", text: headTail(normalized, Math.max(0, budget - 200)) });

  let chosen;
  switch (profile) {
    case "json":
      chosen = tryJson() || tryJsonl() || tryTable() || fallback();
      break;
    case "matches":
      chosen = tryGrep() || tryLog() || fallback();
      break;
    case "paths":
      chosen = tryGlob() || fallback();
      break;
    case "log":
      chosen = tryLog() || tryTable() || fallback();
      break;
    case "table":
      chosen = tryTable() || tryLog() || fallback();
      break;
    case "article": {
      const cleaned = articleCleanup(normalized);
      chosen = { kind: "article", text: headTail(cleaned, Math.max(0, budget - 200)) };
      break;
    }
    case "auto": {
      chosen = tryJson() || tryJsonl() || tryGrep() || tryGlob() || tryLog() || tryTable() || fallback();
      break;
    }
    default:
      chosen = fallback();
      break;
  }
  return fitStructuredBudget(chosen, budget);
}

/** Never-worse gate: returns the saving record or null when the candidate is not worth adopting. */
function gate(original, candidate, cfg) {
  const originalBytes = byteLength(original);
  const candidateBytes = byteLength(candidate);
  const savedBytes = originalBytes - candidateBytes;
  if (savedBytes <= 0) return null;
  if (candidateBytes > originalBytes * cfg.keepRatioMax) return null;
  if (savedBytes < cfg.minSavingBytes) return null;
  const originalTokens = priceText(original);
  const candidateTokens = priceText(candidate);
  if (candidateTokens >= originalTokens) return null;
  return { originalBytes, candidateBytes, savedBytes, savedTokens: originalTokens - candidateTokens };
}

/* ── Per-agent state and stats ── */

function newStats() {
  return {
    evaluated: 0,
    compressed: 0,
    deduped: 0,
    shadowWouldCompress: 0,
    shadowWouldDedupe: 0,
    savedBytes: 0,
    savedTokens: 0,
    shadowSavedBytes: 0,
    shadowSavedTokens: 0,
    byProfile: new Map(),
    byTool: new Map(),
    lastAt: 0,
  };
}

function stateOf(states, agent) {
  let state = states.get(agent);
  if (!state) {
    state = {
      step: 0,
      reminded: new Set(),
      reads: new Map(),
      readNudged: new Set(),
      dedupe: new Map(),
      stats: newStats(),
    };
    states.set(agent, state);
  }
  return state;
}

function bump(map, key, amount = 1) {
  map.set(key, (map.get(key) ?? 0) + amount);
}

function record(state, stat, profile, toolName, saving) {
  const s = state.stats;
  s.evaluated += 1;
  s.lastAt = Date.now();
  const shadow = stat.startsWith("shadow-");
  if (stat === "compressed") s.compressed += 1;
  if (stat === "deduped") s.deduped += 1;
  if (stat === "shadow-compressed") s.shadowWouldCompress += 1;
  if (stat === "shadow-deduped") s.shadowWouldDedupe += 1;
  if (saving) {
    if (shadow) {
      s.shadowSavedBytes += saving.savedBytes ?? 0;
      s.shadowSavedTokens += saving.savedTokens ?? 0;
    } else {
      s.savedBytes += saving.savedBytes ?? 0;
      s.savedTokens += saving.savedTokens ?? 0;
    }
    bump(s.byProfile, profile, 1);
    bump(s.byTool, toolName, 1);
  }
}

function statsText(state, cfg) {
  const s = state.stats;
  const mode = cfg.shadow ? "shadow" : "active";
  const profileRows = [...s.byProfile.entries()].sort((a, b) => b[1] - a[1]);
  const toolRows = [...s.byTool.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  return [
    `dsh-token-saver stats (${mode})`,
    `evaluated=${s.evaluated} compressed=${s.compressed} deduped=${s.deduped}`,
    `shadowWouldCompress=${s.shadowWouldCompress} shadowWouldDedupe=${s.shadowWouldDedupe}`,
    `saved≈${s.savedBytes} bytes / ${s.savedTokens} tokens`,
    `shadowSaved≈${s.shadowSavedBytes} bytes / ${s.shadowSavedTokens} tokens`,
    profileRows.length ? `byProfile=${profileRows.map(([k, v]) => `${k}:${v}`).join(", ")}` : "byProfile=(none)",
    toolRows.length ? `byTool=${toolRows.map(([k, v]) => `${k}:${v}`).join(", ")}` : "byTool=(none)",
  ].join("\n");
}

/* ── Core result processing ── */

function hashResult(exec, text) {
  const hash = createHash("sha256");
  hash.update(String(exec.name ?? ""));
  hash.update("\0");
  hash.update(JSON.stringify(exec.arguments ?? {}));
  hash.update("\0");
  hash.update(text);
  return hash.digest("hex");
}

function duplicateStub(entry) {
  return `(Duplicate output: byte-identical to a result from step ${entry.step}. Full text stored at: ${entry.locator}. ${RETRIEVAL_HINT})`;
}

async function processResult(ctx, exec, content, cfg, state) {
  if (!Array.isArray(content) || content.length === 0) return null;
  if (!content.every((block) => block.type === "text")) return null; // text-only; defer images to built-in policy
  const text = fullTextOf(content);
  if (!text) return null;

  const profile = profileFor(exec.name, cfg);
  const originalTokens = priceText(text);
  if (originalTokens <= profile.maxTokens) return null;

  const owner = exec.agent?.session?.header?.id;
  const spillStore = ctx.get("spillStore");
  if (owner === undefined || spillStore === undefined) return null;

  const hash = hashResult(exec, text);
  const now = Date.now();
  const existing = cfg.dedupe ? state.dedupe.get(hash) : undefined;
  if (existing && now - existing.at <= cfg.dedupeTtlMs) {
    const stub = duplicateStub(existing);
    if (cfg.shadow) {
      record(state, "shadow-deduped", profile.profile, exec.name, { savedBytes: byteLength(text), savedTokens: originalTokens });
      return null;
    }
    record(state, "deduped", profile.profile, exec.name, { savedBytes: byteLength(text), savedTokens: originalTokens });
    return { content: textBlock(stub) };
  }

  const candidateCore = compressText(text, profile.profile, profile.maxTokens);
  if (!candidateCore) return null;
  const candidate = `${candidateCore.text}\n\n${spillNotice(0, SPILL_PLACEHOLDER)}`;
  const saving = gate(text, candidate, cfg);
  if (!saving) return null;

  if (cfg.shadow) {
    record(state, "shadow-compressed", candidateCore.kind, exec.name, saving);
    return null;
  }

  let ref;
  try {
    ref = await spillStore.saveText({
      owner: { sessionId: owner },
      source: { kind: "tool", toolName: exec.name, callId: exec.callId, label: "result" },
      suggestedName: `${String(exec.name).replace(/[^A-Za-z0-9._-]+/g, "_")}.txt`,
      content: text,
    });
  } catch (error) {
    ctx.logger?.warn?.(`dsh-token-saver: spill failed for ${exec.name}: ${String(error)}; keeping inline content`);
    return null;
  }

  const omitted = Math.max(0, saving.originalBytes - byteLength(candidateCore.text));
  const finalText = `${candidateCore.text}\n\n${spillNotice(omitted, ref.locator)}`;
  if (cfg.dedupe) {
    state.dedupe.set(hash, { locator: ref.locator, step: state.step, at: now, bytes: saving.originalBytes });
    // Bound the map; an old session can otherwise accumulate every large result.
    if (state.dedupe.size > 200) {
      const oldest = [...state.dedupe.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) state.dedupe.delete(oldest[0]);
    }
  }
  record(state, "compressed", candidateCore.kind, exec.name, saving);
  return { content: textBlock(finalText) };
}

/* ── Module entry ── */

export function apply(ctx, config) {
  const cfg = normalizeConfig(config);
  if (!cfg.enabled) return;

  const stepThresholds = new Set(
    (cfg.stepThresholds ?? []).filter((n) => Number.isInteger(n) && n >= 1),
  );
  const states = new WeakMap();

  /* A1 — static guidance section (cache-stable; registered once). */
  if (cfg.batchGuidance) {
    ctx.systemPrompt.section({
      name: "dsh-token-saver:batch-guidance",
      order: 10150,
      interpolate: false,
      text: BATCH_GUIDANCE,
    });
  }

  /* A2 — count model steps; reset on a new user message (new turn). */
  ctx.on("agent/pre-step", ({ agent, messages }, next) => {
    const state = stateOf(states, agent);
    if (messages.some((message) => message.source?.kind === "user")) {
      state.step = 0;
      state.reminded = new Set();
      state.reads = new Map();
      state.readNudged = new Set();
    }
    state.step += 1;
    return next();
  });

  /* A3 — track read ranges; invalidate on edit/write; flag subset re-reads once per file. */
  function observeRead(state, exec) {
    const args = exec.arguments ?? {};
    if (exec.name === "edit" || exec.name === "write" || exec.name === "ops_edit_file" || exec.name === "ops_write_file" || exec.name === "str_replace_editor") {
      const p = args.file_path ?? args.path;
      if (p) {
        state.reads.delete(normPath(p));
        state.readNudged.delete(normPath(p));
      }
      return null;
    }
    if (exec.name !== "read") return null;
    const p = args.file_path ?? args.path;
    if (!p) return null;
    const key = normPath(p);
    const offset = Number.isFinite(args.offset) ? args.offset : 1;
    const limit = Number.isFinite(args.limit) ? args.limit : 2000;
    const start = offset;
    const end = offset + limit;
    const ranges = state.reads.get(key) ?? [];
    const redundant = ranges.some(([a, b]) => start >= a && end <= b);
    ranges.push([start, end]);
    state.reads.set(key, ranges);
    if (redundant && !state.readNudged.has(key)) {
      state.readNudged.add(key);
      return redundantReadReminder(p);
    }
    return null;
  }

  /* A2 + A3 advisories and B result shaping, all on the post-execute waterfall.
     Appended (no prepend) so this runs INSIDE the prepended built-in spill-policy:
     next() yields the original result, we shape the full text once at our tighter
     budget, and the outer spill-policy sees an already-bounded result. */
  ctx.on("tools/post-execute", async (exec, result, next) => {
    const downstream = await next();
    const contexts = [];
    const state = exec.agent ? stateOf(states, exec.agent) : null;

    if (state && stepThresholds.has(state.step) && !state.reminded.has(state.step)) {
      state.reminded.add(state.step);
      contexts.push(notice(stepReminder(state.step), `step-budget ${state.step}`));
    }
    if (state && cfg.redundantReadReminder) {
      const reminder = observeRead(state, exec);
      if (reminder) contexts.push(notice(reminder, "redundant-read"));
    }

    let content;
    const excluded = cfg.excludeTools.some((pattern) => matchesTool(exec.name, pattern));
    const allowed = cfg.spillTools.some((pattern) => matchesTool(exec.name, pattern));
    const scopeOk = cfg.includeSubagents || exec.parent === undefined;
    if (
      state &&
      downstream.kind === "accept" &&
      !Object.hasOwn(downstream, "value") &&
      scopeOk &&
      allowed &&
      !excluded
    ) {
      const base = downstream.content ?? result.content;
      const processed = await processResult(ctx, exec, base, cfg, state);
      if (processed) content = processed.content;
    }

    if (contexts.length === 0 && content === undefined) return downstream;
    const additionalContexts = [...contexts, ...(downstream.additionalContexts ?? [])];
    if (downstream.kind === "block") {
      return { kind: "block", feedback: downstream.feedback, additionalContexts };
    }
    return {
      ...downstream,
      ...(content !== undefined ? { content } : {}),
      additionalContexts,
    };
  });

  /* Optional human command: /token-saver stats — no model tokens, per dsh-commands. */
  if (cfg.stats) {
    const commands = ctx.get("commands");
    if (commands?.register) {
      try {
        const dispose = commands.register({
          name: "token-saver",
          description: "Show dsh-token-saver compression and shadow statistics",
          input: { hint: "[stats]" },
          handler: ({ agent, rawInput }) => {
            const state = stateOf(states, agent);
            if (String(rawInput ?? "").trim() === "reset") {
              state.stats = newStats();
              return { kind: "success", text: "dsh-token-saver statistics reset." };
            }
            return { kind: "success", text: statsText(state, cfg) };
          },
        });
        if (typeof dispose === "function") ctx.effect?.(() => dispose);
      } catch (error) {
        ctx.logger?.warn?.(`dsh-token-saver: command registration skipped: ${String(error)}`);
      }
    }
  }
}

/* Exported for tests and for a future dashboard integration. */
export const __test = {
  compressText,
  gate,
  parseGrep,
  globToPaths,
  tableToStride,
  logToElision,
  jsonToToon,
  jsonlToToon,
  headTail,
  normalizeConfig,
};
