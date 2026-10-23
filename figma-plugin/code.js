'use strict';

/**
 * Figma 插件主线程
 * - 从选中节点拿到「原始图片字节」（imageHash -> getBytesAsync），不受画布缩放影响
 * - 没有图片填充的节点，退回按 2~4 倍渲染导出
 * - 收到 PS 回传的结果后写回同一个节点的填充
 */

figma.showUI(__html__, { width: 300, height: 300, themeColors: true });

const MAX_EXPORT_SCALE = 4;

figma.ui.onmessage = async (msg) => {
  try {
    if (!msg || !msg.type) return;
    if (msg.type === 'send-request') return await handleSendRequest();
    if (msg.type === 'apply-result') return await applyResult(msg);
    if (msg.type === 'request-selection') return pushSelection();
    if (msg.type === 'notify') return figma.notify(msg.text, { timeout: 4000, error: !!msg.error });
  } catch (err) {
    const text = String(err && err.message ? err.message : err);
    figma.notify('出错了：' + text, { error: true, timeout: 6000 });
    figma.ui.postMessage({ type: 'diag', message: text });
  }
};

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
      message: '启动检测失败：' + String(err && err.message ? err.message : err)
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
      message: '读取选中失败：' + String(err && err.message ? err.message : err)
    });
  }
}

figma.on('selectionchange', pushSelection);
bootInfo();
setTimeout(bootInfo, 400);
setTimeout(bootInfo, 1500);
pushSelection();

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

async function handleSendRequest() {
  const sel = figma.currentPage.selection;
  if (!sel.length) throw new Error('请先在画布上选中一张图片或画框');

  const node = sel[0];
  const found = findImagePaint(node);
  let bytes;
  let meta;

  if (found) {
    const image = figma.getImageByHash(found.paint.imageHash);
    if (!image) throw new Error('这张图片的原始数据不可用（可能来自团队库或已失效）');

    bytes = await image.getBytesAsync();
    if (!bytes || !bytes.length) throw new Error('读取原图失败');

    const size = await image.getSizeAsync();
    meta = {
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
    };
  } else {
    const longest = Math.max(node.width, node.height, 1);
    const scale = Math.min(MAX_EXPORT_SCALE, Math.max(2, Math.ceil(4096 / longest)));
    bytes = await node.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: scale } });
    meta = {
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
    };
  }

  figma.ui.postMessage({
    type: 'send-payload',
    meta,
    data: figma.base64Encode(bytes)
  });
}

async function applyResult(msg) {
  const { meta, data } = msg;
  if (!data) throw new Error('回传数据为空');

  const image = figma.createImage(figma.base64Decode(data));
  const target = await figma.getNodeByIdAsync(meta.targetId);

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
    figma.notify(`已回写高清图到「${target.name}」`, { timeout: 4000 });
    return;
  }

  // 非图片填充节点：把结果作为新图层放在原节点右侧
  const rect = figma.createRectangle();
  rect.name = `${meta.targetName || 'PS 结果'} (PS)`;
  rect.resize(meta.nodeWidth || 400, meta.nodeHeight || 400);
  rect.fills = [{ type: 'IMAGE', scaleMode: 'FILL', imageHash: image.hash }];

  if (target && 'x' in target && 'y' in target) {
    rect.x = target.x + target.width + 40;
    rect.y = target.y;
  } else {
    const c = figma.viewport.center;
    rect.x = c.x;
    rect.y = c.y;
  }

  figma.currentPage.selection = [rect];
  figma.viewport.scrollAndZoomIntoView([rect]);
  figma.notify('原节点不是图片填充，已生成新图层', { timeout: 5000 });
}
