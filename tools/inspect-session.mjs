#!/usr/bin/env node
/**
 * Inspect a DSH Session V3 log (`session.v3.jsonl.zstd`).
 *
 * DSH appends **one zstd frame per flush**, so the log is a concatenation of
 * frames and neither `zstdDecompressSync` nor the streaming decoder decodes
 * past the first one. This tool recovers every frame by attempting a decode at
 * each zstd magic position, validates the JSON, and de-duplicates by `seq`.
 *
 * Reports:
 *  - event-type histogram;
 *  - system-message node behaviour (proves dynamic section injection and shows
 *    whether the route appends in-history or normalizes the head);
 *  - provider usage, including cache read/write token counts.
 *
 * Usage: node tools/inspect-session.mjs <session.v3.jsonl.zstd> [--json] [--system]
 */
import { readFileSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';

const args = process.argv.slice(2);
const path = args.find((a) => !a.startsWith('--'));
const asJson = args.includes('--json');
const showSystem = args.includes('--system');
if (!path) {
  console.error('usage: node tools/inspect-session.mjs <session.v3.jsonl.zstd> [--json] [--system]');
  process.exit(2);
}

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** Recover every zstd frame in a concatenated log. */
function readEvents(file) {
  const buf = readFileSync(file);
  const positions = [];
  for (let i = buf.indexOf(ZSTD_MAGIC); i !== -1; i = buf.indexOf(ZSTD_MAGIC, i + 4)) positions.push(i);

  /** @type {Map<number, any>} */
  const bySeq = new Map();
  const unordered = [];
  for (const position of positions) {
    let text;
    try {
      text = zstdDecompressSync(buf.subarray(position)).toString('utf8');
    } catch {
      continue; // false-positive magic inside compressed data
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof event.seq === 'number') bySeq.set(event.seq, event);
      else unordered.push(event);
    }
  }
  const ordered = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  return [...unordered, ...ordered];
}

const events = readEvents(path);
const typeOf = (e) => e?.type ?? 'unknown';

/** @type {Record<string, number>} */
const histogram = {};
for (const event of events) histogram[typeOf(event)] = (histogram[typeOf(event)] ?? 0) + 1;

const textOf = (content) =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.filter((p) => p?.type === 'text').map((p) => p.text).join('\n')
      : '';

// --- system prompt nodes -------------------------------------------------
const systemNodes = [];
for (const event of events) {
  if (typeOf(event) !== 'system/message') continue;
  const text = textOf(event.data?.message?.content);
  systemNodes.push({
    seq: event.seq,
    turn: event.data?.turn,
    step: event.data?.step,
    length: text.length,
    hasCognitive: text.includes('COGNITIVE FEEDBACK'),
    // Cardinality matters: a duplicate section registration injects the block
    // twice. Asserting presence alone cannot catch that.
    cognitiveBlocks: (text.match(/\[COGNITIVE FEEDBACK\]/g) ?? []).length,
    head: text.slice(0, 80),
    text,
  });
}

// --- usage ---------------------------------------------------------------
const usageSamples = [];
for (const event of events) {
  const usage = event.data?.usage ?? event.data?.message?.usage;
  if (!usage) continue;
  usageSamples.push({
    seq: event.seq,
    type: typeOf(event),
    cacheReadTokens: usage.cacheReadTokens ?? 0,
    cacheWriteTokens: usage.cacheWriteTokens ?? 0,
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
  });
}

// --- tool schema set (proves the plugin never changes it) ---------------
const toolSets = [];
for (const event of events) {
  if (typeOf(event) !== 'request/header') continue;
  const tools = event.data?.header?.tools;
  if (!Array.isArray(tools)) continue;
  const names = tools.map((tool) => tool.name).sort();
  toolSets.push({ seq: event.seq, count: names.length, signature: names.join(',') });
}
const uniqueToolSignatures = [...new Set(toolSets.map((s) => s.signature))];

const sum = (key) => usageSamples.reduce((acc, s) => acc + (s[key] ?? 0), 0);
const cacheRead = sum('cacheReadTokens');
const cacheWrite = sum('cacheWriteTokens');
const uncachedInput = sum('inputTokens');
const billed = cacheRead + cacheWrite + uncachedInput;

const report = {
  file: path,
  events: events.length,
  histogram,
  systemMessages: {
    count: systemNodes.length,
    withCognitiveSection: systemNodes.filter((n) => n.hasCognitive).length,
    nodes: systemNodes.map(({ text, ...rest }) => rest),
  },
  toolSchema: {
    requests: toolSets.length,
    toolCount: toolSets[0]?.count ?? null,
    uniqueSignatures: uniqueToolSignatures.length,
    names: toolSets[0] ? toolSets[0].signature.split(',') : [],
  },
  usage: {
    samples: usageSamples.length,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    uncachedInputTokens: uncachedInput,
    outputTokens: sum('outputTokens'),
    billedInputTokens: billed,
    cacheHitRate: billed > 0 ? Number((cacheRead / billed).toFixed(4)) : null,
  },
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`events: ${report.events}`);
  console.log(`system/message nodes: ${systemNodes.length} (with cognitive section: ${report.systemMessages.withCognitiveSection})`);
  for (const node of systemNodes) {
    console.log(`  seq=${node.seq} turn=${node.turn} step=${node.step} len=${node.length} cognitive=${node.hasCognitive} blocks=${node.cognitiveBlocks}`);
    console.log(`    head: ${JSON.stringify(node.head)}`);
  }
  console.log(`tool schema: ${toolSets.length} request(s), ${report.toolSchema.toolCount ?? '?'} tools, ${uniqueToolSignatures.length} unique signature(s)`);
  if (uniqueToolSignatures.length > 1) console.log('  !! TOOL SET CHANGED BETWEEN REQUESTS');
  console.log(`usage samples: ${usageSamples.length}`);
  for (const s of usageSamples) {
    console.log(`  seq=${s.seq} ${s.type} cacheRead=${s.cacheReadTokens} cacheWrite=${s.cacheWriteTokens} uncachedInput=${s.inputTokens} output=${s.outputTokens}`);
  }
  console.log(`  TOTAL cacheRead=${cacheRead} cacheWrite=${cacheWrite} uncachedInput=${uncachedInput} cacheHitRate=${report.usage.cacheHitRate}`);
  console.log('types: ' + Object.entries(histogram).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(' '));
  if (showSystem) {
    for (const node of systemNodes) {
      console.log(`\n--- system node seq=${node.seq} (${node.length} chars) ---`);
      console.log(node.text);
    }
  }
}