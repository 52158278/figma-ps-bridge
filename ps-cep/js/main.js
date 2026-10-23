'use strict';

/**
 * Photoshop CEP 面板（Photoshop 2022+）
 * - 轮询本地桥接服务，拿到 Figma 发来的原图 → 写入临时文件 → 在 PS 中打开
 * - 用户编辑完点「保存并回传 Figma」→ 导出 PNG → PUT 回桥接 → Figma 插件替换填充
 *
 * 网络与文件全部走 Node（--enable-nodejs --mixed-context），
 * 打开/保存走 ExtendScript（host/index.jsx）。
 */

const POLL_MS = 2000;
const DEFAULT_SERVER = 'http://127.0.0.1:8765';
// 与 bridge/server.py、figma-plugin/ui.html 保持一致
const PORT_CANDIDATES = [8765, 8766, 8767, 8768, 8769, 8770, 8771, 8772, 8773, 8774];

const el = {
  status: document.getElementById('status'),
  server: document.getElementById('server'),
  auto: document.getElementById('auto'),
  save: document.getElementById('save'),
  pull: document.getElementById('pull'),
  cancel: document.getElementById('cancel'),
  jobName: document.getElementById('jobName'),
  jobMeta: document.getElementById('jobMeta'),
  log: document.getElementById('log')
};

let serverUrl = DEFAULT_SERVER;
let autoReceive = true;
let currentJob = null; // { id, meta, docName }
let busy = false;
let running = true;
let restoreBusy = false;
const ignoredMarkers = {}; // 已经处理过/已失败的任务，别反复提示

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

function api(p) {
  return serverUrl.replace(/\/+$/, '') + p;
}

function log(text, isError) {
  const now = new Date();
  const pad = (n) => ('0' + n).slice(-2);
  const line = document.createElement('div');
  line.className = isError ? 'err' : '';
  line.textContent = pad(now.getHours()) + ':' + pad(now.getMinutes()) + ':' + pad(now.getSeconds()) + '  ' + text;
  el.log.appendChild(line);
  el.log.scrollTop = el.log.scrollHeight;
}

function setStatus(text) {
  el.status.textContent = text;
}

function refresh() {
  if (!currentJob) {
    el.jobName.textContent = '暂无任务';
    el.jobMeta.textContent = '在 Figma 面板点「发送选中到 PS」';
  } else {
    const m = currentJob.meta || {};
    el.jobName.textContent = m.nodeName || m.targetName || '未命名任务';
    const parts = [];
    if (m.imageWidth) parts.push(m.imageWidth + '×' + m.imageHeight + ' px');
    if (m.nodeWidth) parts.push('画布 ' + m.nodeWidth + '×' + m.nodeHeight);
    if (m.mode === 'origin') parts.push('原图');
    else if (m.mode === 'render') parts.push('渲染导出');
    parts.push('#' + currentJob.id);
    el.jobMeta.textContent = parts.join(' · ');
  }
  el.save.disabled = busy || !currentJob;
  el.cancel.disabled = busy || !currentJob;
  el.pull.disabled = busy || !!currentJob;
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

function request(method, p, body, contentType) {
  return new Promise(function (resolve, reject) {
    const target = splitServer();
    if (!target) return reject(new Error('桥接地址无效'));

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
          const buf = Buffer.concat(chunks);
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error('HTTP ' + res.statusCode));
          }
          resolve(buf);
        });
      }
    );

    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function getJson(p) {
  const buf = await request('GET', p, null);
  return JSON.parse(buf.toString('utf8'));
}

async function postJson(p, payload) {
  const buf = await request('POST', p, Buffer.from(JSON.stringify(payload || {}), 'utf8'), 'application/json');
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch (_) {
    return {};
  }
}

/* ------------------------------ ExtendScript ------------------------------ */

// PS 弹模态框时 evalScript 会一直不回调，这里加超时避免轮询整体卡死
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
      resolve('ERR:' + ((err && err.message) || err));
    }
  });
}

function esStr(value) {
  return JSON.stringify(String(value));
}

function toEsPath(p) {
  return p.replace(/\\/g, '/');
}

/** 读 PSD 里的任务标记，返回 { jobId, docName } 或 null */
async function readMarker() {
  const res = await evalScript('figmaBridgeReadMarker()', 1500);
  if (res.indexOf('OK:') !== 0) return null;
  const body = res.slice(3);
  const idx = body.indexOf('|');
  if (idx <= 0) return null;
  return { jobId: body.slice(0, idx), docName: body.slice(idx + 1) };
}

async function openImage(filePath, jobId) {
  const res = await evalScript(
    'figmaBridgeOpenImage(' + esStr(toEsPath(filePath)) + ',' + esStr(jobId || '') + ')'
  );
  if (res.indexOf('OK:') !== 0) throw new Error(res.replace(/^ERR:/, '') || '打开图片失败');
  return res.slice(3);
}

async function savePngCopy(filePath, jobId, docName) {
  const res = await evalScript(
    'figmaBridgeSavePng(' + esStr(toEsPath(filePath)) + ',' + esStr(jobId || '') + ',' + esStr(docName || '') + ')'
  );
  if (res.indexOf('OK:') !== 0) throw new Error(res.replace(/^ERR:/, '') || '导出 PNG 失败');
  return res.slice(3);
}

/* ------------------------------ 任务流程 ------------------------------ */

async function failJob(message) {
  if (!currentJob) return;
  try {
    await postJson('/api/jobs/' + currentJob.id + '/fail', { error: message || 'PS 端失败' });
  } catch (_) {
    /* 网络已经不通时忽略 */
  }
}

async function receiveJob(job, sourceUrl) {
  busy = true;
  currentJob = { id: job.id, meta: job.meta || {}, docName: null };
  refresh();

  const m = currentJob.meta;
  log('收到任务 #' + job.id + '：' + (m.nodeName || '未命名') + ' ' + (m.imageWidth || '?') + '×' + (m.imageHeight || '?'));

  let tempPath = null;
  try {
    // PS 里已经开着这个任务的文档（比如 PSD 存过、面板重载过），别再下一遍原图盖掉编辑
    const marker = await readMarker();
    if (marker && marker.jobId === job.id) {
      currentJob.docName = marker.docName;
      log('PS 里已经开着任务 #' + job.id + ' 的「' + marker.docName + '」，直接接着用');
      setStatus('等待编辑');
      return;
    }

    setStatus('下载原图…');
    const buffer = await request('GET', sourceUrl, null);
    log('已下载 ' + Math.round(buffer.length / 1024) + ' KB');

    tempPath = path.join(os.tmpdir(), 'figma-' + job.id + '-' + Date.now() + '.png');
    fs.writeFileSync(tempPath, buffer);

    setStatus('在 Photoshop 中打开…');
    const docName = await openImage(tempPath, job.id);
    currentJob.docName = docName;

    log('已打开「' + docName + '」，编辑完点上面的按钮回传');
    setStatus('等待编辑');
  } catch (err) {
    log('接收失败：' + ((err && err.message) || err), true);
    setStatus('接收失败');
    await failJob((err && err.message) || String(err));
    currentJob = null;
  } finally {
    busy = false;
    refresh();
  }
}

async function saveAndSend() {
  if (!currentJob || busy) return;

  busy = true;
  refresh();

  let outPath = null;
  try {
    setStatus('导出 PNG…');
    outPath = path.join(os.tmpdir(), 'figma-' + currentJob.id + '-out-' + Date.now() + '.png');
    await savePngCopy(outPath, currentJob.id, currentJob.docName);

    const buffer = fs.readFileSync(outPath);
    if (!buffer || !buffer.length) throw new Error('导出的图片为空');

    setStatus('回传到 Figma…');
    await request('PUT', '/api/jobs/' + currentJob.id + '/result', buffer, 'image/png');

    log('已回传 ' + Math.round(buffer.length / 1024) + ' KB 到 Figma');
    setStatus('已回传 Figma');
    currentJob = null;
  } catch (err) {
    log('回传失败：' + ((err && err.message) || err), true);
    setStatus('回传失败');
  } finally {
    if (outPath) {
      try {
        fs.unlinkSync(outPath);
      } catch (_) {
        /* 删除失败不影响主流程 */
      }
    }
    busy = false;
    refresh();
  }
}

/* ------------------------------ 认出 PSD 里的任务 ------------------------------ */

// 面板重开、或用户自己打开存过的 PSD 时，从文档标记里认出原任务，挂上就能直接回传
async function restoreFromDocument() {
  if (!running || busy || currentJob || restoreBusy) return;
  restoreBusy = true;
  try {
    const marker = await readMarker();
    if (!marker || ignoredMarkers[marker.jobId]) return;

    let job;
    try {
      job = await getJson('/api/jobs/' + marker.jobId);
    } catch (err) {
      const msg = (err && err.message) || '';
      if (msg.indexOf('HTTP 404') === 0) {
        ignoredMarkers[marker.jobId] = true;
        log('文档「' + marker.docName + '」对应的任务 #' + marker.jobId + ' 已结束，需要重新从 Figma 发送', true);
      }
      return;
    }

    if (busy || currentJob) return;

    const status = job && job.status;
    if (status === 'pending' || status === 'editing') {
      currentJob = { id: marker.jobId, meta: job.meta || {}, docName: marker.docName };
      log('认出「' + marker.docName + '」是任务 #' + marker.jobId + '，可直接点「保存并回传 Figma」');
      setStatus('等待编辑');
      refresh();
      return;
    }

    // 已经回传过 / 已失败的任务，把标记忽略掉，别反复提示
    ignoredMarkers[marker.jobId] = true;
    if (status === 'failed') {
      log('任务 #' + marker.jobId + ' 已失败，需要重新从 Figma 发送', true);
    } else if (status === 'ready') {
      log('「' + marker.docName + '」的结果已在 Figma 那边等着贴；改完想再传，请在 Figma 重新发送一次');
    } else if (status === 'done') {
      log('「' + marker.docName + '」是任务 #' + marker.jobId + ' 的存档，这次已经回传完成；再改想传回 Figma，请在 Figma 重新发送一次');
    }
  } finally {
    restoreBusy = false;
  }
}

/* ------------------------------ 轮询 ------------------------------ */

// 桥接服务会自动避开被占用的端口（比如 8765 被代理软件占了），这里逐个试
async function detectServer() {
  const tried = {};
  const bases = [serverUrl].concat(
    PORT_CANDIDATES.map(function (p) { return 'http://127.0.0.1:' + p; })
  );

  for (const base of bases) {
    if (tried[base]) continue;
    tried[base] = true;

    const previous = serverUrl;
    serverUrl = base;
    try {
      await getJson('/api/health');
      if (base !== previous) {
        el.server.value = base;
        writeSetting('ps-bridge-server', base);
        log('已连接到桥接服务 ' + base);
      }
      return true;
    } catch (err) {
      serverUrl = previous;
    }
  }
  return false;
}

async function pollOnce() {
  // 自动接收关闭时只发心跳，避免把任务「抢」成 editing 却没人处理
  if (!autoReceive || busy || currentJob) {
    await getJson('/api/health');
    if (!busy && !currentJob) setStatus('已连接 · 等待 Figma 发送');
    return;
  }
  const data = await getJson('/api/ps/pending');
  if (data && data.job) {
    await receiveJob(data.job, data.sourceUrl);
  } else {
    setStatus('已连接 · 等待 Figma 发送');
  }
}

async function loop() {
  if (!running) return;
  try {
    await pollOnce();
  } catch (err) {
    if (!busy && !currentJob) {
      setStatus('正在查找桥接服务…');
      const found = await detectServer();
      if (!found && !busy && !currentJob) {
        setStatus('桥接服务未连接，请先双击「启动桥接.bat」');
      }
    }
  }
  setTimeout(loop, POLL_MS);
}

/* ------------------------------ 交互 ------------------------------ */

serverUrl = readSetting('ps-bridge-server') || DEFAULT_SERVER;
autoReceive = readSetting('ps-bridge-auto') !== '0';
el.server.value = serverUrl;
el.auto.checked = autoReceive;
refresh();

el.server.addEventListener('change', function () {
  const value = (el.server.value || '').trim().replace(/\/+$/, '');
  serverUrl = value || DEFAULT_SERVER;
  writeSetting('ps-bridge-server', serverUrl);
  log('服务地址改为 ' + serverUrl);
});

el.auto.addEventListener('change', function () {
  autoReceive = el.auto.checked;
  writeSetting('ps-bridge-auto', autoReceive ? '1' : '0');
  setStatus(autoReceive ? '自动接收已开启' : '自动接收已关闭，可用「立即接收一张」');
});

el.save.addEventListener('click', saveAndSend);

el.pull.addEventListener('click', async function () {
  if (busy || currentJob) return;
  try {
    const data = await getJson('/api/ps/pending');
    if (!data || !data.job) {
      log('Figma 那边还没有待处理的任务');
      return;
    }
    await receiveJob(data.job, data.sourceUrl);
  } catch (err) {
    log('连接桥接服务失败：' + ((err && err.message) || err), true);
    setStatus('桥接服务未连接');
  }
});

el.cancel.addEventListener('click', async function () {
  if (!currentJob || busy) return;
  const id = currentJob.id;
  await failJob('已在 PS 面板取消');
  currentJob = null;
  log('已取消任务 #' + id);
  setStatus('已取消');
  refresh();
});

if (!fs) {
  setStatus('Node 未启用，面板无法工作');
  log('Node 模块加载失败：' + ((window.__nodeError && window.__nodeError.message) || '未知错误'), true);
} else {
  log('面板已加载，服务地址 ' + serverUrl);
  detectServer()
    .then(function () { return restoreFromDocument(); })
    .then(loop);
  // 用户随时可能打开/切到存过的 PSD，定期看一眼文档标记
  setInterval(restoreFromDocument, 3000);
}
