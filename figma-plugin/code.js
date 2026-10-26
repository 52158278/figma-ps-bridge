'use strict';

/**
 * Figma 插件主线程
 * - 多选：一次把选中的全部图层打包发给 PS（send-payloads {items}）
 * - 注册表：clientStorage 里的 jobs（version 2），关掉插件/重开 Figma 后还记得所有任务
 * - 回写：apply-result 必须带 jobId，串行执行，完成后回 apply-done 由 UI 决定是否 ack
 */

figma.showUI(__html__, { width: 320, height: 560, themeColors: true });

const MAX_EXPORT_SCALE = 4;
// 没有图片填充时退回渲染导出：长边最多 4096px，避免大画框导出上万的图
const EXPORT_LONGEST = 4096;
const JOBS_KEY = 'jobs';
const LEGACY_KEY = 'pendingJob';
const REGISTRY_VERSION = 2;
const JOB_STATES = ['watching', 'done', 'failed', 'expired'];
// 契约 4.5 允许 appendChild 的容器；COMPONENT_SET / BOOLEAN_OPERATION / INSTANCE 等一律降级到页面
const CONTAINER_TYPES = ['PAGE', 'FRAME', 'GROUP', 'SECTION'];

let applyChain = Promise.resolve();

figma.ui.onmessage = async (msg) => {
  try {
    if (!msg || !msg.type) return;
    switch (msg.type) {
      case 'send-request':
        return await handleSendRequest();
      case 'apply-result':
        // 串行执行：多个 job 同时回传时按顺序写画布，避免 fills 互相覆盖
        return enqueueApply(() => runApplyResult(msg));
      case 'request-selection':
        return pushSelection();
      case 'find-target':
        return await locateTarget(msg.targetId);
      case 'load-jobs':
        return await loadJobs();
      case 'save-jobs':
        return await saveJobs(msg.value);
      case 'thumb-request':
        return await sendThumbnail(msg.jobId, msg.targetId);
      case 'ui-resize':
        return resizeUi(!!msg.minimized);
      default:
        return;
    }
  } catch (err) {
    const text = errorText(err);
    figma.notify('出错了：' + text, { error: true, timeout: 6000 });
    figma.ui.postMessage({ type: 'diag', message: text });
  }
};

function errorText(err) {
  return String(err && err.message ? err.message : err);
}

// 最小化：缩成一条不挡画布的小横条；监听在 iframe 里照常跑
function resizeUi(minimized) {
  try {
    if (minimized) figma.ui.resize(240, 46);
    else figma.ui.resize(320, 560);
  } catch (err) { /* 老宿主不支持 resize 时忽略 */ }
}

// ---------------- 注册表（clientStorage key = jobs） ----------------

function fileKeyOrNull() {
  try {
    return typeof figma.fileKey === 'string' && figma.fileKey ? figma.fileKey : null;
  } catch (err) {
    return null;
  }
}

function emptyRegistry() {
  return { version: REGISTRY_VERSION, fileKey: fileKeyOrNull(), jobs: [] };
}

function normalizeEntry(raw) {
  if (!raw || !raw.jobId) return null;
  const state = JOB_STATES.indexOf(raw.state) >= 0 ? raw.state : 'watching';
  return {
    jobId: String(raw.jobId),
    meta: raw.meta && typeof raw.meta === 'object' ? raw.meta : {},
    at: Number(raw.at) || 0,
    appliedAt: Number(raw.appliedAt) || 0,
    state: state
  };
}

function normalizeRegistry(value) {
  const base = emptyRegistry();
  if (!value || typeof value !== 'object' || !Array.isArray(value.jobs)) return base;
  const jobs = [];
  const seen = {};
  for (const raw of value.jobs) {
    const entry = normalizeEntry(raw);
    if (!entry || seen[entry.jobId]) continue;
    seen[entry.jobId] = true;
    jobs.push(entry);
  }
  const fileKey = typeof value.fileKey === 'string' && value.fileKey ? value.fileKey : base.fileKey;
  return { version: REGISTRY_VERSION, fileKey: fileKey, jobs: jobs };
}

async function writeRegistry(value) {
  const normalized = normalizeRegistry(value);
  try {
    await figma.clientStorage.setAsync(JOBS_KEY, normalized);
  } catch (err) {
    // 存不进去不影响本次流程，只是下次要手动重来
  }
  return normalized;
}

/** 读注册表；只有旧版单槽 pendingJob 时自动迁移成单元素 jobs */
async function readRegistry() {
  let stored = null;
  try {
    stored = await figma.clientStorage.getAsync(JOBS_KEY);
  } catch (err) {
    stored = null;
  }
  if (stored && typeof stored === 'object' && Array.isArray(stored.jobs)) {
    return normalizeRegistry(stored);
  }

  let legacy = null;
  try {
    legacy = await figma.clientStorage.getAsync(LEGACY_KEY);
  } catch (err) {
    legacy = null;
  }
  if (legacy && legacy.jobId) {
    const normalized = normalizeRegistry({
      version: REGISTRY_VERSION,
      fileKey: fileKeyOrNull(),
      jobs: [
        {
          jobId: String(legacy.jobId),
          meta: legacy.meta && typeof legacy.meta === 'object' ? legacy.meta : {},
          at: Number(legacy.at) || Date.now(),
          appliedAt: Number(legacy.appliedAt) || 0,
          state: 'watching'
        }
      ]
    });
    try {
      await figma.clientStorage.setAsync(JOBS_KEY, normalized);
      // 确认新 key 写成功后再删旧的，写失败就留到下次启动再迁移
      await figma.clientStorage.deleteAsync(LEGACY_KEY);
    } catch (err) {
      // 迁移失败不影响本次使用：jobs 为空时下次还会再试
    }
    return normalized;
  }

  return emptyRegistry();
}

async function loadJobs() {
  const value = await readRegistry();
  const currentFile = fileKeyOrNull();
  // 注册表是插件级的（所有文件共用）：换了文件就提示一下，别让旧任务悄悄贴错地方
  if (value.fileKey && currentFile && value.fileKey !== currentFile) {
    figma.ui.postMessage({
      type: 'diag',
      message: '这些任务记录来自另一个 Figma 文件，原图层可能对不上'
    });
  }
  figma.ui.postMessage({ type: 'jobs', value: value });
}

async function saveJobs(value) {
  const saved = await writeRegistry(value);
  figma.ui.postMessage({ type: 'jobs', value: saved });
}

// ---------------- 页面/定位工具 ----------------

/** 向上找到节点所在的页面 */
function pageOf(node) {
  let cur = node;
  while (cur && cur.type !== 'PAGE') {
    cur = 'parent' in cur ? cur.parent : null;
  }
  return cur && cur.type === 'PAGE' ? cur : null;
}

/** 切到所在页面、选中、缩放到能看见 */
async function ensureVisible(node) {
  const page = pageOf(node);
  if (page && page.id !== figma.currentPage.id) {
    await figma.setCurrentPageAsync(page);
  }
  figma.currentPage.selection = [node];
  figma.viewport.scrollAndZoomIntoView([node]);
}

/** 「认出原图层」：按保存的 nodeId 找回节点，不依赖当前选中 */
async function locateTarget(nodeId) {
  if (!nodeId) {
    figma.ui.postMessage({ type: 'target-missing', targetId: '', reason: '还没记录过原图层' });
    return;
  }
  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) {
    figma.ui.postMessage({ type: 'target-missing', targetId: nodeId, reason: '原图层已不存在' });
    return;
  }
  await ensureVisible(node);
  figma.ui.postMessage({ type: 'target-found', targetId: nodeId, name: node.name });
}

// 给「没有缩略图」的老任务补一张：按目标节点重新渲染一张小的 PNG。
// 找不到节点（已被删）或渲染失败时也回一条，避免 UI 反复重试。
async function sendThumbnail(jobId, targetId) {
  if (!jobId) return;
  const reply = (data) => figma.ui.postMessage({ type: 'thumb-result', jobId, data: data || '' });
  if (!targetId) {
    reply('');
    return;
  }
  try {
    const node = await figma.getNodeByIdAsync(targetId);
    if (!node || typeof node.exportAsync !== 'function') {
      reply('');
      return;
    }
    const width = Number(node.width) || 0;
    const height = Number(node.height) || 0;
    const longest = Math.max(width, height, 1);
    // 目标边长 68px（UI 里显示 34px @2x）；小图不放大，最多 1 倍
    const scale = Math.min(1, 68 / longest);
    const bytes = await node.exportAsync({
      format: 'PNG',
      constraint: { type: 'SCALE', value: Math.max(0.01, scale) }
    });
    reply(figma.base64Encode(bytes));
  } catch (err) {
    reply('');
  }
}

function bootInfo() {
  try {
    const page = figma.currentPage;
    const sel = page.selection;
    figma.ui.postMessage({
      type: 'boot',
      page: page.name,
      count: sel.length,
      name: sel.length ? sel[0].name : '',
      total: page.children.length
    });
  } catch (err) {
    figma.ui.postMessage({
      type: 'diag',
      message: '启动检测失败：' + errorText(err)
    });
  }
}

function pushSelection() {
  try {
    const sel = figma.currentPage.selection;
    figma.ui.postMessage({
      type: 'selection',
      count: sel.length,
      name: sel.length ? sel[0].name : ''
    });
  } catch (err) {
    figma.ui.postMessage({
      type: 'diag',
      message: '读取选中失败：' + errorText(err)
    });
  }
}

figma.on('selectionchange', pushSelection);
bootInfo();
setTimeout(bootInfo, 400);
setTimeout(bootInfo, 1500);
pushSelection();

// ---------------- 发送：多选批量 ----------------

/** 在节点自身及最多 3 层子级里找图片填充（取最上层的那一个） */
function findImagePaint(node, depth = 0) {
  if (node && 'fills' in node && Array.isArray(node.fills)) {
    for (let i = node.fills.length - 1; i >= 0; i--) {
      const f = node.fills[i];
      if (f.type === 'IMAGE' && f.visible !== false) return { paint: f, owner: node, index: i };
    }
  }
  if (depth < 3 && node && 'children' in node) {
    for (const child of node.children) {
      const found = findImagePaint(child, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** 单个节点 → {meta, data}：有原图用原图字节，否则按倍率渲染导出 */
async function buildPayload(node, found) {
  if (found) {
    const image = figma.getImageByHash(found.paint.imageHash);
    if (!image) throw new Error('图片原始数据不可用（可能来自团队库或已失效）');
    const bytes = await image.getBytesAsync();
    if (!bytes || !bytes.length) throw new Error('读取原图失败');
    const size = await image.getSizeAsync();
    return {
      meta: {
        targetId: found.owner.id,
        targetName: found.owner.name,
        nodeName: node.name,
        nodeWidth: Math.round(found.owner.width),
        nodeHeight: Math.round(found.owner.height),
        imageWidth: size.width,
        imageHeight: size.height,
        paintIndex: found.index,
        mode: 'origin',
        fallback: false
      },
      data: figma.base64Encode(bytes)
    };
  }

  const longest = Math.max(node.width, node.height, 1);
  // 旧公式 min(4, max(2, ceil(4096/longest))) 对 3000px 画框会导出 6000px、5000px 会导出 10000px；
  // 改成 clamp(1, 4, 4096/longest)：长边尽量不超过 4096，也不低于 1 倍。
  // 倍率向下取整到 2 位小数，避免四舍五入又把长边顶过 4096
  const rawScale = Math.min(MAX_EXPORT_SCALE, Math.max(1, EXPORT_LONGEST / longest));
  const scale = Math.floor(rawScale * 100) / 100;
  const bytes = await node.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: scale } });
  return {
    meta: {
      targetId: node.id,
      targetName: node.name,
      nodeName: node.name,
      nodeWidth: Math.round(node.width),
      nodeHeight: Math.round(node.height),
      imageWidth: Math.round(node.width * scale),
      imageHeight: Math.round(node.height * scale),
      mode: 'render',
      fallback: true,
      exportScale: scale
    },
    data: figma.base64Encode(bytes)
  };
}

/** 遍历选中全部节点；已在处理中的 targetId 跳过；单节点失败不影响其它节点 */
async function handleSendRequest() {
  const items = [];
  const problems = [];
  try {
    const sel = figma.currentPage.selection;
    if (!sel.length) throw new Error('请先在画布上选中图片或画框');

    const registry = await readRegistry();
    const busyTargets = {};
    for (const job of registry.jobs) {
      if (job.state === 'watching' && job.meta && job.meta.targetId) {
        busyTargets[job.meta.targetId] = true;
      }
    }

    for (const node of sel) {
      const found = findImagePaint(node);
      const targetId = found ? found.owner.id : node.id;
      const displayName = found ? found.owner.name : node.name;
      if (busyTargets[targetId]) {
        problems.push('「' + displayName + '」已在处理中，已跳过');
        continue;
      }
      try {
        const payload = await buildPayload(node, found);
        items.push(payload);
        // 同一次选中里若父子都被选中，后一个也要跳过
        busyTargets[payload.meta.targetId] = true;
      } catch (err) {
        problems.push('「' + displayName + '」读取失败：' + errorText(err));
      }
    }
  } catch (err) {
    problems.push(errorText(err));
  }

  // 无论有没有内容都回一次，UI 靠它解除「发送中」的忙状态
  figma.ui.postMessage({ type: 'send-payloads', items: items });
  if (problems.length) {
    figma.ui.postMessage({
      type: 'diag',
      message:
        problems.length === 1
          ? problems[0]
          : '有 ' + problems.length + ' 个节点没发出去：' + problems.join('；')
    });
  }
}

// ---------------- 回写（串行 + apply-done 回执） ----------------

function enqueueApply(task) {
  const run = applyChain.then(task, task);
  applyChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

async function runApplyResult(msg) {
  const jobId = msg && msg.jobId ? String(msg.jobId) : '';
  try {
    if (!jobId) throw new Error('任务已失效');
    const registry = await readRegistry();
    if (!registry.jobs.some((job) => job.jobId === jobId)) {
      throw new Error('任务已失效');
    }
    await applyResult(msg);
    figma.ui.postMessage({ type: 'apply-done', jobId: jobId, ok: true });
  } catch (err) {
    const text = errorText(err);
    figma.ui.postMessage({ type: 'apply-done', jobId: jobId, ok: false, error: text });
    figma.notify('回写失败：' + text, { error: true, timeout: 6000 });
  }
}

async function applyResult(msg) {
  const meta = msg && msg.meta ? msg.meta : {};
  const data = msg && msg.data;
  if (!data) throw new Error('回传数据为空');

  const image = figma.createImage(figma.base64Decode(data));
  const target = meta.targetId ? await figma.getNodeByIdAsync(meta.targetId) : null;

  if (!meta.fallback && target && 'fills' in target && Array.isArray(target.fills)) {
    const fills = target.fills.slice();
    let index = typeof meta.paintIndex === 'number' ? meta.paintIndex : -1;
    if (index < 0 || !fills[index] || fills[index].type !== 'IMAGE') {
      index = fills.findIndex((f) => f.type === 'IMAGE');
    }
    if (index >= 0) {
      // 发出去的是完整原图：尺寸没变（PS 里只调色/修图）就保留原填充的 scaleMode 与
      // imageTransform，画布上的裁切/位置完全不变；尺寸变了（PS 里裁过图）说明新旧图
      // 坐标系对不上，改用 FILL + 单位矩阵，保证不出现错位或空白边
      const size = await image.getSizeAsync();
      const sameSize =
        Math.abs(size.width - (meta.imageWidth || 0)) <= 1 &&
        Math.abs(size.height - (meta.imageHeight || 0)) <= 1;
      fills[index] = sameSize
        ? { ...fills[index], imageHash: image.hash, visible: true }
        : {
            ...fills[index],
            type: 'IMAGE',
            scaleMode: 'FILL',
            imageTransform: [[1, 0, 0], [0, 1, 0]],
            imageHash: image.hash,
            visible: true
          };
    } else {
      fills.push({
        type: 'IMAGE',
        scaleMode: 'FILL',
        imageTransform: [[1, 0, 0], [0, 1, 0]],
        imageHash: image.hash
      });
    }
    target.fills = fills;
    if (msg.reveal) {
      // 定位只是顺手看看，失败（比如实例内部节点不能选中）不影响回写成功
      try {
        await ensureVisible(target);
      } catch (err) {
        // 忽略
      }
    }
    figma.notify('已回写高清图到「' + target.name + '」', { timeout: 4000 });
    return;
  }

  await createFallbackLayer(msg, meta, image, target);
}

/** 目标装不了填充：在目标所在页面新建一个矩形，位置用页面绝对坐标 */
async function createFallbackLayer(msg, meta, image, target) {
  // 1) 先切到目标所在页面：createRectangle 会落在当前页，不切页新图层就跑到别的页面去了
  if (target) {
    const page = pageOf(target);
    if (page && page.id !== figma.currentPage.id) {
      await figma.setCurrentPageAsync(page);
    }
  }

  const rect = figma.createRectangle();
  rect.name = (meta.targetName || 'PS 结果') + ' (PS)';
  rect.resize(Math.max(1, Math.round(meta.nodeWidth || 400)), Math.max(1, Math.round(meta.nodeHeight || 400)));
  rect.fills = [{ type: 'IMAGE', scaleMode: 'FILL', imageHash: image.hash }];

  // 2) 位置用 target.absoluteBoundingBox（页面绝对坐标），不用父级相对的 target.x/y；
  //    父级可能是带偏移的 FRAME，所以再换算成容器内坐标
  const box = target && target.absoluteBoundingBox ? target.absoluteBoundingBox : null;
  const container = containerFor(target);
  try {
    container.node.appendChild(rect);
  } catch (err) {
    // 容器拒绝接收（锁定/只读/特殊容器）：清掉刚建的空图层，把错误交给 apply-done，
    // UI 侧只做有限次重试，不会无限退避
    try {
      rect.remove();
    } catch (removeErr) {
      // 删不掉也不影响主流程
    }
    throw new Error('新建图层失败（容器 ' + container.node.type + '）：' + errorText(err));
  }
  if ('layoutMode' in container.node && container.node.layoutMode && container.node.layoutMode !== 'NONE') {
    // auto-layout 容器里的子级必须绝对定位才能自己填 x/y
    try {
      rect.layoutPositioning = 'ABSOLUTE';
    } catch (err) {
      // 老版本 API 没有这个属性，忽略
    }
  }
  if (box) {
    rect.x = box.x - container.originX + box.width + 40;
    rect.y = box.y - container.originY;
  } else {
    const center = figma.viewport.center;
    rect.x = center.x - container.originX;
    rect.y = center.y - container.originY;
  }

  figma.currentPage.selection = [rect];
  figma.viewport.scrollAndZoomIntoView([rect]);
  // 告诉面板这张新图层的 id：以后再回传就直接覆盖它，不会一层层堆
  figma.ui.postMessage({
    type: 'fallback-created',
    jobId: msg.jobId || '',
    targetId: rect.id,
    name: rect.name
  });
  figma.notify('原节点不是图片填充，已生成新图层', { timeout: 5000 });
}

/** 新建图层放到哪个容器，以及该容器的页面原点（用于把绝对坐标换算成容器内坐标） */
function containerFor(target) {
  const parent = target && 'parent' in target ? target.parent : null;
  if (parent && CONTAINER_TYPES.indexOf(parent.type) >= 0) {
    if (parent.type === 'PAGE') return { node: parent, originX: 0, originY: 0 };
    const box = parent.absoluteBoundingBox;
    return { node: parent, originX: box ? box.x : 0, originY: box ? box.y : 0 };
  }
  // 父级超出契约范围（COMPONENT_SET / BOOLEAN_OPERATION / INSTANCE / 已删除）→
  // 降级追加到「目标所在页面」，页面坐标系原点就是 0,0，位置继续用 absoluteBoundingBox
  const page = (target && pageOf(target)) || figma.currentPage;
  return { node: page, originX: 0, originY: 0 };
}
