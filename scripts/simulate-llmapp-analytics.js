#!/usr/bin/env node
/*
 * Backfill LLM-app (MCP tool) analytics for the past N days.
 *
 * Every simulated tool call executes the REAL action handler (same module the
 * runtime loads) through the same withAnalytics path as production, so status,
 * duration, input/output size and the Edge payload shape are measured, not
 * invented. Only the event timestamp is backdated, and each simulated session
 * reuses the ECID Adobe Edge returns for its first call so Analytics counts
 * visits/visitors correctly.
 *
 * Prerequisite: the report suite must accept timestamped hits ("Timestamps
 * optional" or "Timestamps required"), otherwise backdated hits are dropped.
 *
 * Usage:
 *   node scripts/simulate-llmapp-analytics.js --dry-run
 *   node scripts/simulate-llmapp-analytics.js --days=7 --sessions-per-day=40
 *
 * Options:
 *   --days=N               days to backfill, ending now (default 7, max 30)
 *   --sessions-per-day=N   average sessions per weekday (default 40; weekends ~65%)
 *   --concurrency=N        sessions processed in parallel (default 4)
 *   --seed=N               deterministic schedule/arguments (default 42)
 *   --dry-run              run handlers, print a sample payload, send nothing
 */

const path = require('path');
const { loadAdventures } = require('../actions/lib/wknd.js');

const ACTIONS_DIR = path.join(__dirname, '..', 'actions');
const ACTIONS = {
  discover_adventures: require(path.join(ACTIONS_DIR, 'discover-adventures', 'index.js')),
  build_route_briefing: require(path.join(ACTIONS_DIR, 'build-route-briefing', 'index.js')),
  build_gear_checklist: require(path.join(ACTIONS_DIR, 'build-gear-checklist', 'index.js')),
  plan_permits_and_access: require(path.join(ACTIONS_DIR, 'plan-permits-and-access', 'index.js')),
  audit_pack_weight: require(path.join(ACTIONS_DIR, 'audit-pack-weight', 'index.js')),
  prepare_field_submission: require(path.join(ACTIONS_DIR, 'prepare-field-submission', 'index.js')),
};

// Simulated host sessions are prefixed so they can be filtered out in eVar11.
const SIM_SESSION_PREFIX = 'sim-';

function parseArgs(argv) {
  const opts = {
    days: 7, sessionsPerDay: 40, concurrency: 4, seed: 42, dryRun: false,
  };
  for (const arg of argv) {
    const [key, value] = arg.split('=');
    const n = Number.parseInt(value, 10);
    if (key === '--dry-run') opts.dryRun = true;
    else if (key === '--days' && n > 0) opts.days = Math.min(n, 30);
    else if (key === '--sessions-per-day' && n > 0) opts.sessionsPerDay = n;
    else if (key === '--concurrency' && n > 0) opts.concurrency = n;
    else if (key === '--seed' && Number.isFinite(n)) opts.seed = n;
    else if (key === '--help' || key === '-h') opts.help = true;
    else throw new Error(`Unknown or invalid option: ${arg}`);
  }
  return opts;
}

// mulberry32 — small seeded PRNG so runs are reproducible.
function createRng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: (list) => list[Math.floor(next() * list.length)],
    weighted: (entries) => {
      const total = entries.reduce((sum, [, w]) => sum + w, 0);
      let r = next() * total;
      for (const [value, w] of entries) {
        r -= w;
        if (r <= 0) return value;
      }
      return entries[entries.length - 1][0];
    },
    uuid: () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = Math.floor(next() * 16);
      return (c === 'x' ? r : ((r & 0x3) | 0x8)).toString(16);
    }),
  };
}

// Relative traffic by UTC hour (peaks across EU afternoon / US morning).
const HOUR_WEIGHTS = [2, 1, 1, 1, 1, 2, 3, 4, 6, 7, 8, 8, 9, 10, 11, 11, 10, 9, 8, 7, 6, 5, 4, 3];

const SEASONS = ['spring', 'summer', 'autumn', 'winter'];
const TRAVEL_WINDOWS = ['next month', 'June', 'late September', 'December holidays', 'early spring', 'August'];
const ORIGINS = ['SFO', 'JFK', 'LHR', 'FRA', 'SYD', 'SIN', 'ORD', 'AMS'];
const EXPERIENCE = ['beginner', 'intermediate', 'advanced'];
const TERRAIN_BY_ACTIVITY = {
  hiking: 'alpine trail', cycling: 'mountain pass road', water: 'coastal water',
  'desert trekking': 'desert', photography: 'mountain trail', 'winter mountaineering': 'glacier',
  climbing: 'granite big wall',
};
const PACK_ITEMS = [
  'tent', 'sleeping bag', 'sleeping pad', 'stove', 'fuel canister', 'water filter', 'headlamp',
  'rain jacket', 'down jacket', 'first aid kit', 'map', 'phone', 'power bank', 'trekking poles',
  'camera', 'extra socks', 'cook pot', 'knife', 'sunscreen',
];
const SUBMISSION_TYPES = ['trip report', 'conditions update', 'route correction', 'photo essay'];

function activityOf(route) {
  return String((route && route.activity) || 'Hiking').toLowerCase();
}

// Journey templates: each returns an ordered list of [toolName, args].
function buildJourney(rng, catalog) {
  const route = rng.pick(catalog);
  const id = route.adventure_id;
  const activity = activityOf(route);
  const season = rng.pick(SEASONS);
  const days = rng.int(2, 10);
  const experience = rng.pick(EXPERIENCE);
  const window = rng.pick(TRAVEL_WINDOWS);
  const steps = {
    discover: ['discover_adventures', {
      activity, experience_level: experience, trip_length_days: days,
      userIntent: `Find a ${days}-day ${activity} trip for ${experience === 'advanced' || experience === 'intermediate' ? 'an' : 'a'} ${experience} traveller`,
    }],
    briefing: ['build_route_briefing', {
      adventure_id: id, travel_window: window, party_experience: experience,
      userIntent: `Day-by-day briefing for ${route.title}`,
    }],
    gear: ['build_gear_checklist', {
      adventure_id: id, activity, terrain: TERRAIN_BY_ACTIVITY[activity] || 'mixed terrain',
      duration_days: days, season, experience_level: experience,
      userIntent: `What gear do I need for ${route.title} in ${season}?`,
    }],
    permits: ['plan_permits_and_access', {
      adventure_id: id, travel_window: window, origin: rng.pick(ORIGINS),
      userIntent: `Permits and how to get to ${route.title}`,
    }],
    audit: ['audit_pack_weight', {
      items: PACK_ITEMS.filter(() => rng.next() < 0.6), adventure_id: id, activity,
      duration_days: days, season, goal: 'reduce base weight',
      userIntent: `Cut weight from my ${activity} pack`,
    }],
    submit: ['prepare_field_submission', {
      submission_type: rng.pick(SUBMISSION_TYPES), destination: route.title, activity,
      draft_text: `Just got back from ${route.title}. Conditions were good and the route was well marked.`,
      contributor_bio: `${experience} ${activity} enthusiast`,
      userIntent: `Help me submit a ${activity} trip report`,
    }],
  };
  const journey = rng.weighted([
    [['discover', 'briefing', 'gear', 'permits'], 18],
    [['discover', 'briefing'], 22],
    [['discover'], 20],
    [['briefing', 'gear'], 12],
    [['gear', 'audit'], 10],
    [['audit'], 8],
    [['permits'], 6],
    [['submit'], 4],
  ]);
  return journey.map((key) => steps[key]);
}

function buildSchedule(opts, rng, catalog, now) {
  const sessions = [];
  const start = now - opts.days * 24 * 60 * 60 * 1000;
  for (let d = 0; d < opts.days; d += 1) {
    const dayStart = start + d * 24 * 60 * 60 * 1000;
    const weekday = new Date(dayStart).getUTCDay();
    const factor = (weekday === 0 || weekday === 6 ? 0.65 : 1) * (0.85 + rng.next() * 0.3);
    const count = Math.max(1, Math.round(opts.sessionsPerDay * factor));
    for (let i = 0; i < count; i += 1) {
      const hour = rng.weighted(HOUR_WEIGHTS.map((w, h) => [h, w]));
      const day = new Date(dayStart);
      const startAt = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hour, rng.int(0, 59), rng.int(0, 59));
      if (startAt < start || startAt >= now - 60 * 1000) continue;
      // ~55% ChatGPT (exposes a session id); other hosts expose none.
      const hostSession = rng.next() < 0.55 ? `${SIM_SESSION_PREFIX}${rng.uuid()}` : undefined;
      sessions.push({ startAt, hostSession, steps: buildJourney(rng, catalog) });
    }
  }
  return sessions.sort((a, b) => a.startAt - b.startAt);
}

async function runSession(session, opts, rng, stats, now) {
  let ecid;
  let at = session.startAt;
  const extra = session.hostSession ? { _meta: { 'openai/session': session.hostSession } } : {};
  for (const [toolName, args] of session.steps) {
    if (at >= now) break;
    let outcome;
    try {
      await ACTIONS[toolName].invokeWithAnalytics(args, extra, {
        timestamp: at,
        ecid,
        fetchEcid: !ecid,
        dryRun: opts.dryRun,
        onAnalytics: (result, fields) => {
          outcome = result;
          stats.byTool[toolName] = (stats.byTool[toolName] || 0) + 1;
          stats.byStatus[fields.status] = (stats.byStatus[fields.status] || 0) + 1;
        },
      });
    } catch {
      // Real handler error — already reported as status=error.
    }
    if (outcome && outcome.sent) {
      stats.sent += 1;
      ecid = outcome.ecid || ecid;
    } else if (outcome && opts.dryRun) {
      stats.dryRun += 1;
      if (!stats.sample) stats.sample = outcome.body;
    } else {
      stats.failed += 1;
      if (stats.errors.length < 5) stats.errors.push((outcome && (outcome.error || outcome.status)) || 'analytics disabled');
    }
    // Think time between tool calls in the same conversation.
    at += rng.int(25, 240) * 1000;
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(require('fs').readFileSync(__filename, 'utf8').split('*/')[0]);
    return;
  }
  const rng = createRng(opts.seed);
  const catalog = (await loadAdventures({}, [])).filter((r) => r && r.adventure_id);
  if (!catalog.length) throw new Error('WKND catalogue is unreachable; refusing to send data without real routes.');

  const now = Date.now();
  const sessions = buildSchedule(opts, rng, catalog, now);
  const totalCalls = sessions.reduce((sum, s) => sum + s.steps.length, 0);
  console.log(`${opts.dryRun ? '[dry-run] ' : ''}Backfilling ${sessions.length} sessions (~${totalCalls} tool calls) `
    + `over ${opts.days} day(s) from ${new Date(sessions[0].startAt).toISOString()}`);

  const stats = {
    sent: 0, failed: 0, dryRun: 0, byTool: {}, byStatus: {}, errors: [],
  };
  // Sessions are started in chronological order; each session's hits stay ordered.
  let cursor = 0;
  const workers = Array.from({ length: opts.concurrency }, async () => {
    while (cursor < sessions.length) {
      const session = sessions[cursor];
      cursor += 1;
      await runSession(session, opts, rng, stats, now);
      const done = stats.sent + stats.failed + stats.dryRun;
      if (done && done % 50 === 0) process.stdout.write(`  ${done}/${totalCalls} events\n`);
    }
  });
  await Promise.all(workers);

  console.log('By tool:', stats.byTool);
  console.log('By status:', stats.byStatus);
  if (opts.dryRun) {
    console.log(`Built ${stats.dryRun} payloads (nothing sent). Sample:`);
    console.log(JSON.stringify(stats.sample, null, 2));
  } else {
    console.log(`Sent ${stats.sent} events, ${stats.failed} failed.`);
  }
  if (stats.errors.length) console.log('First errors:', stats.errors);
  if (stats.failed) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, createRng, buildSchedule, buildJourney };
