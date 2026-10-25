// t14 回归测试：验证「done 任务仍在监听」修复（v0.2.1）
//
// 做法：把 figma-plugin/ui.html 的内联脚本原样抽出来，在 Node vm 里用最小 DOM/宿主桩跑真实代码，
// 再喂给它不同的注册表状态和桥接响应，断言实际发出的 watch ids 与 apply-result 行为。
// 不复制产品逻辑，只驱动它。
//
// 用法：node tools/t14_done_watch_test.js
// 退出码 0 = 全过。

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const UI_PATH = process.env.UI_PATH || path.join(__dirname, '..', 'figma-plugin', 'ui.html');
const html = fs.readFileSync(UI_PATH, 'utf8');
const m = html.match(/<script>([\s\S]*?)<\/script>/);
if (!m) {
  console.error('找不到 ui.html 的内联脚本');
  process.exit(2);
}
const code = m[1];

// ---------------- 最小 DOM / 宿主桩 ----------------

function makeEl(tag) {
  const node = {
    tagName: tag || 'div',
    children: [],
    _text: '',
    className: '',
    title: '',
    disabled: false,
    value: '',
    checked: false,
    scrollTop: 0,
    scene: null,
    style: {},
    dataset: {},
    appendChild(c) { this.children.push(c); return c; },
    addEventListener(type, fn) { (this._ev = this._ev || {})[type] = fn; },
    removeEventListener() {},
    setAttribute(k, v) { (this.attrs = this.attrs || {})[k] = String(v); },
    getAttribute(k) { return (this.attrs || {})[k]; },
    removeAttribute(k) { if (this.attrs) delete this.attrs[k]; },
    focus() {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } }
  };
  Object.defineProperty(node, 'textContent', {
    get() { return node._text; },
    set(v) { node._text = String(v == null ? '' : v); node.children.length = 0; }
  });
  return node;
}

function buildEnv(opts) {
  const elements = {};
  const doc = {
    getElementById(id) { return elements[id] || (elements[id] = makeEl('div')); },
    createElement(tag) { return makeEl(tag); },
    createTextNode(t) { return makeEl('#text'); },
    createDocumentFragment() { return makeEl('fragment'); }
  };
  const store = Object.assign({}, opts.localStorage || {});
  const localStorage = {
    getItem(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
    setItem(k, v) { store[k] = String(v); },
    removeItem(k) { delete store[k]; }
  };

  const posted = [];
  const fetches = [];
  const state = {
    jobs: [],          // 桥接 /api/jobs/watch 返回的列表
    ps: null,          // 桥接返回的 ps 现场状态（null = 老桥，没有这个字段）
    watchIds: [],      // 记录每次 watch 的 ids
    applyPosted: [],   // apply-result 消息
    acks: [],          // ack 请求
    onApplyResult: null
  };

  const parent = {
    postMessage(msg) {
      const pm = msg && msg.pluginMessage;
      if (!pm) return;
      posted.push(pm);
      if (pm.type === 'apply-result') {
        state.applyPosted.push(pm);
        if (state.onApplyResult) state.onApplyResult(pm);
      }
    }
  };

  function fakeResponse(body, init) {
    const i = init || {};
    const status = i.status || 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      arrayBuffer: async () => (body instanceof Uint8Array ? body.buffer : new ArrayBuffer(8))
    };
  }

  const fetch = async (url, init) => {
    const method = (init && init.method) || 'GET';
    fetches.push(method + ' ' + url);

    if (url.indexOf('/api/jobs/watch') >= 0) {
      const q = url.slice(url.indexOf('ids=') + 4);
      const raw = decodeURIComponent(q.split('&')[0] || '');
      const ids = raw ? raw.split(',') : [];
      state.watchIds.push(ids);
      // 契约：省略不存在的 id；这里按 state.jobs 返回，并只回请求的 id
      const wanted = state.jobs.filter(j => ids.indexOf(j.id) >= 0);
      return fakeResponse({ jobs: wanted, ps: state.ps || defaultPs() });
    }
    if (url.indexOf('/api/health') >= 0) {
      return fakeResponse({ ok: true, version: '0.3.0', jobs: 1, psOnline: true, ps: state.ps || defaultPs() });
    }
    if (/\/api\/jobs\/[^/]+\/result$/.test(url)) {
      return fakeResponse(new Uint8Array([137, 80, 78, 71]));
    }
    if (/\/api\/jobs\/[^/]+\/ack$/.test(url)) {
      state.acks.push(url);
      return fakeResponse({ ok: true });
    }
    if (/\/api\/jobs\/[^/]+$/.test(url)) {
      return fakeResponse({ ok: true });
    }
    return fakeResponse({});
  };

  const sandbox = {
    document: doc,
    localStorage,
    parent,
    fetch,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Date,
    Math,
    JSON,
    Promise,
    Uint8Array,
    ArrayBuffer,
    encodeURIComponent,
    decodeURIComponent,
    atob: s => Buffer.from(s, 'base64').toString('binary'),
    btoa: s => Buffer.from(s, 'binary').toString('base64'),
    navigator: { userAgent: 'node-test' }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  return { sandbox, state, posted, fetches, document: doc, localStorage };
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// 轮询等待条件成立，超时返回 false（协调器无任务时按 2 秒一睡，不能死等固定时长）
async function waitFor(cond, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 8000);
  while (Date.now() < deadline) {
    try {
      if (cond()) return true;
    } catch (_) { /* 条件里引用的东西可能还没就绪 */ }
    await sleep(100);
  }
  return false;
}

function makeRegistry(jobs) {
  return { version: 2, fileKey: null, jobs };
}

function makeJob(jobId, state, appliedAt, targetId) {
  return {
    jobId,
    at: Date.now() - 60000,
    appliedAt: appliedAt || 0,
    state,
    meta: {
      targetId: targetId || '1:1',
      targetName: 'Node ' + jobId,
      nodeName: 'Node ' + jobId,
      nodeWidth: 100,
      nodeHeight: 100,
      imageWidth: 100,
      imageHeight: 100,
      paintIndex: 0,
      fallback: false
    }
  };
}

function makeRemote(jobId, status, updatedAt) {
  return { id: jobId, status, updatedAt, createdAt: updatedAt - 1000, hasSource: true, hasResult: status === 'ready' };
}

// 老桥 / 没有 PS 上报时的默认值：updatedAt 为 0 → 客户端不做过滤
function defaultPs() {
  return { online: true, activeJobId: null, openJobIds: [], updatedAt: 0 };
}

// 数一下列表里渲染了几个任务卡
function countCards(env) {
  const list = env.document.getElementById('list');
  let n = 0;
  const stack = [list];
  while (stack.length) {
    const node = stack.pop();
    if (!node) continue;
    if (node.attrs && node.attrs['data-job']) n++;
    if (node.children) for (const c of node.children) stack.push(c);
  }
  return n;
}

// 数一下某个 class 的节点（例如缩略图 img）
function countClass(env, cls) {
  let n = 0;
  const stack = [env.document.getElementById('list')];
  while (stack.length) {
    const node = stack.pop();
    if (!node) continue;
    if (node.className === cls) n++;
    if (node.children) for (const c of node.children) stack.push(c);
  }
  return n;
}

async function boot(registryJobs, remoteJobs, opts) {
  const env = buildEnv(opts || {});
  vm.runInContext(code, env.sandbox, { filename: 'ui-inline.js' });
  await sleep(150); // 让脚本初始化（request-selection / load-jobs / startCoordinator）
  env.state.jobs = remoteJobs;
  if (opts && opts.onApplyResult) env.state.onApplyResult = opts.onApplyResult;
  // 主线程回注册表
  env.sandbox.window.onmessage({ data: { pluginMessage: { type: 'jobs', value: makeRegistry(registryJobs) } } });
  return env;
}

// 在 mock DOM 里按文本找节点 / 按 data-job 找某一行（用于真实点击按钮）
function findByText(root, text) {
  const stack = [root];
  while (stack.length) {
    const n = stack.pop();
    if (!n) continue;
    if (n._text === text) return n;
    if (n.children) for (const c of n.children) stack.push(c);
  }
  return null;
}

function findByJob(root, jobId) {
  const stack = [root];
  while (stack.length) {
    const n = stack.pop();
    if (!n) continue;
    if (n.attrs && n.attrs['data-job'] === jobId) return n;
    if (n.children) for (const c of n.children) stack.push(c);
  }
  return null;
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log((ok ? '[PASS] ' : '[FAIL] ') + name + (detail ? '\n         · ' + detail : ''));
}

(async function main() {
  // 每个用例都放一个「对照组」watching 任务，保证协调器一定在跑 watch 轮次，
  // 这样才能断言「某个 id 不在 ids 里」而不是「压根没跑」。
  const CTRL = 'ctrl0000';
  const ctrlJob = () => makeJob(CTRL, 'watching', 0, '0:0');
  const ctrlRemote = () => makeRemote(CTRL, 'editing', 1);

  async function bootWithControl(extraJobs, extraRemotes, opts) {
    const env = await boot(
      [ctrlJob()].concat(extraJobs || []),
      [ctrlRemote()].concat(extraRemotes || []),
      opts
    );
    await waitFor(() => env.state.watchIds.some(ids => ids.indexOf(CTRL) >= 0), 8000);
    return env;
  }

  // ---------- 用例 1：done 任务必须仍在监听 ----------
  {
    const env = await bootWithControl(
      [makeJob('aaaa0001', 'done', 1000, '9:9')],
      [makeRemote('aaaa0001', 'done', 1000)]
    );
    const last = env.state.watchIds[env.state.watchIds.length - 1] || [];
    check('done 状态的任务仍在 watch ids 里（这就是原来漏掉的根因）',
      last.indexOf('aaaa0001') >= 0, '最后一次 ids: ' + JSON.stringify(last));
  }

  // ---------- 用例 2：done 任务收到更新的 ready 结果 → 必须真的回写 ----------
  {
    const env = await boot(
      [makeJob('bbbb0002', 'done', 1000, '8:8')],
      [makeRemote('bbbb0002', 'ready', 2000)],
      {
        onApplyResult: function (pm) {
          // 模拟主线程回执
          setTimeout(function () {
            env.sandbox.window.onmessage({
              data: { pluginMessage: { type: 'apply-done', jobId: pm.jobId, ok: true } }
            });
          }, 10);
        }
      }
    );
    const applied = await waitFor(
      () => env.state.applyPosted.some(p => p.jobId === 'bbbb0002'), 8000);
    check('done 任务收到新结果 → 发出 apply-result（PSD 重开再回传能贴回）', applied,
      'apply-result 次数: ' + env.state.applyPosted.filter(p => p.jobId === 'bbbb0002').length);
    const acked = await waitFor(
      () => env.state.acks.some(u => u.indexOf('bbbb0002') >= 0), 5000);
    check('回写成功后带 updatedAt 发 ack', acked,
      'ack 次数: ' + env.state.acks.filter(u => u.indexOf('bbbb0002') >= 0).length);
  }

  // ---------- 用例 3：用户主动停止的任务不再监听 ----------
  {
    const env = await bootWithControl(
      [makeJob('cccc0003', 'stopped', 500)],
      [makeRemote('cccc0003', 'done', 500)]
    );
    const ever = env.state.watchIds.some(ids => ids.indexOf('cccc0003') >= 0);
    check('stopped 的任务不在 watch ids 里', !ever, '历史 ids 轮次: ' + env.state.watchIds.length);
  }

  // ---------- 用例 4：expired 不监听；failed 仍要监听 ----------
  {
    const env = await bootWithControl(
      [makeJob('dddd0004', 'failed', 0), makeJob('eeee0005', 'expired', 0)],
      [makeRemote('dddd0004', 'failed', 1), makeRemote('eeee0005', 'done', 1)]
    );
    const last = env.state.watchIds[env.state.watchIds.length - 1] || [];
    check('expired 不监听', last.indexOf('eeee0005') < 0, '最后一次 ids: ' + JSON.stringify(last));
    check('failed 仍监听（否则 PS 取消后就永久拒收）', last.indexOf('dddd0004') >= 0,
      '最后一次 ids: ' + JSON.stringify(last));
  }

  // ---------- 用例 5：watch ids 有上限，不会无限增长 ----------
  {
    const many = [];
    for (let i = 0; i < 80; i++) many.push(makeJob('job' + String(i).padStart(5, '0'), 'done', 1000 + i));
    const env = await bootWithControl(many, many.map(j => makeRemote(j.jobId, 'done', j.appliedAt)));
    const last = env.state.watchIds[env.state.watchIds.length - 1] || [];
    check('watch ids 被限制在 40 个以内', last.length <= 40 && last.length > 0,
      'ids 数量: ' + last.length);
  }

  // ---------- 用例 6：PS「取消任务」(failed) 之后重开 PSD 再回传 → 自动贴回 ----------
  {
    const env = await boot(
      [makeJob('ffff0006', 'failed', 1000, '7:7')],
      [makeRemote('ffff0006', 'ready', 2000)],
      {
        onApplyResult: function (pm) {
          setTimeout(function () {
            env.sandbox.window.onmessage({
              data: { pluginMessage: { type: 'apply-done', jobId: pm.jobId, ok: true } }
            });
          }, 10);
        }
      }
    );
    const applied = await waitFor(
      () => env.state.applyPosted.some(p => p.jobId === 'ffff0006'), 8000);
    check('PS 取消（failed）后收到新回传 → 自动 apply，不用点「继续等待」', applied,
      'apply-result 次数: ' + env.state.applyPosted.filter(p => p.jobId === 'ffff0006').length);
  }

  // ---------- 用例 7：用户在图麦里主动「停止」的任务，仍然不自动恢复 ----------
  {
    const env = await bootWithControl(
      [makeJob('99990007', 'stopped', 1000, '6:6')],
      [makeRemote('99990007', 'ready', 2000)]
    );
    await sleep(2500);
    const applied = env.state.applyPosted.some(p => p.jobId === '99990007');
    check('用户主动「停止」的任务不会被自动恢复', !applied,
      'stopped 任务的 apply-result 次数: ' + env.state.applyPosted.filter(p => p.jobId === '99990007').length);
  }

  // ---------- 用例 8：还没回写过就点「停止」→ 必须真停住（不能再落到 failed 继续监听） ----------
  {
    const env = await bootWithControl(
      [makeJob('88880008', 'watching', 0, '5:5')],
      [makeRemote('88880008', 'editing', 1)]
    );
    const watched = await waitFor(
      () => env.state.watchIds.some(ids => ids.indexOf('88880008') >= 0), 8000);
    check('停止前该任务在监听', watched);

    const card = findByJob(env.document.getElementById('list'), '88880008');
    const btn = card ? findByText(card, '停止') : null;
    if (!btn || !btn._ev || !btn._ev.click) {
      check('能点到该行的「停止」按钮', false, 'card=' + !!card + ' btn=' + !!btn);
    } else {
      check('能点到该行的「停止」按钮', true);
      btn._ev.click();
      await sleep(700);
      const roundsBefore = env.state.watchIds.length;

      // 停止之后桥接才出现新结果：不应该贴回
      env.state.jobs.push(makeRemote('88880008', 'ready', 5000));
      await sleep(2500);

      const laterIds = env.state.watchIds.slice(roundsBefore);
      const stillWatched = laterIds.some(ids => ids.indexOf('88880008') >= 0);
      const applied = env.state.applyPosted.some(p => p.jobId === '88880008');
      check('未回写过点「停止」→ 退出监听', !stillWatched,
        '停止后 watch 轮次: ' + laterIds.length);
      check('未回写过点「停止」→ 之后的新结果也不贴回', !applied,
        'apply-result 次数: ' + env.state.applyPosted.filter(p => p.jobId === '88880008').length);
    }
  }

  // ---------- 用例 9：列表跟随 PS（只显示 PS 里打开的任务 + 显示全部开关） ----------
  {
    const env = await boot(
      [makeJob('aaa10001', 'done', 1000, '1:1'), makeJob('aaa10002', 'done', 1000, '2:2')],
      [makeRemote('aaa10001', 'done', 1000), makeRemote('aaa10002', 'done', 1000)]
    );
    // PS 上报：只开着 aaa10001
    env.state.ps = {
      online: true, activeJobId: 'aaa10001', openJobIds: ['aaa10001'], updatedAt: Date.now()
    };
    const filtered = await waitFor(() => countCards(env) === 1, 8000);
    check('PS 只开着 1 个 → 列表只显示 1 个', filtered, '渲染卡片数: ' + countCards(env));

    const btn = env.document.getElementById('filterBtn');
    if (btn && btn._ev && btn._ev.click) {
      btn._ev.click();
      await sleep(300);
      const all = countCards(env);
      check('点「显示全部」→ 两个记录都回来', all === 2, '渲染卡片数: ' + all);
    } else {
      check('能点到「显示全部」按钮', false);
    }
  }

  // ---------- 用例 10：老任务没有缩略图 → 请求主线程补一张 ----------
  {
    const env = await boot(
      [makeJob('bbb10011', 'done', 1000, '3:3')],
      [makeRemote('bbb10011', 'done', 1000)]
    );
    const asked = await waitFor(
      () => env.posted.some(m => m.type === 'thumb-request' && m.jobId === 'bbb10011'), 5000);
    check('老任务会请求补缩略图', asked);

    // 主线程回一张图 → 列表里应该出现缩略图 img
    env.sandbox.window.onmessage({
      data: { pluginMessage: { type: 'thumb-result', jobId: 'bbb10011', data: 'AAAA' } }
    });
    await sleep(200);
    check('收到缩略图后渲染出 img', countClass(env, 'thumb') === 1,
      'thumb 节点数: ' + countClass(env, 'thumb'));

    // 拿不到（节点已删）→ 记成 none，不该反复重试
    const before = env.posted.filter(m => m.type === 'thumb-request' && m.jobId === 'bbb10011').length;
    env.sandbox.window.onmessage({
      data: { pluginMessage: { type: 'thumb-result', jobId: 'bbb10011', data: '' } }
    });
    await sleep(300);
    const after = env.posted.filter(m => m.type === 'thumb-request' && m.jobId === 'bbb10011').length;
    check('拿不到缩略图时不再重复请求', after === before, '请求次数 ' + before + ' → ' + after);
  }

  // ---------- 用例 11：PS 打开后关掉、又没回传 → 列表要收起 ----------
  {
    const job = makeJob('ccc10012', 'watching', 0, '4:4');
    job.at = Date.now(); // 刚发出
    // 用对照组保证协调器立刻在跑 watch（否则它先睡 3 秒，过滤还没生效就断言了）
    const env = await bootWithControl([job], [makeRemote('ccc10012', 'editing', 1)]);

    // PS 在线但还没打开它：缓冲期内应当仍显示
    env.state.ps = { online: true, activeJobId: null, openJobIds: [], updatedAt: Date.now() };
    await waitFor(
      () => env.document.getElementById('filterBtn').textContent === '只看 PS 中', 6000);
    const inGrace = await waitFor(() => countCards(env) === 1, 5000);
    check('刚发出、PS 还没接手 → 缓冲期内仍在列表', inGrace, '卡片数: ' + countCards(env));

    // PS 打开它（记下 seenOpen）
    env.state.ps = {
      online: true, activeJobId: 'ccc10012', openJobIds: ['ccc10012'], updatedAt: Date.now() + 1000
    };
    await sleep(700);

    // 用户在 PS 里把它关掉，没回传
    env.state.ps = { online: true, activeJobId: null, openJobIds: [], updatedAt: Date.now() + 2000 };
    const hidden = await waitFor(() => countCards(env) === 0, 6000);
    check('PS 关掉未回传的文档 → 列表收起', hidden, '卡片数: ' + countCards(env));
  }

  const failed = results.filter(r => !r.ok);
  console.log('\n========================================');
  console.log('结果：' + (results.length - failed.length) + '/' + results.length + ' 通过');
  console.log('========================================');
  if (failed.length) {
    console.log('失败项：');
    failed.forEach(f => console.log(' - ' + f.name + (f.detail ? ' (' + f.detail + ')' : '')));
    process.exit(1);
  }
  process.exit(0);
})().catch(err => {
  console.error('测试自身异常：', err);
  process.exit(2);
});
