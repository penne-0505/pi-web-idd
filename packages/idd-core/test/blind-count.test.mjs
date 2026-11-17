import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { DEFAULT_MAX_ROUTES, pipelineSnapshot } from '../src/config/pipeline.ts';
import { blindCountOf, blindRoundRuns, blindSlotSize, reviewLaneBlindCount } from '../src/plan/blind-count.ts';
import { DEPTHS, DEPTH_TABLE } from '../src/plan/depth.ts';
import { maxRoutesOf, specRunPlans, stageRunPlans } from '../../idd-lane/src/review-runs.ts';
import { DEFAULT_MAX_ROUTES as LANE_MAX_ROUTES } from '../../idd-lane/src/risk-map.ts';
import { parseRoles } from '../../idd-lane/src/roles.ts';
import { tmpDir } from './helpers/tmp.mjs';

const HEAD = [
  'models:', '  x-a:', '    model: x/a', '  x-b:', '    model: x/b',
  'roles:', '  r: { model: x-a, report: review }', '  q: { model: x-b, report: review }', '  o: { model: x-b, report: review }', '  p: { model: x-a, report: review }',
  '  c: { harness: claude, model: opus, report: review }', '  d: { harness: claude, model: x-a, report: review }',
  'pipeline:', '',
].join('\n');

/** pipelines that differ in what a round may cut: models, extras of either kind, an extra that repeats a role, a spec check with models */
const PIPELINES = {
  models: '  review_blind: { role: r, models: [x-a, x-b], high_risk_extra: [o], first_round_extra: [p], concurrency: 3 }\n  spec_check: { role: r, models: [x-a, x-b] }\n  risk_map: { role: r, max_routes: 3 }\n',
  roles: '  review_blind: { roles: [r, q], high_risk_extra: [r], concurrency: 2 }\n  spec_check: { role: r }\n  risk_map: { role: r }\n',
  plain: '  review_blind: { roles: [r], concurrency: 2 }\n  risk_map: { role: r, max_routes: 20 }\n',
  sameName: '  review_blind: { role: r, models: [x-a, x-b], high_risk_extra: [r], first_round_extra: [q], concurrency: 2 }\n  spec_check: { role: r }\n  risk_map: { role: r }\n',
  // a Claude Code role's model is its own alias: its extra run names no model definition, so it is not the run of the definition the slot names for it
  claudeNamed: '  review_blind: { role: d, models: [x-a, x-b], high_risk_extra: [d], first_round_extra: [c], concurrency: 2 }\n  spec_check: { role: r }\n  risk_map: { role: r }\n',
  claudeOwn: '  review_blind: { roles: [c, d], high_risk_extra: [c], first_round_extra: [d], concurrency: 3 }\n  spec_check: { role: r }\n  risk_map: { role: r, max_routes: 20 }\n',
  // an extra that repeats a name is one run: the runner and the count both read each role once
  dupExtra: '  review_blind: { role: r, models: [x-a, x-b], high_risk_extra: [o, o, o], first_round_extra: [p, p], concurrency: 2 }\n  spec_check: { role: r }\n  risk_map: { role: r }\n',
  wide: '  review_blind: { roles: [r, q], models: [x-a, x-b], high_risk_extra: [o, p], concurrency: 4 }\n  spec_check: { role: r }\n  risk_map: { role: r }\n',
};

const routesOf = (n) => Array.from({ length: n }, (_, i) => ({ id: `R-${i + 1}`, paths: [`f${i}.ts`], question: 'q', harms: [] }));

test('the stage and the wait list count a round the way the runner lists its runs, in every pipeline', () => {
  const state = tmpDir('idd-blind-count-');
  process.env.IDD_ROLES_FILE = join(state, 'roles.yaml');
  let checked = 0;
  for (const [name, pipeline] of Object.entries(PIPELINES)) {
    const text = HEAD + pipeline;
    writeFileSync(process.env.IDD_ROLES_FILE, text);
    const roles = parseRoles(text);
    const pipe = pipelineSnapshot();
    const slot = roles.pipeline.review_blind;
    assert.equal(pipe.maxRoutes(), maxRoutesOf(roles), `${name}: the most routes`);
    // the slot's size is the most runs a plain round of the slot makes: an extra that shares a role's name still runs with its own model
    assert.equal(pipe.size('review_blind'), stageRunPlans('blind', slot, { routes: [], maxRoutes: maxRoutesOf(roles), leftovers: [], extras: ['first_round', 'high_risk'] }).length, `${name}: the slot's size`);
    if (name === 'dupExtra') {
      assert.deepEqual(slot.highRiskExtra, ['o']);
      assert.equal(slot.extraRuns.high_risk.length, 1);
      const finalRuns = stageRunPlans('final', slot, { routes: [], maxRoutes: maxRoutesOf(roles), leftovers: [], extras: ['high_risk'], onlyHighRisk: true }).length;
      assert.ok(finalRuns <= blindSlotSize(pipe), `${name}: a final round stays within the usual size`);
    }
    for (const kind of ['blind', 'final']) {
      for (const conflict of kind === 'blind' ? [false, true] : [false]) {
        for (const depth of [undefined, ...DEPTHS]) {
          for (const extras of [[], ['first_round'], ['high_risk'], ['first_round', 'high_risk']]) {
            for (const routes of [0, 1, 2, 5, 12]) {
              const roundRoutes = conflict ? 0 : routes;
              const runnerExtras = extras.length ? { extras } : {};
              const depthRoles = depth === undefined ? {} : kind === 'final' ? { onlyHighRisk: true } : { roleCount: DEPTH_TABLE[depth].blind };
              const planned = stageRunPlans(kind, slot, { routes: routesOf(roundRoutes), maxRoutes: maxRoutesOf(roles), leftovers: [], ...runnerExtras, ...(conflict ? { conflict: true } : {}), ...depthRoles }).length
                + (depth !== undefined && roles.pipeline.spec_check ? specRunPlans(roles.pipeline.spec_check, DEPTH_TABLE[depth].spec).length : 0);
              const round = { kind, conflict, ...(depth ? { depth } : {}), extras, routes: roundRoutes };
              assert.equal(blindRoundRuns(pipe, round), planned, `${name}: ${JSON.stringify(round)}`);
              checked += 1;
            }
          }
        }
      }
    }
  }
  assert.ok(checked > 500);
});

test('the default for the most routes is the runner\'s', () => {
  assert.equal(DEFAULT_MAX_ROUTES, LANE_MAX_ROUTES);
});

test('a round is held against the slot\'s usual size, but a conflict scope round and a routed round against their own runs', () => {
  const state = tmpDir('idd-blind-count-');
  process.env.IDD_ROLES_FILE = join(state, 'roles.yaml');
  writeFileSync(process.env.IDD_ROLES_FILE, HEAD + PIPELINES.models);
  const pipe = pipelineSnapshot();
  // 2 models of r, the two extras, and the check's copy beside them
  const usual = blindSlotSize(pipe);
  assert.equal(usual, 2 + 1 + 1 + 1);
  assert.deepEqual(blindCountOf(pipe, { kind: 'blind', conflict: false, depth: 'shallow', extras: [], routes: 0 }, usual), { fits: usual, runs: 2 });
  assert.deepEqual(blindCountOf(pipe, { kind: 'blind', conflict: true, depth: 'shallow', extras: [], routes: 0 }, usual), { fits: 2, runs: 2, conflict: true });
  assert.deepEqual(blindCountOf(pipe, { kind: 'blind', conflict: false, depth: 'standard', extras: [], routes: 2 }, usual), { fits: usual, routed: 4, runs: 4 });
  assert.deepEqual(reviewLaneBlindCount(pipe, 0), { fits: pipe.size('review_blind'), runs: 2 });
  assert.deepEqual(reviewLaneBlindCount(pipe, 9), { fits: pipe.size('review_blind'), routed: 4, runs: 4 });
});
