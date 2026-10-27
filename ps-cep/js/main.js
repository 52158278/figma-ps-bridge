'use strict';

/**
 * Photoshop CEP 面板（Photoshop 2022+）· 多文档并行版
 *
 * 契约：docs/multi-doc-spec.md 第 5 章
 * - Figma 一次送来 N 个任务，PS 里同时开 N 个文档（每轮最多开 1 个，避免连续弹窗卡死）
 * - 每个文档靠 XMP jobName 里的 marker 认回自己的 jobId；所有定位都用 docId
 * - 保存并回传只作用于「当前活动文档」，并按 docId 精确定位，绝不回退 activeDocument
 * - 周期性扫描已打开文档，登记/刷新 session；文档关掉就置 closed
 * - open 的 session 每 20 秒续租（touch），租约丢了就 claim 夺回，不重新打开文档
 * - 全部回传：逐个回传 state=open 的 session，单个失败不中断
 *
 * 网络与文件全部走 Node（--enable-nodejs --mixed-context），
 * 打开/导出/读文档列表走 ExtendScript（host/index.jsx）。
 */

const POLL_MS = 2000;
const RESTORE_MS = 3000;
const TOUCH_CHECK_MS = 2000;
const TOUCH_INTERVAL_MS = 20000;
const DEFAULT_SERVER = 'http://127.0.0.1:8765';
// 与 bridge/server.py、figma-plugin/ui.html 保持一致
const PORT_CANDIDATES = [8765, 8766, 8767, 8768, 8769, 8770, 8771, 8772, 8773, 8774];

const SERVER_SETTING_KEY = 'ps-bridge-server';
const AUTO_SETTING_KEY = 'ps-bridge-auto';
const IGNORED_SETTING_KEY = 'ps-bridge-ignored';

const HOST_ACTIVE_DOC_TIMEOUT = 5000;
const HOST_MARKER_TIMEOUT = 5000;
const HOST_LIST_DOCS_TIMEOUT = 8000;
const HOST_OPEN_TIMEOUT = 60000;
const HOST_SAVE_TIMEOUT = 120000;
const HTTP_TIMEOUT_MS = 15000;
const HTTP_UPLOAD_TIMEOUT_MS = 60000;

const TEMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const LOG_THROTTLE_MS = 10000;

const el = {
  status: document.getElementById('status'),
  server: document.getElementById('server'),
  auto: document.getElementById('auto'),
  save: document.getElementById('save'),
  sendAll: document.getElementById('sendAll'),
  pull: document.getElementById('pull'),
  activeDoc: document.getElementById('activeDoc'),
  sessions: document.getElementById('sessions'),
  sessionCount: document.getElementById('sessionCount'),
  log: document.getElementById('log')
};

/* ------------------------------ 会话模型 ------------------------------ */

/**
 * sessions: Map<jobId, Session>
 * Session = { jobId, docId, docName, meta, state, lastError,
 *             lastTouchAt, metaLoading }
 * state ∈ opening | open | sent | closed | error
 */
const sessions = new Map();
/** 用户主动取消的 jobId，持久化到 localStorage，重启面板也不自动接回 */
const ignored = new Set(loadIgnored());

let serverUrl = DEFAULT_SERVER;
let autoReceive = true;
let running = true;

let activeDoc = null; // { docId, docName } 最近一次从宿主读到的活动文档
// 最近一次从宿主读到的「PS 里真实打开着的文档」列表。
// 上报给 Figma 的 openJobIds / activeJobId 以它为准 —— 不再依赖会话表，
// 否则被「取消」过的任务（ignored）即使 PSD 明明开着也不会显示（v0.3.2）。
let openDocs = null; // null = 还没读过宿主文档列表
let openDocsFingerprint = '';
let openingJobId = null;
let saving = false;
let sendingAll = false;
let restoring = false;
let touching = false;
let legacyWarned = false;
// 对方是没有 /api/ps/heartbeat 的 0.1.0 旧桥：状态栏固定加前缀提醒，直到心跳恢复
let legacyBridge = false;
let statusPrefix = '';

let hostQueue = Promise.resolve();
let hostBusy = false;

let lastRenderSignature = '';
const throttledLogs = {};

/* ------------------------------ Node 依赖 ------------------------------ */

let fs = null;
let os = null;
let path = null;
let http = null;
let https = null;

try {
  fs = require('fs');
  os = require('os');
  path = require('path');
  http = require('http');
  https = require('https');
} catch (err) {
  window.__nodeError = err;
}

/* ------------------------------ 小工具 ------------------------------ */

function errMsg(err) {
  return (err && err.message) || String(err);
}

function errDetail(res) {
  return String(res == null ? '' : res).replace(/^ERR:/, '');
}

function isHttp404(err) {
  return /^HTTP 404\b/.test(errMsg(err));
}

function readSetting(key) {
  try {
    return localStorage.getItem(key);
  } catch (_) {
    return null;
  }
}

function writeSetting(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch (_) {
    /* 存不下不影响主流程 */
  }
}

function loadIgnored() {
  try {
    const raw = localStorage.getItem(IGNORED_SETTING_KEY);
    const list = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(list)) return [];
    return list.filter(function (id) { return typeof id === 'string' && id; });
  } catch (_) {
    return [];
  }
}

function persistIgnored() {
  writeSetting(IGNORED_SETTING_KEY, JSON.stringify(Array.from(ignored)));
}

function api(p) {
  return serverUrl.replace(/\/+$/, '') + p;
}

function log(text, isError) {
  const now = new Date();
  const pad = function (n) { return ('0' + n).slice(-2); };
  const line = document.createElement('div');
  line.className = isError ? 'err' : '';
  line.textContent = pad(now.getHours()) + ':' + pad(now.getMinutes()) + ':' + pad(now.getSeconds()) + '  ' + text;
  el.log.appendChild(line);
  el.log.scrollTop = el.log.scrollHeight;
}

function logThrottled(text, isError) {
  const now = Date.now();
  if (throttledLogs[text] && now - throttledLogs[text] < LOG_THROTTLE_MS) return;
  throttledLogs[text] = now;
  log(text, isError);
}

function setStatus(text) {
  const message = String(text == null ? '' : text);
  el.status.textContent = statusPrefix ? statusPrefix + '｜' + message : message;
}

function shortName(name) {
  const text = String(name || '');
  return text.length > 24 ? text.slice(0, 23) + '…' : text;
}

/* ------------------------------ HTTP（Node） ------------------------------ */

function splitServer() {
  const m = /^(https?):\/\/([^/:]+)(?::(\d+))?/.exec(serverUrl);
  if (!m) return null;
  return {
    protocol: m[1],
    hostname: m[2],
    port: m[3] ? Number(m[3]) : (m[1] === 'https' ? 443 : 80)
  };
}

function request(method, p, body, contentType, timeoutMs) {
  return new Promise(function (resolve, reject) {
    const target = splitServer();
    if (!target) return reject(new Error('桥接地址无效'));

    let settled = false;
    function fail(err) {
      if (settled) return;
      settled = true;
      reject(err);
    }

    const mod = target.protocol === 'https' ? https : http;
    const headers = { Accept: 'application/json, image/png, */*' };
    if (body) {
      headers['Content-Type'] = contentType || 'application/octet-stream';
      headers['Content-Length'] = body.length;
    }

    const req = mod.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: p,
        method: method,
        headers: headers
      },
      function (res) {
        const chunks = [];
        res.on('data', function (c) { chunks.push(c); });
        res.on('end', function () {
          if (settled) return;
          settled = true;
          const buf = Buffer.concat(chunks);
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error('HTTP ' + res.statusCode));
          }
          resolve(buf);
        });
      }
    );

    req.setTimeout(timeoutMs || HTTP_TIMEOUT_MS, function () {
      try {
        req.destroy();
      } catch (_) {
        try { req.abort(); } catch (_) { /* 忽略 */ }
      }
      fail(new Error('请求超时'));
    });

    req.on('error', fail);
    if (body) req.write(body);
    req.end();
  });
}

async function getJson(p) {
  const buf = await request('GET', p, null);
  if (!buf.length) return {};
  return JSON.parse(buf.toString('utf8'));
}

async function postJson(p, payload) {
  const buf = await request(
    'POST',
    p,
    Buffer.from(JSON.stringify(payload || {}), 'utf8'),
    'application/json'
  );
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch (_) {
    return {};
  }
}

/* ------------------------------ ExtendScript ------------------------------ */

// PS 弹模态框时 evalScript 会一直不回调，这里加超时避免轮询整体卡死。
// 超时和脚本异常都会以 ERR: 前缀返回，调用方必须把它当成「PS 无响应/出错」，
// 不能和「文档没有标记」混为一谈（P0 误导性报错）。
function evalScript(script, timeoutMs) {
  return new Promise(function (resolve) {
    let done = false;
    const timer = setTimeout(function () {
      if (done) return;
      done = true;
      resolve('ERR:Photoshop 没有响应（可能开着对话框）');
    }, timeoutMs || 8000);

    try {
      window.__adobe_cep__.evalScript(script, function (result) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(result == null ? '' : String(result));
      });
    } catch (err) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve('ERR:' + errMsg(err));
    }
  });
}

function esStr(value) {
  return JSON.stringify(String(value));
}

function toEsPath(p) {
  return p.replace(/\\/g, '/');
}

// 同一时刻只允许一个宿主调用在跑；restore 之类的后台扫描看到 hostBusy 就直接跳过，
// 保存/打开则排队执行，避免多个 evalScript 同时卡在模态框上互相拖死。
function withHost(fn) {
  const run = hostQueue.then(function () {
    hostBusy = true;
    return Promise.resolve().then(fn).then(
      function (value) {
        hostBusy = false;
        return value;
      },
      function (err) {
        hostBusy = false;
        throw err;
      }
    );
  });
  hostQueue = run.then(function () {}, function () {});
  return run;
}

/** 'OK:<docId>|<docName>' / 'ERR:<msg>' */
async function hostActiveDoc() {
  const res = await evalScript('figmaBridgeActiveDoc()', HOST_ACTIVE_DOC_TIMEOUT);
  if (res.indexOf('OK:') !== 0) {
    throw new Error('无法读取当前活动文档：' + (errDetail(res) || 'Photoshop 返回了无法识别的内容'));
  }
  const body = res.slice(3);
  const idx = body.indexOf('|');
  const docId = (idx >= 0 ? body.slice(0, idx) : body).trim();
  if (!docId) throw new Error('无法读取当前活动文档：没有拿到 docId');
  return { docId: docId, docName: idx >= 0 ? body.slice(idx + 1) : '' };
}

/**
 * 'OK:<jobId>' / 'OK:'（没有标记）/ 'ERR:<msg>'
 * 关键：ERR 必须抛错，绝不能当成「没有标记」。
 */
async function hostReadMarkerActive() {
  const res = await evalScript('figmaBridgeReadMarkerActive()', HOST_MARKER_TIMEOUT);
  if (res.indexOf('ERR:') === 0) {
    const detail = errDetail(res);
    const suffix = /没有响应|对话框/.test(detail) ? '' : '（Photoshop 无响应或正在显示对话框）';
    throw new Error('无法读取当前文档的任务标记：' + detail + suffix + '，请关闭对话框后重试');
  }
  if (res.indexOf('OK:') !== 0) {
    throw new Error('无法读取当前文档的任务标记：Photoshop 返回了无法识别的内容，可能没有响应');
  }
  return res.slice(3).trim();
}

/** 'OK:<docId>|<docName>|<jobId>;...' → [{docId, docName, jobId}] */
function parseDocList(res) {
  if (res.indexOf('OK:') !== 0) {
    throw new Error('读取 Photoshop 文档列表失败：' + (errDetail(res) || '返回了无法识别的内容'));
  }
  const body = res.slice(3);
  const docs = [];
  if (!body) return docs;
  const entries = body.split(';');
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry) continue;
    const parts = entry.split('|');
    const docId = (parts[0] || '').trim();
    if (!docId) continue;
    docs.push({
      docId: docId,
      docName: parts[1] || '',
      jobId: (parts[2] || '').trim()
    });
  }
  return docs;
}

/** 打开图片：返回 { docId, docName } */
async function hostOpenImage(filePath, jobId) {
  const script = 'figmaBridgeOpenImage(' + esStr(toEsPath(filePath)) + ',' + esStr(jobId || '') + ')';
  const res = await evalScript(script, HOST_OPEN_TIMEOUT);
  if (res.indexOf('OK:') !== 0) {
    throw new Error(errDetail(res) || '打开图片失败');
  }
  const body = res.slice(3);
  const idx = body.indexOf('|');
  const docId = (idx >= 0 ? body.slice(0, idx) : body).trim();
  if (!docId) throw new Error('打开图片后没有拿到 docId');
  return { docId: docId, docName: idx >= 0 ? body.slice(idx + 1) : '' };
}

/**
 * 按 docId 精确导出 PNG：返回 'WxH'。
 * 宿主找不到 docId 会返回 ERR:NOT_FOUND，这里转成明确的中文错误。
 */
async function hostSavePng(filePath, docId) {
  const script = 'figmaBridgeSavePng(' + esStr(toEsPath(filePath)) + ',' + esStr(docId || '') + ')';
  const res = await evalScript(script, HOST_SAVE_TIMEOUT);
  if (res.indexOf('ERR:NOT_FOUND') === 0) {
    throw new Error('Photoshop 里找不到 docId=' + docId + ' 的文档（可能已被关闭）');
  }
  if (res.indexOf('OK:') !== 0) {
    throw new Error(errDetail(res) || '导出 PNG 失败');
  }
  return res.slice(3);
}

/* ------------------------------ 桥接接口 ------------------------------ */

// PS 现场状态：把「开着哪些任务、正在看哪一个」随心跳上报，Figma 端据此显示
// 「PS 已打开 / ◆ PS 正在看」。只是展示用，不参与任务流转（契约 v0.3.0）。
function psOpenJobIds() {
  // 优先用宿主文档列表（真实打开着哪些文档），会话表只作兜底
  if (openDocs) {
    const ids = [];
    for (let i = 0; i < openDocs.length; i++) {
      const jobId = openDocs[i] && openDocs[i].jobId;
      if (jobId && ids.indexOf(jobId) < 0) ids.push(jobId);
    }
    return ids;
  }
  const ids = [];
  sessions.forEach(function (session) {
    if (!session || !session.jobId || !session.docId) return;
    if (session.state === 'closed') return; // 文档已经关了
    if (ids.indexOf(session.jobId) < 0) ids.push(session.jobId);
  });
  return ids;
}

function psActiveJobId() {
  if (!activeDoc || !activeDoc.docId) return null;
  if (openDocs) {
    for (let i = 0; i < openDocs.length; i++) {
      const item = openDocs[i];
      if (item && item.docId === activeDoc.docId) return item.jobId || null;
    }
    return null;
  }
  let found = null;
  sessions.forEach(function (session) {
    if (found || !session || !session.docId) return;
    if (session.docId === activeDoc.docId) found = session.jobId;
  });
  return found;
}

// 新版桥接：POST /api/ps/heartbeat。
// 0.1.0 旧桥没有这个端点；绝不能退回 /api/health —— health 不刷新 LAST_PS_SEEN，
// 会让人误以为「PS 莫名离线」。检测到旧桥就明确提示升级，并让提示一直挂在状态栏。
async function sendHeartbeat() {
  try {
    const data = await postJson('/api/ps/heartbeat', {
      activeJobId: psActiveJobId(),
      openJobIds: psOpenJobIds()
    });
    // 端口通了不代表是桥接服务（比如 Clash/mihomo）：心跳也必须是桥接的明确响应
    if (!data || data.ok !== true) {
      throw new Error('心跳响应不是 Figma 桥接服务');
    }
    if (legacyBridge) {
      legacyBridge = false;
      statusPrefix = '';
      legacyWarned = false;
      log('桥接服务已恢复 /api/ps/heartbeat，PS 在线状态恢复正常');
      setStatus('已连接 · 心跳恢复正常');
    }
  } catch (err) {
    if (!isHttp404(err)) throw err;

    legacyBridge = true;
    statusPrefix = '桥接服务版本过旧，请重新运行部署器或用新版启动';
    if (!legacyWarned) {
      legacyWarned = true;
      log('桥接服务版本过旧，请重新运行部署器或用新版启动（检测到 0.1.0 旧桥，没有 /api/ps/heartbeat）；旧版不刷新 PS 心跳，Figma 侧会显示 PS 离线', true);
    }
    // 故意不调用 /api/health 兜底：它不刷新心跳，只会把「版本过旧」伪装成「已连接」
    setStatus('旧桥缺少心跳接口，PS 在线状态可能显示为离线');
  }
}

// 新版：GET /api/ps/jobs；旧版没有这个路径，退到 GET /api/jobs（返回结构相同）
async function fetchJobs() {
  try {
    const data = await getJson('/api/ps/jobs');
    return (data && data.jobs) || [];
  } catch (err) {
    if (!isHttp404(err)) throw err;
    const data = await getJson('/api/jobs');
    return (data && data.jobs) || [];
  }
}

// 续租：新版 /touch；旧版没有，退回 /claim（效果相同：刷新租约）
async function touchJob(jobId) {
  try {
    return await postJson('/api/jobs/' + jobId + '/touch', {});
  } catch (err) {
    if (!isHttp404(err)) throw err;
    return await postJson('/api/jobs/' + jobId + '/claim', {});
  }
}

/* ------------------------------ 会话渲染 ------------------------------ */

function openTargets() {
  const list = [];
  sessions.forEach(function (session) {
    if (session.state === 'open' && session.docId) list.push(session);
  });
  return list;
}

function sessionStateLabel(session) {
  if (ignored.has(session.jobId)) return '已取消';
  const labels = {
    opening: '正在打开',
    open: '待编辑',
    sent: '已回传',
    closed: '文档已关闭',
    error: '出错'
  };
  return labels[session.state] || session.state;
}

function sessionSignature() {
  const parts = [
    'active:' + (activeDoc ? activeDoc.docId + '|' + activeDoc.docName : ''),
    'busy:' + (saving ? 's' : '') + (sendingAll ? 'a' : '') + (openingJobId || '')
  ];
  sessions.forEach(function (s) {
    const meta = s.meta || {};
    parts.push([
      s.jobId,
      s.state,
      s.docId || '',
      s.docName || '',
      meta.nodeName || meta.targetName || '',
      meta.imageWidth || '',
      meta.imageHeight || '',
      s.lastError || ''
    ].join('~'));
  });
  return parts.join(';');
}

function miniButton(label, handler, disabled) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'mini';
  button.textContent = label;
  button.disabled = !!disabled;
  button.addEventListener('click', function () {
    try {
      Promise.resolve(handler()).catch(function (err) {
        log(label + '操作失败：' + errMsg(err), true);
      });
    } catch (err) {
      log(label + '操作失败：' + errMsg(err), true);
    }
  });
  return button;
}

function renderSessions() {
  if (!el.sessions) return;
  const signature = sessionSignature();
  if (signature === lastRenderSignature) return;
  lastRenderSignature = signature;

  el.sessions.textContent = '';
  const list = [];
  sessions.forEach(function (session) { list.push(session); });
  if (el.sessionCount) el.sessionCount.textContent = String(list.length);

  if (!list.length) {
    const empty = document.createElement('div');
    empty.className = 'sessions-empty';
    empty.textContent = '还没有从 Figma 收到的文档';
    el.sessions.appendChild(empty);
    return;
  }

  const busy = saving || sendingAll;
  for (let i = 0; i < list.length; i++) {
    const session = list[i];
    const meta = session.meta || {};
    const row = document.createElement('div');
    row.className = 'session state-' + session.state +
      (activeDoc && session.docId === activeDoc.docId ? ' current' : '');

    const top = document.createElement('div');
    top.className = 'session-top';

    const name = document.createElement('div');
    name.className = 'session-name';
    name.textContent = meta.nodeName || meta.targetName || session.docName || ('任务 #' + session.jobId);
    name.title = name.textContent;
    top.appendChild(name);

    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = sessionStateLabel(session);
    top.appendChild(badge);
    row.appendChild(top);

    const info = document.createElement('div');
    info.className = 'session-meta';
    const bits = ['#' + session.jobId];
    if (session.docName) bits.push(session.docName);
    if (session.docId) bits.push('docId ' + session.docId);
    if (meta.imageWidth) bits.push(meta.imageWidth + '×' + meta.imageHeight);
    info.textContent = bits.join(' · ');
    row.appendChild(info);

    if (session.lastError) {
      const errorLine = document.createElement('div');
      errorLine.className = 'session-error';
      errorLine.textContent = session.lastError;
      row.appendChild(errorLine);
    }

    const actions = document.createElement('div');
    actions.className = 'session-actions';
    if (session.state === 'open' && session.docId) {
      actions.appendChild(miniButton('回传', function () { return sendOneSession(session); }, busy));
    }
    if (!ignored.has(session.jobId)) {
      actions.appendChild(miniButton('取消', function () { return cancelSession(session); }, busy));
    }
    if (actions.childNodes.length) row.appendChild(actions);

    el.sessions.appendChild(row);
  }
}

function refreshButtons() {
  const targets = openTargets();
  const name = activeDoc ? activeDoc.docName : '';

  if (el.save) {
    el.save.textContent = name ? '保存并回传「' + shortName(name) + '」' : '保存并回传当前文档';
    el.save.title = name
      ? '作用于当前活动文档：' + name
      : '在 Photoshop 里切换到要回传的文档';
    el.save.disabled = saving || sendingAll || !!openingJobId || !activeDoc;
  }
  if (el.sendAll) {
    el.sendAll.textContent = '全部回传（' + targets.length + ' 个）';
    el.sendAll.disabled = saving || sendingAll || targets.length === 0;
  }
  if (el.pull) {
    el.pull.disabled = saving || sendingAll || !!openingJobId;
  }
  if (el.activeDoc) {
    el.activeDoc.textContent = name
      ? '当前文档：' + name + (activeDoc.docId ? '（docId ' + activeDoc.docId + '）' : '')
      : '当前文档：无';
  }
}

function refresh() {
  refreshButtons();
  renderSessions();
}

/* ------------------------------ 打开任务 ------------------------------ */

function pickPendingJob(jobs) {
  let candidate = null;
  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    if (!job || job.status !== 'pending') continue;
    if (sessions.has(job.id) || ignored.has(job.id)) continue;
    if (!candidate || (job.createdAt || 0) < (candidate.createdAt || 0)) candidate = job;
  }
  return candidate;
}

function beginOpen(job) {
  if (openingJobId) return;
  openingJobId = job.id;
  refreshButtons();
  openJob(job).then(
    function () {
      openingJobId = null;
      refresh();
    },
    function (err) {
      openingJobId = null;
      log('打开任务 #' + job.id + ' 时发生异常：' + errMsg(err), true);
      refresh();
    }
  );
}

async function openJob(job) {
  const session = {
    jobId: job.id,
    docId: null,
    docName: null,
    meta: job.meta || {},
    state: 'opening',
    lastError: null,
    lastTouchAt: 0,
    metaLoading: false,
    // 这份文档是面板自己打开的临时 PNG（不是用户自己的 PSD）：
    // 关掉它且没回传过，就说明这个任务作废了（v0.3.3）
    openedByUs: true
  };
  sessions.set(job.id, session);
  refresh();

  const meta = session.meta;
  log('收到任务 #' + job.id + '：' + (meta.nodeName || meta.targetName || '未命名') +
    ' ' + (meta.imageWidth || '?') + '×' + (meta.imageHeight || '?'));

  let tempPath = null;
  try {
    setStatus('下载原图…');
    const buffer = await request('GET', '/api/jobs/' + job.id + '/image', null, null, HTTP_TIMEOUT_MS);
    if (!buffer || !buffer.length) throw new Error('Figma 发来的原图为空');
    log('已下载 ' + Math.round(buffer.length / 1024) + ' KB');

    tempPath = path.join(os.tmpdir(), 'figma-' + job.id + '-' + Date.now() + '.png');
    fs.writeFileSync(tempPath, buffer);

    setStatus('在 Photoshop 中打开…');
    const opened = await withHost(function () {
      return hostOpenImage(tempPath, job.id);
    });
    session.docId = opened.docId;
    session.docName = opened.docName;
    session.state = 'open';
    session.lastError = null;
    session.lastTouchAt = Date.now();
    activeDoc = { docId: opened.docId, docName: opened.docName };

    // 打开成功后立刻删输入临时文件（PS 已经把图读进内存）
    try {
      fs.unlinkSync(tempPath);
      tempPath = null;
    } catch (_) {
      /* 删不掉就留给启动清理 */
    }

    log('已打开「' + opened.docName + '」（docId ' + opened.docId + '），编辑完点「保存并回传」');
    setStatus('等待编辑 · ' + opened.docName);

    // 领取租约：pending → editing
    try {
      const claimed = await postJson('/api/jobs/' + job.id + '/claim', {});
      if (!claimed || claimed.status !== 'editing') {
        session.lastError = '领取任务状态异常：' + ((claimed && claimed.status) || '未知');
        log('任务 #' + job.id + ' ' + session.lastError, true);
      }
    } catch (err) {
      session.lastError = '领取任务失败：' + errMsg(err);
      log('任务 #' + job.id + ' ' + session.lastError, true);
    }
  } catch (err) {
    session.state = 'error';
    session.lastError = errMsg(err);
    log('接收任务 #' + job.id + ' 失败：' + session.lastError, true);
    setStatus('接收失败：' + session.lastError);
    try {
      await postJson('/api/jobs/' + job.id + '/fail', { error: session.lastError });
    } catch (_) {
      /* 网络都不通时没法通知桥接；保留 error session，避免死循环重试 */
    }
  } finally {
    if (tempPath) {
      try {
        fs.unlinkSync(tempPath);
      } catch (_) {
        /* 清理失败不影响主流程 */
      }
    }
    refresh();
  }
}

/* ------------------------------ 文档扫描 / 会话登记 ------------------------------ */

async function loadSessionMeta(session) {
  if (!session || session.metaLoading) return;
  session.metaLoading = true;
  try {
    const job = await getJson('/api/jobs/' + session.jobId);
    if (job && job.meta) session.meta = job.meta;
    if (!job || session.state !== 'open') return;

    // 面板重开 / 手动打开旧 PSD：按桥接里的状态给 session 一个准确起点，
    // 已回传过的任务不要再去 touch/claim 把 done 复活成 editing。
    if (job.status === 'ready' || job.status === 'done') {
      session.state = 'sent';
      session.lastError = null;
      log('认出任务 #' + session.jobId + '（「' + (session.docName || '') + '」）之前已经回传过；改完可用「保存并回传」再覆盖');
    } else if (job.status === 'failed') {
      session.state = 'error';
      session.lastError = job.error || '桥接服务标记该任务失败';
    } else {
      session.lastError = null;
    }
  } catch (err) {
    if (isHttp404(err)) {
      session.lastError = '任务已过期（桥接服务里已不存在）';
    } else {
      session.lastError = '读取任务信息失败：' + errMsg(err);
    }
  } finally {
    session.metaLoading = false;
    refresh();
  }
}

function applyActiveDocResult(res) {
  if (res.indexOf('OK:') !== 0) {
    const detail = errDetail(res);
    if (/没有响应|对话框/.test(detail)) {
      logThrottled('Photoshop 没有响应（可能开着对话框），暂时读不到当前文档', true);
    }
    activeDoc = null;
    return;
  }
  const body = res.slice(3);
  const idx = body.indexOf('|');
  const docId = (idx >= 0 ? body.slice(0, idx) : body).trim();
  if (!docId) {
    activeDoc = null;
    return;
  }
  activeDoc = { docId: docId, docName: idx >= 0 ? body.slice(idx + 1) : '' };
}

function applyDocList(docs) {
  // 先记录“PS 里真实打开着哪些文档”，这份数据用于上报给 Figma。
  // 注意：即使某个任务被「取消」过（ignored），它的文档仍然是开着的，也应该让 Figma 看到。
  openDocs = docs;
  const fingerprint = docs.map(function (d) { return (d.docId || '') + ':' + (d.jobId || ''); }).join('|');
  if (fingerprint !== openDocsFingerprint) {
    openDocsFingerprint = fingerprint;
    // 文档开/关/切换活动文档时立刻上报一次，别等下一轮 2 秒心跳
    sendHeartbeat().catch(function () {});
  }

  const present = {};
  for (let i = 0; i < docs.length; i++) {
    const item = docs[i];
    if (!item.docId) continue;
    present[item.docId] = true;
    if (!item.jobId) continue; // 不是 Figma 发来的文档
    if (ignored.has(item.jobId)) continue; // 用户取消过，不再自动登记会话

    let session = sessions.get(item.jobId);
    if (!session) {
      session = {
        jobId: item.jobId,
        docId: item.docId,
        docName: item.docName,
        meta: {},
        state: 'open',
        lastError: null,
        // 先给 loadSessionMeta 一点时间确认任务状态；20 秒后才需要续租
        lastTouchAt: Date.now(),
        metaLoading: false
      };
      sessions.set(item.jobId, session);
      log('认出文档「' + item.docName + '」对应任务 #' + item.jobId + '（docId ' + item.docId + '）');
      loadSessionMeta(session);
      continue;
    }

    session.docId = item.docId;
    session.docName = item.docName;
    if (session.state === 'closed' || session.state === 'error') {
      session.state = 'open';
      session.lastError = null;
      log('文档「' + item.docName + '」重新打开，恢复任务 #' + item.jobId);
    }
  }

  sessions.forEach(function (session) {
    if (!session.docId) return;
    if (present[session.docId]) return;
    if (session.state === 'closed') return;

    const wasSent = session.state === 'sent';
    session.state = 'closed';
    session.lastError = null;
    log('文档「' + (session.docName || session.docId) + '」已关闭（任务 #' + session.jobId + '）');

    // 我们自己打开的临时 PNG 被关掉、又没回传过 → 这个任务作废。
    // 通知桥接标记失败，别让它一直挂在 pending/editing 里占着任务列表和租约。
    if (session.openedByUs && !wasSent) {
      ignored.add(session.jobId);
      persistIgnored();
      postJson('/api/jobs/' + session.jobId + '/fail', { error: 'PS 里关闭了文档，未回传' })
        .catch(function () {});
      log('任务 #' + session.jobId + ' 没回传就关掉了，已标记结束（不再自动接收）');
    }
  });
}

async function restoreFromDocuments() {
  if (!running || hostBusy || openingJobId || saving || sendingAll) return;
  try {
    await withHost(async function () {
      const listRes = await evalScript('figmaBridgeListDocs()', HOST_LIST_DOCS_TIMEOUT);
      const docs = parseDocList(listRes);
      const activeRes = await evalScript('figmaBridgeActiveDoc()', HOST_ACTIVE_DOC_TIMEOUT);
      applyActiveDocResult(activeRes);
      applyDocList(docs);
    });
    refresh();
  } catch (err) {
    logThrottled('读取 Photoshop 文档列表失败：' + errMsg(err), true);
  }
}

async function restoreTick() {
  if (restoring) return;
  restoring = true;
  try {
    await restoreFromDocuments();
  } finally {
    restoring = false;
  }
}

/* ------------------------------ 租约续约 ------------------------------ */

async function touchDueSessions() {
  const now = Date.now();
  const due = [];
  sessions.forEach(function (session) {
    if (session.state !== 'open' || !session.docId || session.sending) return;
    if (now - (session.lastTouchAt || 0) >= TOUCH_INTERVAL_MS) due.push(session);
  });

  for (let i = 0; i < due.length; i++) {
    const session = due[i];
    if (session.sending || session.state !== 'open') continue;
    session.lastTouchAt = now;
    try {
      const job = await touchJob(session.jobId);
      // touch 往返期间可能已经开始回传（回传结束会把状态置 sent），别再把 ready 抢回 editing
      if (session.sending || session.state !== 'open') continue;
      if (!job || job.status !== 'editing') {
        // 租约丢了（被释放回 pending，或别的客户端领走）→ 直接 claim 夺回，不重新打开文档
        const claimed = await postJson('/api/jobs/' + session.jobId + '/claim', {});
        if (claimed && claimed.status === 'editing') {
          session.lastError = null;
          log('已夺回任务 #' + session.jobId + ' 的租约（文档保持打开）');
        } else {
          session.lastError = '租约状态异常：' + ((claimed && claimed.status) || '未知');
          log('任务 #' + session.jobId + ' 夺回租约失败：' + session.lastError, true);
        }
      } else if (session.lastError && session.lastError.indexOf('租约') === 0) {
        session.lastError = null;
      }
      if (job && job.meta) session.meta = job.meta;
      refresh();
    } catch (err) {
      if (isHttp404(err)) {
        session.lastError = '任务已过期（桥接服务里已不存在）';
      } else {
        session.lastError = '续租失败：' + errMsg(err);
      }
      log('任务 #' + session.jobId + ' ' + session.lastError, true);
      refresh();
    }
  }
}

async function touchTick() {
  if (touching) return;
  touching = true;
  try {
    await touchDueSessions();
  } finally {
    touching = false;
  }
}

/* ------------------------------ 保存并回传 ------------------------------ */

// 找 session；没有就用 GET /api/jobs/<id> 现场建（用于面板重启后手动打开旧 PSD）
async function ensureSession(jobId, docId, docName) {
  // 用户明确对这份文档点「保存并回传」= 他就是要这个任务继续工作。
  // 之前「取消任务」留下的 ignored 记录必须清掉，否则面板会一边允许回传、
  // 一边又拒绝重新登记，造成前后不一致（v0.2.2）。
  if (ignored.has(jobId)) {
    ignored.delete(jobId);
    persistIgnored();
    log('任务 #' + jobId + ' 已恢复跟踪（之前被取消过）');
  }

  const existing = sessions.get(jobId);
  if (existing) {
    existing.docId = docId;
    existing.docName = docName;
    return existing;
  }

  let job = null;
  let failure = null;
  try {
    job = await getJson('/api/jobs/' + jobId);
  } catch (err) {
    failure = err;
  }
  if (!job) {
    if (failure && isHttp404(failure)) {
      throw new Error('任务 #' + jobId + ' 在桥接服务上已不存在（可能已过期或被清理；若你同时开了多个桥接窗口，请只保留一个），无法回传');
    }
    throw new Error('获取任务 #' + jobId + ' 失败：' + errMsg(failure));
  }

  const session = {
    jobId: jobId,
    docId: docId,
    docName: docName,
    meta: job.meta || {},
    state: 'open',
    lastError: null,
    lastTouchAt: 0,
    metaLoading: false
  };
  sessions.set(jobId, session);
  refresh();
  return session;
}

// 契约 5.3 第 4-7 步：按 docId 导出 → PUT result → 无论成败删临时文件 → state=sent
async function sendSession(session) {
  if (!session || !session.docId) throw new Error('任务 #' + (session && session.jobId) + ' 没有可用的 docId，无法定位文档');

  const outPath = path.join(os.tmpdir(), 'figma-' + session.jobId + '-out-' + Date.now() + '.png');
  session.sending = true; // 回传期间 touch 不要来抢租约
  try {
    setStatus('导出 PNG（docId ' + session.docId + '）…');
    const size = await withHost(function () {
      return hostSavePng(outPath, session.docId);
    });

    const buffer = fs.readFileSync(outPath);
    if (!buffer || !buffer.length) throw new Error('导出的图片为空');

    setStatus('回传到 Figma…');
    try {
      await request(
        'PUT',
        '/api/jobs/' + session.jobId + '/result',
        buffer,
        'image/png',
        HTTP_UPLOAD_TIMEOUT_MS
      );
    } catch (err) {
      if (isHttp404(err)) {
        throw new Error('任务 #' + session.jobId + ' 在桥接服务上已不存在（可能已过期或被清理；若你同时开了多个桥接窗口，请只保留一个），无法回传');
      }
      throw err;
    }

    session.state = 'sent';
    session.lastError = null;
    log('任务 #' + session.jobId + ' 已回传 ' + Math.round(buffer.length / 1024) + ' KB' +
      '（' + (session.docName || 'docId ' + session.docId) + (size ? ' · ' + size : '') + '）');
    refresh();
    // 后台确认 Figma 端是否真的贴回了（不阻塞面板）
    confirmApplied(session.jobId).catch(function () {});
    return true;
  } finally {
    session.sending = false;
    try {
      if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
    } catch (_) {
      /* 删除失败不影响主流程 */
    }
  }
}

/**
 * PS 单方面打开了一张图（没有任务标记）：导出 PNG 后在 Figma 里新建一个图层。
 * POST /api/jobs {source:'ps', mode:'insert'} → PUT result → Figma 端轮询发现后插入
 * （选中了图层就插在它正上方，尺寸等于图片像素尺寸）。
 */
async function sendAsInsert(doc) {
  if (!doc || !doc.docId) throw new Error('没有可用的活动文档');

  const outPath = path.join(os.tmpdir(), 'ps-insert-' + Date.now() + '.png');
  try {
    setStatus('导出 PNG（' + shortName(doc.docName || '当前文档') + '）…');
    const size = await withHost(function () {
      return hostSavePng(outPath, doc.docId);
    });

    const buffer = fs.readFileSync(outPath);
    if (!buffer || !buffer.length) throw new Error('导出的图片为空');

    const wh = /^(\d+)\s*[xX×]\s*(\d+)$/.exec(String(size || '').trim());
    const imageWidth = wh ? Number(wh[1]) : 0;
    const imageHeight = wh ? Number(wh[2]) : 0;

    setStatus('发到 Figma（会在选中图层上方新建）…');
    let created;
    try {
      created = await postJson('/api/jobs', {
        source: 'ps',
        mode: 'insert',
        client: 'ps',
        name: doc.docName || 'PS 图片',
        docName: doc.docName || '',
        imageWidth: imageWidth,
        imageHeight: imageHeight
      });
    } catch (err) {
      throw new Error('创建发图任务失败：' + errMsg(err));
    }
    const jobId = created && created.id;
    if (!jobId) throw new Error('桥接服务没有返回任务 id');

    try {
      await request('PUT', '/api/jobs/' + jobId + '/result', buffer, 'image/png', HTTP_UPLOAD_TIMEOUT_MS);
    } catch (err) {
      throw new Error('图片上传失败：' + errMsg(err));
    }

    log('已发到 Figma：' + shortName(doc.docName || '图片') + '（' +
      (imageWidth || '?') + '×' + (imageHeight || '?') + '，' +
      Math.round(buffer.length / 1024) + ' KB）· 会在 Figma 选中图层上方新建');
    setStatus('已发到 Figma · 会在选中图层上方新建');
    confirmApplied(jobId, 'Figma 已新建图层').catch(function () {});
    return true;
  } finally {
    try {
      if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
    } catch (_) {
      /* 删除失败不影响主流程 */
    }
  }
}

// 回传后等 Figma 贴回的确认窗口与轮询间隔
const APPLY_CONFIRM_MS = 14000;
const APPLY_CONFIRM_POLL_MS = 2000;

/**
 * 回传后确认 Figma 端有没有真的贴回（桥接端收到 ack 后 status 才变 done）。
 * 只写日志、不改会话状态：确认不了也不影响回传本身。
 */
async function confirmApplied(jobId, doneText) {
  const deadline = Date.now() + APPLY_CONFIRM_MS;
  while (Date.now() < deadline) {
    await new Promise(function (resolve) { setTimeout(resolve, APPLY_CONFIRM_POLL_MS); });
    let job = null;
    try {
      job = await getJson('/api/jobs/' + jobId);
    } catch (err) {
      if (isHttp404(err)) {
        log('任务 #' + jobId + ' 在桥接服务上已不存在，无法确认是否贴回（若同时开了多个桥接窗口，请只保留一个）', true);
        return;
      }
      continue;
    }
    if (!job) continue;
    if (job.status === 'done') {
      log('任务 #' + jobId + '：' + (doneText || 'Figma 已贴回原图层'));
      return;
    }
    if (job.status === 'failed') {
      log('任务 #' + jobId + '：Figma 端标记为失败，未贴回', true);
      return;
    }
  }
  log('任务 #' + jobId + '：已传到服务端，但 Figma 端还没贴回。' +
    '请确认 Figma 桌面版里「PS 桥接」面板是开着的（关掉重开也会自动接上）；' +
    '也可能是这个任务在 Figma 里被「停止」过 —— 那样只需在 Figma 点一次「继续等待」', true);
}

// 「保存并回传」= 当前活动文档
async function saveActive() {
  if (!running || saving || sendingAll) return;

  saving = true;
  refresh();
  let target = null;
  try {
    // 先确认是哪份文档、哪个任务，再导出；全程只认活动文档
    const info = await withHost(async function () {
      const doc = await hostActiveDoc();
      const jobId = await hostReadMarkerActive();
      return { doc: doc, jobId: jobId };
    });
    activeDoc = info.doc;

    if (!info.jobId) {
      // 不是从 Figma 发来的：PS 自己打开了一张图 → 发到 Figma 新建一个图层
      setStatus('发到 Figma「' + shortName(info.doc.docName || '当前文档') + '」…');
      await sendAsInsert(info.doc);
      return;
    }

    target = await ensureSession(info.jobId, info.doc.docId, info.doc.docName);
    setStatus('保存并回传「' + shortName(target.docName || target.jobId) + '」…');
    await sendSession(target);
    setStatus('已回传「' + shortName(target.docName || target.jobId) + '」 · 改完可再传');
  } catch (err) {
    const message = errMsg(err);
    if (target) target.lastError = message;
    log('回传失败：' + message, true);
    setStatus('回传失败：' + message);
  } finally {
    saving = false;
    refresh();
  }
}

async function sendOneSession(session) {
  if (saving || sendingAll) return;
  saving = true;
  refresh();
  try {
    setStatus('保存并回传「' + shortName(session.docName || session.jobId) + '」…');
    await sendSession(session);
    setStatus('已回传「' + shortName(session.docName || session.jobId) + '」 · 改完可再传');
  } catch (err) {
    session.lastError = errMsg(err);
    log('「' + (session.docName || session.jobId) + '」回传失败：' + session.lastError, true);
    setStatus('回传失败：' + session.lastError);
  } finally {
    saving = false;
    refresh();
  }
}

// 全部回传：遍历 state=open 且有 docId 的 session，单个失败不中断
async function sendAllSessions() {
  if (saving || sendingAll) return;

  const targets = openTargets().slice();
  if (!targets.length) {
    log('当前没有待回传的文档');
    setStatus('没有待回传的文档');
    return;
  }

  sendingAll = true;
  refresh();
  let ok = 0;
  let failed = 0;
  log('开始全部回传：共 ' + targets.length + ' 个文档');

  try {
    for (let i = 0; i < targets.length; i++) {
      const session = targets[i];
      setStatus('全部回传 ' + (i + 1) + '/' + targets.length + '：「' + shortName(session.docName || session.jobId) + '」…');
      try {
        await sendSession(session);
        ok += 1;
      } catch (err) {
        failed += 1;
        session.lastError = errMsg(err);
        log('「' + (session.docName || session.jobId) + '」回传失败：' + session.lastError, true);
      }
      refresh();
    }
  } finally {
    sendingAll = false;
    refresh();
  }

  log('全部回传完成：成功 ' + ok + ' / 失败 ' + failed, failed > 0);
  setStatus('全部回传：成功 ' + ok + ' / 失败 ' + failed);
}

/* ------------------------------ 取消 ------------------------------ */

// 取消只停止追踪 + 通知桥接失败，不动 PS 里已经打开的文档
async function cancelSession(session) {
  if (!session || saving || sendingAll) return;

  const wasSent = session.state === 'sent';
  ignored.add(session.jobId);
  persistIgnored();

  session.state = 'closed';
  session.lastError = '已在面板取消';

  if (!wasSent) {
    try {
      await postJson('/api/jobs/' + session.jobId + '/fail', { error: '已在 PS 面板取消' });
    } catch (_) {
      /* 桥接连不上也照样本地取消 */
    }
  }

  log('已取消任务 #' + session.jobId + '（「' + (session.docName || '') + '」文档保持打开）；' +
    '之后重新对这份文档点「保存并回传」即可恢复');
  setStatus('已取消任务 #' + session.jobId);
  refresh();
}

/* ------------------------------ 主循环 ------------------------------ */

function syncJobMeta(jobs) {
  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    const session = sessions.get(job.id);
    if (!session) continue;
    if (job.meta) session.meta = job.meta;
    if (job.status === 'failed' && job.error) session.lastError = job.error;
  }
}

async function pollOnce() {
  await sendHeartbeat();
  const jobs = await fetchJobs();
  syncJobMeta(jobs);

  if (!autoReceive) {
    if (!sessions.size) setStatus('已连接 · 自动接收已关闭，可点「立即接收一张」');
    refresh();
    return;
  }

  // 正在保存/全部回传时先别开新文档，免得把活动文档切走、让用户以为点错了
  if (!openingJobId && !saving && !sendingAll) {
    const job = pickPendingJob(jobs);
    if (job) {
      beginOpen(job);
      return;
    }
  }
  if (!sessions.size) setStatus('已连接 · 等待 Figma 发送');
  refresh();
}

async function loop() {
  if (!running) return;
  try {
    await pollOnce();
  } catch (err) {
    await handleConnectionError(err);
  }
  setTimeout(loop, POLL_MS);
}

async function handleConnectionError(err) {
  setStatus('正在查找桥接服务…');
  const found = await detectServer();
  if (!found) {
    setStatus('桥接服务未连接，请先双击「启动桥接.bat」');
    logThrottled('连接桥接服务失败：' + errMsg(err) + '。请先双击「启动桥接.bat」', true);
  } else if (!sessions.size) {
    setStatus('已连接 · 等待 Figma 发送');
  }
}

// 桥接服务会自动避开被占用的端口（比如 8765 被代理软件占了），这里逐个试
let detecting = false;
async function detectServer() {
  if (detecting) return false;
  detecting = true;
  try {
    const tried = {};
    const bases = [serverUrl].concat(
      PORT_CANDIDATES.map(function (p) { return 'http://127.0.0.1:' + p; })
    );

    for (let i = 0; i < bases.length; i++) {
      const base = bases[i];
      if (tried[base]) continue;
      tried[base] = true;

      const previous = serverUrl;
      serverUrl = base;
      try {
        const health = await getJson('/api/health');
        // 本机 8765 常被 Clash/mihomo 等代理占用：HTTP 通 ≠ 桥接服务。
        // 只采纳桥接 health 的明确响应：ok === true，且带非空 version 字段。
        if (!health || health.ok !== true) {
          throw new Error('health 响应不是 Figma 桥接服务');
        }
        if (typeof health.version !== 'string' || !health.version) {
          throw new Error('health 缺少 version 字段');
        }
        if (base !== previous) {
          el.server.value = base;
          writeSetting(SERVER_SETTING_KEY, base);
          log('已连接到桥接服务 ' + base + '（版本 ' + health.version + '）');
        }
        return true;
      } catch (_) {
        serverUrl = previous;
      }
    }
    return false;
  } finally {
    detecting = false;
  }
}

/* ------------------------------ 临时文件清理 ------------------------------ */

// 启动时清理 %TEMP% 下 figma-*.png 里创建超过 1 天的文件（崩溃/强杀留下的孤儿）
function cleanupTempFiles() {
  if (!fs || !os || !path) return;
  let removed = 0;
  try {
    const dir = os.tmpdir();
    const names = fs.readdirSync(dir);
    const now = Date.now();
    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      if (!/^figma-.+-.+\.png$/i.test(name)) continue;
      const full = path.join(dir, name);
      try {
        const stat = fs.statSync(full);
        if (!stat.isFile()) continue;
        if (now - stat.mtimeMs > TEMP_MAX_AGE_MS) {
          fs.unlinkSync(full);
          removed += 1;
        }
      } catch (_) {
        /* 单个文件失败忽略 */
      }
    }
    if (removed) log('已清理 ' + removed + ' 个超过 1 天的 figma 临时文件');
  } catch (err) {
    log('清理临时文件失败：' + errMsg(err), true);
  }
}

/* ------------------------------ 交互 ------------------------------ */

function runSafely(fn, label) {
  Promise.resolve()
    .then(fn)
    .catch(function (err) {
      log(label + '失败：' + errMsg(err), true);
    });
}

serverUrl = readSetting(SERVER_SETTING_KEY) || DEFAULT_SERVER;
autoReceive = readSetting(AUTO_SETTING_KEY) !== '0';
el.server.value = serverUrl;
el.auto.checked = autoReceive;
refresh();

el.server.addEventListener('change', function () {
  const value = (el.server.value || '').trim().replace(/\/+$/, '');
  serverUrl = value || DEFAULT_SERVER;
  // 换地址后旧桥提示先清掉，下一次心跳会重新判断
  legacyWarned = false;
  legacyBridge = false;
  statusPrefix = '';
  writeSetting(SERVER_SETTING_KEY, serverUrl);
  log('服务地址改为 ' + serverUrl);
});

el.auto.addEventListener('change', function () {
  autoReceive = el.auto.checked;
  writeSetting(AUTO_SETTING_KEY, autoReceive ? '1' : '0');
  setStatus(autoReceive ? '自动接收已开启' : '自动接收已关闭，可用「立即接收一张」');
});

el.save.addEventListener('click', function () {
  runSafely(saveActive, '保存并回传');
});

el.sendAll.addEventListener('click', function () {
  runSafely(sendAllSessions, '全部回传');
});

el.pull.addEventListener('click', function () {
  runSafely(async function () {
    if (openingJobId) return;
    const jobs = await fetchJobs();
    syncJobMeta(jobs);
    const job = pickPendingJob(jobs);
    if (!job) {
      log('Figma 那边还没有待打开的任务');
      return;
    }
    beginOpen(job);
  }, '立即接收');
});

if (!fs) {
  setStatus('Node 未启用，面板无法工作');
  log('Node 模块加载失败：' + ((window.__nodeError && window.__nodeError.message) || '未知错误'), true);
} else {
  cleanupTempFiles();
  log('面板已加载，服务地址 ' + serverUrl);
  detectServer()
    .then(function (found) {
      if (found) {
        setStatus('已连接 · 等待 Figma 发送');
        return restoreTick();
      }
      setStatus('桥接服务未连接，请先双击「启动桥接.bat」');
      return null;
    })
    .catch(function (err) {
      log('初始化连接失败：' + errMsg(err), true);
      setStatus('正在查找桥接服务…');
      return null;
    })
    .then(function () {
      // 主循环 2s：心跳 + 拉任务 + 每轮最多开 1 个文档
      loop();
      // 每 3s 扫描已打开的文档，登记/刷新 session，关掉的置 closed
      setInterval(restoreTick, RESTORE_MS);
      // 每 2s 检查一次谁该续租了（每个 open session 每 20s 一次）
      setInterval(touchTick, TOUCH_CHECK_MS);
    });
}
