#!/usr/bin/env node
/**
 * Review the cognitive-feedback event log.
 *
 * The log is append-only JSONL at `$DSH_HOME/cognitive-feedback/events.jsonl`.
 * This tool turns it into a session/episode/intervention view so the plugin can
 * be reviewed after real use instead of judged from one interaction.
 *
 * It reads the log through the real reader (`JsonlSink`), projects it in one
 * pass (`src/projection`), and caches the derived projection next to the log.
 * The raw JSONL stays authoritative: deleting the cache file loses nothing.
 *
 * Requires the build: `npm run build`
 *
 * Usage:
 *   node tools/cognitive-report.mjs                   # summary over the whole log
 *   node tools/cognitive-report.mjs --days 7          # last 7 days only
 *   node tools/cognitive-report.mjs --session <id>    # one session
 *   node tools/cognitive-report.mjs --episodes        # episode rows
 *   node tools/cognitive-report.mjs --topics          # knowledge-gap recurrence
 *   node tools/cognitive-report.mjs --compare <ISO>   # baseline vs feedback period
 *   node tools/cognitive-report.mjs --rebuild         # ignore + rewrite the cache
 *   node tools/cognitive-report.mjs --no-cache        # always project from raw
 *   node tools/cognitive-report.mjs --json            # machine-readable
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const flag = (name, fallback = undefined) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
const has = (name) => args.includes(name);
const asJson = has('--json');
const showEpisodes = has('--episodes');
const showTopics = has('--topics');
const sessionFilter = flag('--session');
const days = Number(flag('--days', '0')) || 0;
const defaultHome = process.env.DSH_HOME || join(homedir(), '.dsh');
const logPath = flag('--log') ?? join(defaultHome, 'cognitive-feedback', 'events.jsonl');

/** Load the built artifacts, or explain how to build them. */
async function loadRuntime() {
  try {
    const [projection, diskCache, sink] = await Promise.all([
      import('../dist/projection/index.js'),
      import('../dist/projection/disk-cache.js'),
      import('../dist/storage/jsonl-sink.js'),
    ]);
    return { projection, diskCache, sink };
  } catch (error) {
    console.error('cognitive-report needs the build output. Run "npm run build" first.');
    console.error(String(error && error.message ? error.message : error));
    process.exit(1);
  }
}

const { projection, diskCache, sink } = await loadRuntime();

if (!existsSync(logPath)) {
  console.error('cannot read ' + logPath + ': no such file');
  process.exit(1);
}

let events = await new sink.JsonlSink(logPath).readAll();
if (days > 0) {
  const cutoff = Date.now() - days * 86400000;
  events = events.filter((e) => Date.parse(e.timestamp) >= cutoff);
}
if (sessionFilter) events = events.filter((e) => e.sessionId === sessionFilter);

// The disk cache is keyed to the whole unfiltered log: a windowed projection is
// a different question and must never overwrite the canonical one.
const filtered = Boolean(sessionFilter) || days > 0;
const digest = projection.projectionDigest(events);
const cachePath = diskCache.cachePathFor(logPath);
let cacheSource = 'memory';
let report = null;

if (!filtered && !has('--no-cache')) {
  if (!has('--rebuild')) report = diskCache.loadProjectionCache(cachePath, digest);
  if (report) {
    cacheSource = 'disk';
  } else {
    report = projection.buildProjection(events);
    diskCache.saveProjectionCache(cachePath, digest, report);
    cacheSource = 'rebuilt';
  }
} else {
  report = projection.buildProjection(events);
}

const topics = projection.topicLearningStates(events, { now: Date.now() });
const metrics = projection.computeMetrics(events, { now: Date.now() });
const splitAt = flag('--compare');
const comparison = splitAt ? projection.comparePeriods(events, splitAt, { now: Date.now() }) : null;

const byType = (type) => events.filter((e) => e.type === type);
const short = (id) => String(id ?? '').replace(/^session-/, '').slice(0, 8);
const time = (iso) => String(iso ?? '').replace('T', ' ').slice(0, 19);

const interventions = byType('intervention.triggered');
const answers = byType('hypothesis.submitted');
const reports = {
  log: logPath,
  cache: { source: cacheSource, path: filtered ? null : cachePath, digest },
  window: events.length ? { from: events[0].timestamp, to: events[events.length - 1].timestamp } : null,
  totals: {
    events: events.length,
    sessions: new Set(events.map((e) => e.sessionId)).size,
    sessionsStarted: byType('session.started').length,
    episodes: report.episodes.length,
  },
  funnel: {
    sessionsStarted: byType('session.started').length,
    interventionsIssued: interventions.length,
    hypothesesSubmitted: answers.length,
    decisionsRecorded: byType('decision.recorded').length,
    teachingBackRequested: byType('teaching_back.requested').length,
    teachingBackCompleted: byType('teaching_back.completed').length,
    knowledgeGapsDetected: byType('knowledge_gap.detected').length,
  },
  episodes: report.episodeSummary,
  sessions: report.sessions,
  interventions: report.interventions,
  topics,
  metrics,
  ...(comparison ? { comparison } : {}),
  interventionsByReason: interventions.reduce((acc, e) => {
    const key = (e.payload && e.payload.reason ? e.payload.reason : 'unknown') + ' (level ' + (e.payload && e.payload.level !== undefined ? e.payload.level : '?') + ')';
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {}),
  teachingBackResults: byType('teaching_back.completed').reduce((acc, e) => {
    const key = (e.payload && e.payload.result) || 'unknown';
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {}),
  timeline: events.map((e) => ({
    at: e.timestamp,
    session: e.sessionId,
    type: e.type,
    detail: (e.payload && (e.payload.reason || e.payload.result || e.payload.authorship)) || '',
  })),
};

// A gate that was answered is the single best signal that the loop closed.
const issued = reports.funnel.interventionsIssued;
reports.rates = {
  gateAnsweredRate: issued > 0 ? Number((answers.length / issued).toFixed(3)) : null,
};

if (asJson) {
  console.log(JSON.stringify(reports, null, 2));
} else {
  const f = reports.funnel;
  console.log('=== cognitive feedback report ===');
  console.log('log    : ' + reports.log);
  console.log('cache  : ' + reports.cache.source + (reports.cache.source === 'disk' ? ' (hit)' : ''));
  if (reports.window) console.log('window : ' + time(reports.window.from) + '  ->  ' + time(reports.window.to));
  console.log('events : ' + reports.totals.events + ' across ' + reports.totals.sessions + ' session(s)');
  console.log('');
  console.log('funnel');
  console.log('  sessions started          ' + f.sessionsStarted);
  console.log('  interventions issued      ' + f.interventionsIssued);
  console.log('  user hypotheses submitted ' + f.hypothesesSubmitted);
  console.log('  decisions recorded        ' + f.decisionsRecorded);
  console.log('  teaching back requested   ' + f.teachingBackRequested);
  console.log('  teaching back completed   ' + f.teachingBackCompleted);
  console.log('  knowledge gaps detected   ' + f.knowledgeGapsDetected);
  console.log('');
  const m = reports.metrics;
  const num = (value) => (value === null ? 'n/a' : value);
  console.log('metrics');
  console.log('  exposure');
  console.log(
    '    interventions issued      ' + m.exposure.interventionsIssued +
      '  (gates ' + m.exposure.gates + ', challenges ' + m.exposure.challenges + ', teaching back ' + m.exposure.teachingBackRequests + ')',
  );
  console.log('    episodes opened           ' + m.exposure.episodesOpened);
  console.log('    interventions / session   ' + m.exposure.interventionsPerSession);
  if (m.exposure.uncorrelatedIssues > 0) {
    console.log('    uncorrelated issues       ' + m.exposure.uncorrelatedIssues + '  (written before correlation; excluded from response rates)');
  }
  console.log('  response');
  console.log('    hypotheses submitted      ' + m.response.hypothesesSubmitted);
  console.log(
    '    gates answered            ' + m.response.gatesAnswered + '/' + m.response.correlatedGates +
      '  (' + num(m.response.gateAnsweredRate) + ')',
  );
  console.log(
    '    teaching back completed   ' + m.response.teachingBackCompleted + '/' + m.response.correlatedTeachingBacks +
      '  (' + num(m.response.teachingBackResponseRate) + ')',
  );
  console.log('  outcome');
  console.log(
    '    episodes completed        ' + m.outcome.episodesCompleted + '  abandoned ' + m.outcome.episodesAbandoned +
      '  open ' + m.outcome.episodesOpen + '  (' + num(m.outcome.episodeCompletionRate) + ')',
  );
  console.log(
    '    knowledge gaps            ' + m.outcome.knowledgeGapsDetected +
      '  recurring topics ' + m.outcome.recurringGapTopics + ' (open ' + m.outcome.openRecurringGapTopics + ')',
  );
  console.log('    median decision latency   ' + (m.outcome.medianDecisionLatencyMs === null ? 'n/a' : m.outcome.medianDecisionLatencyMs + 'ms'));
  console.log('  utilization');
  console.log(
    '    sessions with / without   ' + m.utilization.sessionsWithIntervention + ' / ' + m.utilization.interventionFreeSessions,
  );
  console.log('');
  if (comparison) {
    console.log('period comparison (split at ' + comparison.splitAt + ')');
    const rows = [
      ['interventions / session', comparison.baseline.exposure.interventionsPerSession, comparison.feedback.exposure.interventionsPerSession, comparison.delta.interventionsPerSession],
      ['gate answered rate', comparison.baseline.response.gateAnsweredRate, comparison.feedback.response.gateAnsweredRate, comparison.delta.gateAnsweredRate],
      ['teaching-back response', comparison.baseline.response.teachingBackResponseRate, comparison.feedback.response.teachingBackResponseRate, comparison.delta.teachingBackResponseRate],
      ['episode completion', comparison.baseline.outcome.episodeCompletionRate, comparison.feedback.outcome.episodeCompletionRate, comparison.delta.episodeCompletionRate],
      ['knowledge gaps / session', null, null, comparison.delta.knowledgeGapsPerSession],
    ];
    for (const [label, before, after, change] of rows) {
      console.log(
        '  ' + label.padEnd(26) + ' baseline ' + String(num(before)).padEnd(7) + ' feedback ' + String(num(after)).padEnd(7) + ' delta ' + num(change),
      );
    }
    console.log('  NOTE: ' + comparison.caveat);
    console.log('');
  }
  const episodeSummary = reports.episodes;
  console.log('episodes');
  console.log(
    '  total ' + episodeSummary.total + '  completed ' + episodeSummary.completed + '  abandoned ' + episodeSummary.abandoned + '  open ' + episodeSummary.open,
  );
  console.log('  completion rate           ' + (episodeSummary.completionRate === null ? 'n/a' : episodeSummary.completionRate));
  console.log('');
  if (Object.keys(reports.interventionsByReason).length) {
    console.log('interventions by reason');
    for (const [key, n] of Object.entries(reports.interventionsByReason)) console.log('  ' + key.padEnd(26) + ' ' + n);
    console.log('');
  }
  if (Object.keys(reports.teachingBackResults).length) {
    console.log('teaching-back results');
    for (const [key, n] of Object.entries(reports.teachingBackResults)) console.log('  ' + key.padEnd(26) + ' ' + n);
    console.log('');
  }
  if (showEpisodes) {
    console.log('episodes (newest last)');
    for (const episode of report.episodes.slice(-25)) {
      const out = episode.implementationOutcome ? 'implemented' : '-';
      const tb = episode.teachingBack ? episode.teachingBack.result : '-';
      console.log(
        '  ' + time(episode.startedAt) + '  ' + short(episode.sessionId).padEnd(9) + ' ' + episode.status.padEnd(9) + ' ' +
          short(episode.episodeId) + '  ' + out + '  tb:' + tb + '  iv:' + episode.interventionIds.length,
      );
    }
    if (report.episodes.length > 25) console.log('  ... ' + (report.episodes.length - 25) + ' earlier episode(s); use --json');
    console.log('');
  }
  const recurring = topics.filter((t) => t.recurrence === 'recurring');
  if (showTopics || recurring.length) {
    console.log('knowledge-gap topics');
    const rows = (showTopics ? topics : recurring).filter((t) => t.gapCount > 0);
    for (const topic of rows.slice(0, 20)) {
      const last = topic.lastTeachingBack ? topic.lastTeachingBack.result : '-';
      console.log(
        '  ' + topic.topic.padEnd(34) + ' gaps ' + String(topic.gapCount).padStart(3) +
          '  recent ' + String(topic.recentGaps).padStart(3) +
          '  ' + (topic.resolved ? 'resolved' : 'open    ') + '  last-tb:' + last,
      );
    }
    if (rows.length > 20) console.log('  ... ' + (rows.length - 20) + ' more topic(s); use --json');
    console.log('');
  }
  console.log('sessions');
  for (const session of reports.sessions) {
    console.log(
      '  ' + short(session.sessionId).padEnd(9) + ' events ' + String(session.eventCount).padStart(3) + '  ' +
        'iv ' + session.interventions + '  hyp ' + session.hypotheses + '  tb ' + session.teachingBackCompleted + '/' + session.teachingBackRequested + '  ' +
        'gaps ' + session.knowledgeGaps + '  episodes ' + session.episodes,
    );
  }
  console.log('');
  console.log('timeline (newest last)');
  for (const row of reports.timeline.slice(-25)) {
    console.log('  ' + time(row.at) + '  ' + short(row.session).padEnd(9) + ' ' + row.type.padEnd(24) + ' ' + row.detail);
  }
  if (reports.timeline.length > 25) console.log('  ... ' + (reports.timeline.length - 25) + ' earlier event(s); use --json or --session');
}
