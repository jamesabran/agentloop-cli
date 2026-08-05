/**
 * Offline demonstration of the local review loop.
 *
 * `agentloop --self-check` runs this. It walks the pure
 * decision engine through a complete task — implement, audit, change round,
 * re-audit, approve, publish — plus the ways a task stops early, so the owner
 * can see in one screen what the controller would do at each stage.
 *
 * It starts no agent, touches no network, and reads and writes no file, which
 * is what makes it usable as the subject of the non-mutation test. Exits
 * non-zero if any expectation fails, so it doubles as a smoke test.
 */

import { MAX_CHANGE_ROUNDS } from './lib/config.mjs';
import { ACTIONS, auditScope, decideLocal, extractBlockingFindings } from './lib/local-loop.mjs';
import { emptyState, recordAudit, recordImplementation } from './lib/state.mjs';

const A = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const B = 'ffeeddccbbaa99887766554433221100aabbccdd';
const C = '0123456789abcdef0123456789abcdef01234567';

const failures = [];

function check(label, condition, detail = '') {
  const mark = condition ? 'PASS' : 'FAIL';
  process.stdout.write(`  [${mark}] ${label}${detail ? ` — ${detail}` : ''}\n`);
  if (!condition) failures.push(label);
}

function heading(title) {
  process.stdout.write(`\n${title}\n${'─'.repeat(title.length)}\n`);
}

function base(overrides = {}) {
  return { ...emptyState(), task: '5', branch: 'agent/task-5', ...overrides };
}

/** The state after Codex requested changes on the first checkpoint. */
function afterFirstRequestChanges() {
  return recordAudit(recordImplementation(base(), A), {
    head: A,
    verdict: 'REQUEST_CHANGES',
    blockers: ['Missing test for the empty case'],
  });
}

function expect(label, state, head, action) {
  const decision = decideLocal({ state, head });
  check(label, decision.action === action, `${decision.action} — ${decision.reason}`);
}

export function runSelfCheck() {
  process.stdout.write('AgentLoop local review loop — offline self-check\n');
  process.stdout.write(
    'No agent is started, no file is read or written, and nothing touches the network.\n',
  );

  heading('The normal path');
  expect('Nothing committed yet → implement', base(), null, ACTIONS.IMPLEMENT);
  expect(
    'First local checkpoint → audit',
    recordImplementation(base(), A),
    A,
    ACTIONS.AUDIT,
  );
  expect('Changes requested → fix', afterFirstRequestChanges(), A, ACTIONS.FIX);
  expect(
    'Fix committed → re-audit',
    recordImplementation(afterFirstRequestChanges(), B),
    B,
    ACTIONS.AUDIT,
  );
  expect(
    'Approved, and still HEAD → publish',
    recordAudit(base({ implementationHead: B, lastAuditedHead: A, round: 1 }), {
      head: B,
      verdict: 'APPROVED',
    }),
    B,
    ACTIONS.PUBLISH,
  );
  expect(
    'Published → done',
    base({
      implementationHead: B,
      lastAuditedHead: B,
      verdict: 'APPROVED',
      publishedHead: B,
    }),
    B,
    ACTIONS.DONE,
  );

  heading('An approval covers one commit and no other');
  expect(
    'A commit landed behind the approval → re-audit, not publish',
    recordAudit(base({ implementationHead: B, lastAuditedHead: A, round: 1 }), {
      head: B,
      verdict: 'APPROVED',
    }),
    C,
    ACTIONS.STOP,
  );
  const voided = recordImplementation(
    recordAudit(base({ implementationHead: A }), { head: A, verdict: 'APPROVED' }),
    B,
  );
  check(
    'A new commit clears the recorded verdict',
    voided.verdict === null,
    `verdict is ${voided.verdict ?? 'null'}`,
  );

  heading('Stopping instead of looping');
  expect(
    `Change rounds exhausted (${MAX_CHANGE_ROUNDS}) → stop`,
    base({
      implementationHead: B,
      lastAuditedHead: B,
      verdict: 'REQUEST_CHANGES',
      changeRounds: MAX_CHANGE_ROUNDS,
      round: MAX_CHANGE_ROUNDS,
      blockers: ['Still unresolved'],
    }),
    B,
    ACTIONS.STOP,
  );
  expect(
    'Codex could not complete the audit → stop',
    base({ implementationHead: A, lastAuditedHead: A, verdict: 'BLOCKED' }),
    A,
    ACTIONS.STOP,
  );

  heading('What Codex is shown');
  const first = auditScope({ state: recordImplementation(base(), A), head: A });
  const again = auditScope({
    state: base({ implementationHead: B, lastAuditedHead: A, blockers: ['One finding'] }),
    head: B,
  });
  check('The first audit reviews the whole branch', !first.incremental, first.range);
  check('A re-audit reviews only the new commits', again.incremental, again.range);
  check(
    'A re-audit carries the unresolved findings',
    again.unresolved.length === 1,
    `${again.unresolved.length} unresolved`,
  );

  heading('Findings are read back out of the report');
  const sample = '## Blocking findings\n\n1. `parse()` drops the last row\n2. No test covers it\n';
  const findings = extractBlockingFindings(sample, { count: 2, round: 1 });
  check('Both blocking findings were extracted', findings.length === 2, findings.join(' | '));

  process.stdout.write(
    failures.length === 0
      ? '\nPASS — every transition matched.\n'
      : `\nFAIL — ${failures.length} mismatch(es): ${failures.join(', ')}\n`,
  );
  return failures.length === 0 ? 0 : 1;
}
