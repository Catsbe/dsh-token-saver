/**
 * dsh-token-saver — token-saving plugin for DeepSeek Harness.
 *
 * Two independent, append-only modules (no tool-set changes, no history rewrites,
 * so the KV-cache prefix stays stable):
 *
 *   A. Step-count optimization
 *      A1  a static system-prompt section nudging plan-first + parallel batching
 *      A2  a soft per-turn step budget that appends an advisory notice at thresholds
 *      A3  a conservative redundant re-read nudge (same file, subset range, unedited)
 *
 *   B. Conservative output management
 *      tighter per-tool inline budget for chatty tools (default pwsh / web_fetch);
 *      oversized text becomes a head/tail preview plus a spill file the model can
 *      read/grep in full. Nothing is discarded. Runs INSIDE the built-in spill-policy
 *      (appended, not prepended) so it sees the original full result and spills it once.
 *
 * Contracts mirror the shipped `repeat-tool-reminder` (A) and `spill-policy` (B).
 * @license Apache-2.0
 */
import z from "@deepseek-ai/schemastery";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { estimateContent } from "@deepseek-ai/dsh-token-meter/estimate";

export const name = "dsh-token-saver";
export const inject = ["tools", "systemPrompt"];

export const Config = z.object({
  /** Master switch. */
  enabled: z.boolean().default(true),
  /** A1: inject the plan-first / parallel-batching guidance section. */
  batchGuidance: z.boolean().default(true),
  /** A2: per-turn step counts that trigger an advisory notice; empty disables. */
  stepThresholds: z.array(z.number()).default([12, 20]),
  /** A3: nudge redundant re-reads of an unchanged file (subset of an earlier range). */
  redundantReadReminder: z.boolean().default(true),
  /** B: tools whose oversized text results get the tighter inline budget. */
  spillTools: z.array(z.string()).default(["pwsh", "web_fetch"]),
  /** B: estimated-token inline cap for the tools above (head/tail preview + spill file). */
  spillMaxTokens: z.number().default(4000),
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

/* ── Head/tail retention (ported from the shipped spill-policy; text-only use) ── */

/** Preserve a UTF-16 code point when a text budget cuts between its surrogates. */
function textSlice(text, length, tail) {
  let cut = tail ? text.length - length : length;
  const previous = text.charCodeAt(cut - 1);
  const current = text.charCodeAt(cut);
  if (previous >= 55296 && previous <= 56319 && current >= 56320 && current <= 57343) cut += tail ? 1 : -1;
  return tail ? text.slice(cut) : text.slice(0, cut);
}

/** Largest contiguous text end fitting a monotonic token estimate. */
function fitText(text, budget, tail, price) {
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = textSlice(text, middle, tail);
    if (candidate.length === 0 || price({ type: "text", text: candidate }) <= budget) low = middle;
    else high = middle - 1;
  }
  return textSlice(text, low, tail);
}

/** Retain contiguous head/tail ends within a token budget; report omitted bytes. */
function retainContent(content, budget, price) {
  const head = [];
  const tail = [];
  let first = 0;
  let last = content.length - 1;
  let headCharacters = 0;
  let remaining = Math.ceil(budget / 2);
  while (first <= last) {
    const block = content[first];
    const cost = price(block);
    if (cost <= remaining) { head.push(block); remaining -= cost; first++; continue; }
    if (block.type === "text") {
      const text = fitText(block.text, remaining, false, price);
      headCharacters = text.length;
      if (text.length > 0) head.push({ type: "text", text });
    }
    break;
  }
  remaining = Math.floor(budget / 2);
  while (last >= first) {
    const original = content[last];
    const block = last === first && original.type === "text"
      ? { type: "text", text: original.text.slice(headCharacters) }
      : original;
    const cost = price(block);
    if (cost <= remaining) { tail.push(block); remaining -= cost; last--; continue; }
    if (block.type === "text") {
      const text = fitText(block.text, remaining, true, price);
      if (text.length > 0) tail.push({ type: "text", text });
    }
    break;
  }
  tail.reverse();
  const bytes = (blocks) => blocks.reduce((t, b) => t + (b.type === "text" ? Buffer.byteLength(b.text, "utf8") : 0), 0);
  return { head, tail, omittedBytes: bytes(content) - bytes(head) - bytes(tail) };
}

const GAP = { type: "text", text: "\n\n[...]\n\n" };

/** Notice wording identical to the built-in spill-policy so the model recognizes it. */
function spillNotice(omittedBytes, ref) {
  return `(Omitted ${omittedBytes} bytes. Full formatted result stored at: ${ref.locator}. ${ref.retrievalHint})`;
}

/* ── Small helpers ── */

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

/**
 * Recoverably bound one text-only result to maxTokens; failures keep content inline.
 * Returns the replacement content blocks, or null to leave the decision unchanged.
 */
async function boundOutput(ctx, exec, content, maxTokens) {
  if (!Array.isArray(content) || content.length === 0) return null;
  if (!content.every((b) => b.type === "text")) return null; // text-only; defer images to built-in policy
  const price = (block) => estimateContent([block]);
  if (content.reduce((t, b) => t + price(b), 0) <= maxTokens) return null;
  const owner = exec.agent?.session?.header?.id;
  const spillStore = ctx.get("spillStore");
  if (owner === undefined || spillStore === undefined) return null; // cannot spill safely
  const fullText = content.map((b) => b.text).join("");
  let ref;
  try {
    ref = await spillStore.saveText({
      owner: { sessionId: owner },
      source: { kind: "tool", toolName: exec.name, callId: exec.callId, label: "result" },
      suggestedName: `${exec.name}.txt`,
      content: fullText,
    });
  } catch (error) {
    ctx.logger?.warn?.(`dsh-token-saver: spill failed for ${exec.name}: ${String(error)}; keeping inline content`);
    return null;
  }
  const totalBytes = Buffer.byteLength(fullText, "utf8");
  const worstNotice = spillNotice(totalBytes, ref);
  if (price({ type: "text", text: worstNotice }) > maxTokens) return null; // notice would not fit
  const reserved = price(GAP) + price({ type: "text", text: `\n\n${worstNotice}` });
  const retained = retainContent(content, Math.max(0, maxTokens - reserved), price);
  const footer = { type: "text", text: `\n\n${spillNotice(retained.omittedBytes, ref)}` };
  const result = retained.head.length + retained.tail.length === 0
    ? [footer]
    : [...retained.head, GAP, ...retained.tail, footer];
  const merged = [];
  for (const block of result) {
    const previous = merged.at(-1);
    if (block.type === "text" && previous?.type === "text") previous.text += block.text;
    else merged.push({ ...block });
  }
  return merged;
}

export function apply(ctx, config) {
  if (config.enabled === false) return;

  const stepThresholds = new Set(
    (config.stepThresholds ?? []).filter((n) => Number.isInteger(n) && n >= 1),
  );
  const spillTools = new Set(config.spillTools ?? []);
  const spillMaxTokens = Number.isSafeInteger(config.spillMaxTokens) && config.spillMaxTokens > 0
    ? config.spillMaxTokens
    : 4000;

  /* A1 — static guidance section (cache-stable; registered once). */
  if (config.batchGuidance !== false) {
    ctx.systemPrompt.section({
      name: "dsh-token-saver:batch-guidance",
      order: 10150,
      interpolate: false,
      text: BATCH_GUIDANCE,
    });
  }

  /* Per-agent turn state. */
  const states = new WeakMap();
  function stateOf(agent) {
    let s = states.get(agent);
    if (!s) {
      s = { step: 0, reminded: new Set(), reads: new Map(), readNudged: new Set() };
      states.set(agent, s);
    }
    return s;
  }

  /* A2 — count model steps; reset on a new user message (new turn). */
  ctx.on("agent/pre-step", ({ agent, messages }, next) => {
    const s = stateOf(agent);
    if (messages.some((m) => m.source?.kind === "user")) {
      s.step = 0;
      s.reminded = new Set();
      s.reads = new Map();
      s.readNudged = new Set();
    }
    s.step += 1;
    return next();
  });

  /* A3 — track read ranges; invalidate on edit/write; flag subset re-reads once per file. */
  function observeRead(s, exec) {
    const args = exec.arguments ?? {};
    if (exec.name === "edit" || exec.name === "write") {
      const p = args.file_path ?? args.path;
      if (p) { s.reads.delete(normPath(p)); s.readNudged.delete(normPath(p)); }
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
    const ranges = s.reads.get(key) ?? [];
    const redundant = ranges.some(([a, b]) => start >= a && end <= b);
    ranges.push([start, end]);
    s.reads.set(key, ranges);
    if (redundant && !s.readNudged.has(key)) {
      s.readNudged.add(key);
      return redundantReadReminder(p);
    }
    return null;
  }

  /* A2 + A3 advisories and B spill, all on the post-execute waterfall.
     Appended (no prepend) so this runs INSIDE the prepended built-in spill-policy:
     next() yields the original result, we spill the full text once at our tighter
     budget, and the outer spill-policy then sees an already-bounded result. */
  ctx.on("tools/post-execute", async (exec, result, next) => {
    const downstream = await next();
    const contexts = [];
    const s = exec.agent ? stateOf(exec.agent) : null;

    if (s && stepThresholds.has(s.step) && !s.reminded.has(s.step)) {
      s.reminded.add(s.step);
      contexts.push(notice(stepReminder(s.step), `step-budget ${s.step}`));
    }
    if (s && config.redundantReadReminder !== false) {
      const r = observeRead(s, exec);
      if (r) contexts.push(notice(r, "redundant-read"));
    }

    let content;
    if (
      downstream.kind === "accept" &&
      !Object.hasOwn(downstream, "value") &&
      exec.parent === undefined &&
      spillTools.has(exec.name)
    ) {
      const base = downstream.content ?? result.content;
      const retained = await boundOutput(ctx, exec, base, spillMaxTokens);
      if (retained) content = retained;
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
}
