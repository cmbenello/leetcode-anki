// Run with:  node tests/inject.test.js
// content/inject.js reads LeetCode's judge responses in the page. These feed it
// responses shaped like LeetCode's (v1 /check/ with status_msg, v2 /v2/check/
// with status_code + ai_state, as LeetCode's client handles them) and check
// what it reports.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SRC = readFileSync(new URL('../extension/content/inject.js', import.meta.url), 'utf8');

function load() {
  const posted = [];
  const replies = new Map();                      // url -> queue of JSON bodies
  const res = (body) => ({ clone: () => ({ json: async () => body }), json: async () => body });
  const win = {
    fetch: async (input) => {
      const url = typeof input === 'string' ? input : String(input.url || input);
      const q = replies.get(url) || [];
      return res(q.length > 1 ? q.shift() : q[0] ?? {});
    },
    XMLHttpRequest: class { open() {} send() {} addEventListener() {} },
    addEventListener() {},
    postMessage: (m) => posted.push(m),
  };
  win.window = win;
  const ctx = vm.createContext({
    window: win, document: { documentElement: { setAttribute() {} }, addEventListener() {}, removeEventListener() {} },
    setTimeout: () => 0, URL, console,
  });
  vm.runInContext(SRC, ctx);
  const tick = () => new Promise(r => setTimeout(r, 5));
  return { win, posted: () => posted.filter(m => m.kind === 'submission'), reply: (u, ...bodies) => replies.set(u, bodies), tick };
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('v2: waits for the judge and the AI pass, then reports Accepted with the submitting slug', async () => {
  const t = load();
  t.reply('/problems/two-sum/submit/', { submission_id: 2191605909 });
  await t.win.fetch('/problems/two-sum/submit/', { method: 'POST' }); await t.tick();
  const chk = '/submissions/detail/2191605909/v2/check/';
  for (const body of [{ state: 'PENDING' }, { state: 'STARTED' }, { state: 'SUCCESS', ai_state: 'STARTED', status_code: 10 }]) {
    t.reply(chk, body); await t.win.fetch(chk); await t.tick();
  }
  assert.equal(t.posted().length, 0, 'nothing until it is final');
  t.reply(chk, { state: 'SUCCESS', ai_state: 'SUCCESS', status_code: 10, compare_result: '1111', submission_id: '2191605909', status_runtime: '0 ms' });
  await t.win.fetch(chk); await t.tick();
  await t.win.fetch(chk); await t.tick();                      // polled again: still one event
  const p = t.posted();
  assert.equal(p.length, 1);
  assert.equal(p[0].status, 'Accepted');
  assert.equal(p[0].slug, 'two-sum');
  assert.equal(p[0].submissionId, '2191605909');
});

test('v2: status codes map like LeetCode\'s client (failed case in compare_result = Wrong Answer)', async () => {
  const cases = [[{ status_code: 10, compare_result: '1101' }, 'Wrong Answer'], [{ status_code: 14 }, 'Time Limit Exceeded'],
    [{ status_code: 20 }, 'Compile Error'], [{ status_code: 50 }, 'Restrictions Failed']];
  for (const [i, [extra, want]] of cases.entries()) {
    const t = load();
    const chk = `/submissions/detail/${100 + i}/v2/check/`;
    t.reply(chk, { state: 'SUCCESS', submission_id: 100 + i, ...extra });
    await t.win.fetch(chk); await t.tick();
    assert.equal(t.posted()[0]?.status, want, JSON.stringify(extra));
  }
});

test('v1 /check/ with status_msg still works; a URL object works; Run results never count', async () => {
  const t = load();
  t.reply('https://leetcode.com/submissions/detail/77/check/', { state: 'SUCCESS', status_msg: 'Accepted', submission_id: 77 });
  await t.win.fetch(new URL('https://leetcode.com/submissions/detail/77/check/')); await t.tick();
  assert.equal(t.posted()[0]?.status, 'Accepted');
  t.reply('/submissions/detail/runcode_1700_abc/check/', { state: 'SUCCESS', status_msg: 'Accepted', task_name: 'judger.runcodetask.RunCode' });
  await t.win.fetch('/submissions/detail/runcode_1700_abc/check/'); await t.tick();
  assert.equal(t.posted().length, 1, 'the Run result was ignored');
});

let failed = 0;
for (const { name, fn } of tests) {
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e.message.split('\n').join('\n       ')}`); }
}
console.log(`\n${tests.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
