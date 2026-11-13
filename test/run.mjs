import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/* ── Generate minimal peer stubs so the test runs with zero install. ──
   These are test-only stand-ins for the modules the Harness provides at runtime.
   They are written into test/node_modules (gitignored) and never ship with the plugin. */
const nm = path.join(here, "node_modules", "@deepseek-ai");
function put(rel, content) {
  const p = path.join(nm, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, "utf8");
}
put("schemastery/package.json", JSON.stringify({ name: "@deepseek-ai/schemastery", version: "0.0.0-test", type: "module", main: "index.js" }));
put("schemastery/index.js", `function chain(){const c={default(){return c},required(){return c},min(){return c},max(){return c},step(){return c}};return c}
const z={object(){return chain()},array(){return chain()},string(){return chain()},number(){return chain()},boolean(){return chain()},const(){return chain()},union(){return chain()}};
export default z;
`);
put("dsh-llm/package.json", JSON.stringify({ name: "@deepseek-ai/dsh-llm", version: "0.0.0-test", type: "module", main: "index.js" }));
put("dsh-llm/index.js", `import { randomUUID } from "node:crypto";
export function createUserMessage(input){return Object.freeze(structuredClone({ ...input, id: randomUUID(), role: "user" }))}
`);
put("dsh-token-meter/package.json", JSON.stringify({ name: "@deepseek-ai/dsh-token-meter", version: "0.0.0-test", type: "module", exports: { "./estimate": "./estimate.js" } }));
put("dsh-token-meter/estimate.js", `const CPT=4,BO=4;
export function estimateContent(blocks){let t=0;for(const b of blocks){if(b.type==="text"||b.type==="reasoning")t+=Math.ceil(b.text.length/CPT)+BO;else if(b.type==="tool-call")t+=Math.ceil(b.name.length/CPT)+Math.ceil(b.arguments.length/CPT)+BO;else t+=BO+Math.ceil(JSON.stringify(b).length/CPT)}return t}
`);

// Import a fresh copy of the lib so peer deps resolve from test/node_modules (stubs),
// keeping the package root free of a node_modules that could shadow real peers in prod.
fs.copyFileSync(path.join(here, "..", "lib", "index.js"), path.join(here, "_plugin.mjs"));
const { name, inject, apply } = await import("./_plugin.mjs");
const { estimateContent } = await import("@deepseek-ai/dsh-token-meter/estimate");

// ── mock cordis context ──
function makeCtx() {
  const sections = [];
  const listeners = {};
  const spillCalls = [];
  const warnings = [];
  const spillStore = {
    async saveText(req) {
      spillCalls.push(req);
      return {
        locator: `/spill/${req.suggestedName}`,
        bytes: Buffer.byteLength(req.content, "utf8"),
        retrievalHint: "Use read with offset/limit, or grep this path to search within it.",
      };
    },
  };
  const ctx = {
    systemPrompt: { section: (s) => { sections.push(s); return () => {}; } },
    on: (ev, fn, opts) => { (listeners[ev] ??= []).push({ fn, opts }); return () => {}; },
    get: (n) => (n === "spillStore" ? spillStore : undefined),
    logger: { warn: (...a) => warnings.push(a.join(" ")) },
  };
  return { ctx, sections, listeners, spillCalls, warnings };
}

function preStep(listeners, agent, messages) {
  const ls = (listeners["agent/pre-step"] ?? []).map((l) => l.fn);
  let i = 0;
  const next = () => (i < ls.length ? ls[i++]({ agent, messages }, next) : undefined);
  return next();
}

// Waterfall: outer (prepended) listeners first, then my (appended) listener, then default.
function postExecute(listeners, exec, result, outer = []) {
  const mine = (listeners["tools/post-execute"] ?? []).map((l) => l.fn);
  const chain = [...outer, ...mine];
  let i = 0;
  const next = async () => (i < chain.length ? chain[i++](exec, result, next) : { kind: "accept", content: result.content });
  return next();
}

const text = (s) => [{ type: "text", text: s }];
const tokens = (content) => estimateContent(content);
const userMsg = { source: { kind: "user" } };
const toolMsg = { source: { kind: "tool" } };

let passed = 0;
function ok(cond, label) { assert.ok(cond, label); passed++; console.log("  ✓", label); }

// ── Test 1: identity + A1 section ──
console.log("T1 identity + A1 batch-guidance section");
{
  const { ctx, sections } = makeCtx();
  apply(ctx, { enabled: true, batchGuidance: true, stepThresholds: [12, 20], redundantReadReminder: true, spillTools: ["pwsh", "web_fetch"], spillMaxTokens: 4000 });
  ok(name === "dsh-token-saver", "name is dsh-token-saver");
  ok(inject.includes("tools") && inject.includes("systemPrompt"), "inject tools+systemPrompt");
  ok(sections.some((s) => s.name === "dsh-token-saver:batch-guidance" && /parallel/i.test(s.text)), "A1 section registered with parallel guidance");
  ok(sections.find((s) => s.name === "dsh-token-saver:batch-guidance").interpolate === false, "A1 section is literal (interpolate:false)");
}

// ── Test 2: A2 step budget reminder at threshold, reset on new turn ──
console.log("T2 A2 step-budget advisory");
{
  const { ctx, listeners } = makeCtx();
  apply(ctx, { enabled: true, batchGuidance: false, stepThresholds: [3, 5], redundantReadReminder: false, spillTools: [], spillMaxTokens: 4000 });
  const agent = {};
  preStep(listeners, agent, [userMsg]); // turn 1 step 1
  const exec = { agent, name: "grep", arguments: { pattern: "x" }, callId: "c1" };
  let d = await postExecute(listeners, exec, { content: text("ok") });
  ok((d.additionalContexts ?? []).length === 0, "no reminder at step 1");
  preStep(listeners, agent, [toolMsg]); // step 2
  await postExecute(listeners, exec, { content: text("ok") });
  preStep(listeners, agent, [toolMsg]); // step 3 -> threshold
  d = await postExecute(listeners, exec, { content: text("ok") });
  ok((d.additionalContexts ?? []).length === 1, "reminder fires at step 3");
  ok(/3 model steps/.test(d.additionalContexts[0].content[0].text), "reminder names the step count");
  ok(d.additionalContexts[0].source.kind === "dsh-token-saver", "reminder source is dsh-token-saver (not user)");
  preStep(listeners, agent, [toolMsg]); // step 4
  d = await postExecute(listeners, exec, { content: text("ok") });
  ok((d.additionalContexts ?? []).length === 0, "no repeat reminder at step 4");
  preStep(listeners, agent, [userMsg]); // NEW turn resets
  preStep(listeners, agent, [toolMsg]); // step 2 of new turn
  preStep(listeners, agent, [toolMsg]); // step 3 -> threshold again
  d = await postExecute(listeners, exec, { content: text("ok") });
  ok((d.additionalContexts ?? []).length === 1, "threshold fires again after turn reset");
}

// ── Test 3: A3 redundant re-read (subset), invalidated by edit ──
console.log("T3 A3 redundant re-read nudge");
{
  const { ctx, listeners } = makeCtx();
  apply(ctx, { enabled: true, batchGuidance: false, stepThresholds: [], redundantReadReminder: true, spillTools: [], spillMaxTokens: 4000 });
  const agent = {};
  preStep(listeners, agent, [userMsg]);
  const read = (args, id) => ({ agent, name: "read", arguments: args, callId: id });
  let d = await postExecute(listeners, read({ file_path: "a.py", offset: 1, limit: 2000 }, "r1"), { content: text("file") });
  ok((d.additionalContexts ?? []).length === 0, "first read: no nudge");
  d = await postExecute(listeners, read({ file_path: "a.py", offset: 10, limit: 100 }, "r2"), { content: text("file") });
  ok((d.additionalContexts ?? []).length === 1, "subset re-read: nudge fires");
  d = await postExecute(listeners, read({ file_path: "a.py", offset: 20, limit: 50 }, "r3"), { content: text("file") });
  ok((d.additionalContexts ?? []).length === 0, "second subset re-read: capped to once per file");
  d = await postExecute(listeners, read({ file_path: "a.py", offset: 5000, limit: 100 }, "r4"), { content: text("file") });
  ok((d.additionalContexts ?? []).length === 0, "new disjoint range: no nudge");
  // edit invalidates
  await postExecute(listeners, { agent, name: "edit", arguments: { file_path: "a.py" }, callId: "e1" }, { content: text("edited") });
  d = await postExecute(listeners, read({ file_path: "a.py", offset: 10, limit: 100 }, "r5"), { content: text("file") });
  ok((d.additionalContexts ?? []).length === 0, "after edit, re-read is not flagged");
}

// ── Test 4: B spill for pwsh (tighter budget), full text saved once ──
console.log("T4 B conservative spill (pwsh)");
{
  const { ctx, listeners, spillCalls } = makeCtx();
  apply(ctx, { enabled: true, batchGuidance: false, stepThresholds: [], redundantReadReminder: false, spillTools: ["pwsh", "web_fetch"], spillMaxTokens: 4000 });
  const agent = { session: { header: { id: "sess-1" } } };
  preStep(listeners, agent, [userMsg]);
  const big = "line of output\n".repeat(4000); // ~15k tokens
  const exec = { agent, name: "pwsh", arguments: { command: "ls" }, callId: "p1" };
  const d = await postExecute(listeners, exec, { content: text(big) });
  ok(spillCalls.length === 1, "spill saved exactly once");
  ok(spillCalls[0].content === big, "spill file holds the FULL original text");
  ok(spillCalls[0].owner.sessionId === "sess-1", "spill owned by the session");
  ok(tokens(d.content) <= 4000, `preview within budget (got ${tokens(d.content)})`);
  ok(d.content.some((b) => b.type === "text" && b.text.includes("/spill/pwsh.txt")), "preview points to the spill file");
  ok(d.content.some((b) => b.type === "text" && b.text.includes("Omitted")), "preview has omission notice");
  ok(d.content[0].text.startsWith("line of output"), "head preserved");
  ok(d.content.at(-1).text.includes("line of output"), "tail preserved");
}

// ── Test 5: B ordering — runs INSIDE built-in spill-policy, no double spill ──
console.log("T5 B inside built-in spill-policy (no double spill)");
{
  const { ctx, listeners, spillCalls } = makeCtx();
  apply(ctx, { enabled: true, batchGuidance: false, stepThresholds: [], redundantReadReminder: false, spillTools: ["pwsh"], spillMaxTokens: 4000 });
  const agent = { session: { header: { id: "sess-2" } } };
  preStep(listeners, agent, [userMsg]);
  // Mock of the built-in spill-policy (prepended/outer, 12.5k cap). It calls next() then bounds.
  const builtinSpillPolicy = async (exec, result, next) => {
    const decision = await next();
    if (decision.kind !== "accept" || exec.name === "read") return decision;
    const content = decision.content ?? result.content;
    if (tokens(content) <= 12500) return decision; // already small -> pass through
    spillCalls.push({ from: "builtin", content: content.map((b) => b.text).join("") });
    return { kind: "accept", content: text("[builtin retained to 12.5k]") };
  };
  const big = "x".repeat(200000); // ~50k tokens, > both budgets
  const exec = { agent, name: "pwsh", arguments: {}, callId: "p2" };
  const d = await postExecute(listeners, exec, { content: text(big) }, [builtinSpillPolicy]);
  ok(spillCalls.length === 1, "only ONE spill total (mine, not builtin)");
  ok(spillCalls[0].from === undefined, "the single spill is from dsh-token-saver");
  ok(spillCalls[0].content === big, "dsh-token-saver spilled the full original (not a pre-truncated copy)");
  ok(tokens(d.content) <= 4000, "final preview within the tighter 4k budget");
}

// ── Test 6: B leaves non-target tools and small results alone ──
console.log("T6 B scope guards");
{
  const { ctx, listeners, spillCalls } = makeCtx();
  apply(ctx, { enabled: true, batchGuidance: false, stepThresholds: [], redundantReadReminder: false, spillTools: ["pwsh", "web_fetch"], spillMaxTokens: 4000 });
  const agent = { session: { header: { id: "s" } } };
  preStep(listeners, agent, [userMsg]);
  const big = "y".repeat(100000);
  let d = await postExecute(listeners, { agent, name: "read", arguments: {}, callId: "r" }, { content: text(big) });
  ok(spillCalls.length === 0 && d.content[0].text === big, "read untouched");
  d = await postExecute(listeners, { agent, name: "pwsh", arguments: {}, callId: "p" }, { content: text("short") });
  ok(spillCalls.length === 0 && d.content[0].text === "short", "small pwsh untouched");
  d = await postExecute(listeners, { agent, name: "web_fetch", arguments: {}, callId: "w" }, { content: text(big) });
  ok(spillCalls.length === 1, "web_fetch spilled");
}

// ── Test 7: master switch off ──
console.log("T7 enabled:false is a no-op");
{
  const { ctx, sections, listeners } = makeCtx();
  apply(ctx, { enabled: false });
  ok(sections.length === 0, "no section when disabled");
  ok(Object.keys(listeners).length === 0, "no listeners when disabled");
}

console.log(`\nALL ${passed} ASSERTIONS PASSED`);
