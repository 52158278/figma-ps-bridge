// Figma 桥接 · ExtendScript 宿主脚本
// 契约：docs/multi-doc-spec.md 5.6
// - 每个入口都设置 app.displayDialogs = DialogModes.NO，finally 恢复，避免弹窗卡死面板
// - 返回值一律 'OK:' / 'ERR:' 前缀；多字段手写 ';' '|' 分隔，不依赖 JSON
// - 文档定位一律用 doc.id（docId），figmaBridgeSavePng 找不到就返回 ERR:NOT_FOUND，
//   绝不回退到 activeDocument
//
// 任务标记写在 DocumentInfo 的 JobName（XMP）里，随 PSD 一起保存：
// 用户把文件存成 PSD、关掉 PS，隔天重开还能认出是哪个 Figma 任务。

var FIGMA_BRIDGE_MARKER = 'figma-bridge:';

// 包一层：统一关弹窗 + 统一异常转 ERR:，并在 finally 恢复原来的弹窗策略。
function figmaBridgeRun(fn) {
    var previous = null;
    try {
        previous = app.displayDialogs;
        app.displayDialogs = DialogModes.NO;
    } catch (e) {
        previous = null;
    }
    try {
        return fn();
    } catch (e) {
        return 'ERR:' + e.message;
    } finally {
        if (previous !== null) {
            try {
                app.displayDialogs = previous;
            } catch (e2) {
                // 恢复失败不影响返回值
            }
        }
    }
}

// 名字里可能带 | 或 ;，会破坏手写序列化，统一替换成空格。
function figmaBridgeClean(value) {
    return String(value == null ? '' : value).replace(/[|;\r\n]/g, ' ');
}

// 读某个文档的 marker，返回 jobId（没有标记返回空字符串）。
function figmaBridgeMarkerOf(doc) {
    var value = '';
    try {
        value = String(doc.info.jobName || '');
    } catch (e) {
        value = '';
    }
    if (value.indexOf(FIGMA_BRIDGE_MARKER) !== 0) return '';
    return value.substring(FIGMA_BRIDGE_MARKER.length).replace(/[|;\s]/g, '');
}

// doc.width/height 可能是 UnitValue，统一转成像素整数；是普通数字就直接取整。
function figmaBridgePx(value) {
    try {
        return Math.round(value.as('px'));
    } catch (e) {
        try {
            return Math.round(value);
        } catch (e2) {
            return 0;
        }
    }
}

// 'OK:<docId>|<docName>'
function figmaBridgeOpenImage(path, jobId) {
    return figmaBridgeRun(function () {
        var f = new File(path);
        if (!f.exists) return 'ERR:文件不存在 ' + path;
        var doc = app.open(f);
        if (!doc) return 'ERR:打开图片失败';
        if (jobId) {
            try {
                doc.info.jobName = FIGMA_BRIDGE_MARKER + jobId;
            } catch (e) {
                // 少数格式不允许写 XMP，先打开成功；保存为 PSD 后标记可能丢失
            }
        }
        return 'OK:' + doc.id + '|' + figmaBridgeClean(doc.name);
    });
}

// 'OK:<docId>|<docName>' / 'ERR:<msg>'
function figmaBridgeActiveDoc() {
    return figmaBridgeRun(function () {
        if (app.documents.length === 0) return 'ERR:没有打开的文档';
        var doc = app.activeDocument;
        return 'OK:' + doc.id + '|' + figmaBridgeClean(doc.name);
    });
}

// 'OK:<docId>|<docName>|<jobId>;...'（没有 marker 的 jobId 为空串）
function figmaBridgeListDocs() {
    return figmaBridgeRun(function () {
        var parts = [];
        for (var i = 0; i < app.documents.length; i++) {
            var doc = app.documents[i];
            parts.push(doc.id + '|' + figmaBridgeClean(doc.name) + '|' + figmaBridgeMarkerOf(doc));
        }
        return 'OK:' + parts.join(';');
    });
}

// 只看当前活动文档：'OK:<jobId>' / 'OK:'（没有标记）/ 'ERR:<msg>'
function figmaBridgeReadMarkerActive() {
    return figmaBridgeRun(function () {
        if (app.documents.length === 0) return 'OK:';
        return 'OK:' + figmaBridgeMarkerOf(app.activeDocument);
    });
}

// 按 docId 精确定位文档导出 PNG：'OK:<w>x<h>' / 'ERR:NOT_FOUND' / 'ERR:<msg>'
// 禁止回退 activeDocument —— 多文档并行时那会导错文档。
function figmaBridgeSavePng(path, docId) {
    return figmaBridgeRun(function () {
        if (!docId) return 'ERR:NOT_FOUND';
        var target = String(docId);
        var doc = null;
        for (var i = 0; i < app.documents.length; i++) {
            if (String(app.documents[i].id) === target) {
                doc = app.documents[i];
                break;
            }
        }
        if (!doc) return 'ERR:NOT_FOUND';

        var f = new File(path);
        var opts = new PNGSaveOptions();
        opts.compression = 6;
        opts.interlaced = false;
        // asCopy = true：导出副本，不改变用户正在编辑的 PSD 文档本身
        doc.saveAs(f, opts, true, Extension.LOWERCASE);
        return 'OK:' + figmaBridgePx(doc.width) + 'x' + figmaBridgePx(doc.height);
    });
}
