#!/usr/bin/env node
/**
 * Review the cognitive-feedback event log.
 *
 * The log is append-only JSONL at \`$DSH_HOME/cognitive-feedback/events.jsonl\`.
 * This tool turns it into a session-by-session funnel so the plugin can actually
 * be reviewed after real use instead of judged from one interaction.
 *
 * Usage:
 *   node tools/cognitive-report.mjs                 # summary over the whole log
 *   node tools/cognitive-report.mjs --days 7        # last 7 days only
 *   node tools/cognitive-report.mjs --session <id>  # one session's full timeline
 *   node tools/cognitive-report.mjs --json          # machine-readable
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const flag = (name, fallback = undefined) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
const asJson = args.includes('--json');
const sessionFilter = flag('--session');
const days = Number(flag('--days', '0')) || 0;
const logPath = flag('--log') ?? join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'cognitive-feedback', 'events.jsonl');

let events = [];
try {
  events = readFileSync(logPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
} catch (error) {
  console.error(`cannot read ${logPath}: ${error.message}`);
  process.exit(1);
}

if (days > 0) {
  const cutoff = Date.now() - days * 86400000;
  events = events.filter((e) => Date.parse(e.timestamp) >= cutoff);
}
if (sessionFilter) events = events.filter((e) => e.sessionId === sessionFilter);

const byType = (type) => events.filter((e) => e.type === type);
const short = (id) => String(id ?? '').replace(/^session-/, '').slice(0, 8);
const time = (iso) => String(iso ?? '').replace('T', ' ').slice(0, 19);

const interventions = byType('intervention.triggered');
const reports = {
  log: logPath,
  window: events.length
    ? { from: events[0].timestamp, to: events[events.length - 1].timestamp }
    : null,
  totals: {
    events: events.length,
    sessions: new Set(events.map((e) => e.sessionId)).size,
    sessionsStarted: byType('session.started').length,
  },
  funnel: {
    sessionsStarted: byType('session.started').length,
    interventionsIssued: interventions.length,
    hypothesesSubmitted: byType('hypothesis.submitted').length,
    decisionsRecorded: byType('decision.recorded').length,
    teachingBackRequested: byType('teaching_back.requested').length,
    teachingBackCompleted: byType('teaching_back.completed').length,
    knowledgeGapsDetected: byType('knowledge_gap.detected').length,
  },
  interventionsByReason: interventions.reduce((acc, e) => {
    const key = `${e.payload?.reason ?? 'unknown'} (level ${e.payload?.level ?? '?'})`;
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {}),
  teachingBackResults: byType('teaching_back.completed').reduce((acc, e) => {
    const key = e.payload?.result ?? 'unknown';
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {}),
  timeline: events.map((e) => ({
    at: e.timestamp,
    session: e.sessionId,
    type: e.type,
    detail: e.payload?.reason ?? e.payload?.result ?? e.payload?.authorship ?? '',
  })),
};

// A gate that was answered is the single best signal that the loop closed.
const answered = reports.funnel.hypothesesSubmitted;
const issued = reports.funnel.interventionsIssued;
reports.rates = {
  gateAnsweredRate: issued > 0 ? Number((answered / issued).toFixed(3)) : null,
};

if (asJson) {
  console.log(JSON.stringify(reports, null, 2));
} else {
  const f = reports.funnel;
  console.log('=== cognitive feedback report ===');
  console.log(`log    : ${reports.log}`);
  if (reports.window) console.log(`window : ${time(reports.window.from)}  ->  ${time(reports.window.to)}`);
  console.log(`events : ${reports.totals.events} across ${reports.totals.sessions} session(s)`);
  console.log('');
  console.log('funnel');
  console.log(`  sessions started          ${f.sessionsStarted}`);
  console.log(`  interventions issued      ${f.interventionsIssued}`);
  console.log(`  user hypotheses submitted ${f.hypothesesSubmitted}`);
  console.log(`  decisions recorded        ${f.decisionsRecorded}`);
  console.log(`  teaching back requested   ${f.teachingBackRequested}`);
  console.log(`  teaching back completed   ${f.teachingBackCompleted}`);
  console.log(`  knowledge gaps detected   ${f.knowledgeGapsDetected}`);
  console.log('');
  if (Object.keys(reports.interventionsByReason).length) {
    console.log('interventions by reason');
    for (const [key, n] of Object.entries(reports.interventionsByReason)) console.log(`  ${key.padEnd(26)} ${n}`);
    console.log('');
  }
  if (Object.keys(reports.teachingBackResults).length) {
    console.log('teaching-back results');
    for (const [key, n] of Object.entries(reports.teachingBackResults)) console.log(`  ${key.padEnd(26)} ${n}`);
    console.log('');
  }
  console.log('timeline (newest last)');
  for (const row of reports.timeline.slice(-25)) {
    console.log(`  ${time(row.at)}  ${short(row.session).padEnd(9)} ${row.type.padEnd(24)} ${row.detail}`);
  }
  if (reports.timeline.length > 25) console.log(`  ... ${reports.timeline.length - 25} earlier event(s); use --json or --session`);
}
