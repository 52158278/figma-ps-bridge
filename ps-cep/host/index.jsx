// Figma 桥接 · ExtendScript 宿主脚本
// 负责：打开图片、在文档里写任务标记、读标记、导出 PNG 副本
//
// 标记写在 DocumentInfo 的 JobName（XMP）里，随 PSD 一起保存。
// 这样用户把文件存成 PSD、关掉 PS，下次再打开还能认出是哪个任务。

var FIGMA_BRIDGE_MARKER = 'figma-bridge:';

function figmaBridgeOpenImage(path, jobId) {
    try {
        var f = new File(path);
        if (!f.exists) return 'ERR:文件不存在 ' + path;
        var doc = app.open(f);
        if (!doc) return 'ERR:打开失败';
        if (jobId) {
            try {
                doc.info.jobName = FIGMA_BRIDGE_MARKER + jobId;
            } catch (e) {
                // 少数格式不允许写 XMP，忽略即可
            }
        }
        return 'OK:' + doc.name;
    } catch (e) {
        return 'ERR:' + e.message;
    }
}

// 返回 'OK:'（没有标记）、'OK:<jobId>|<文档名>' 或 'ERR:...'
// 优先看当前文档，其次扫一遍其它打开着的文档（用户可能在看别的文件）
function figmaBridgeReadMarker() {
    try {
        if (app.documents.length === 0) return 'OK:';

        var active = app.activeDocument;
        var hit = markerOf(active);
        if (hit) return hit;

        for (var i = 0; i < app.documents.length; i++) {
            var doc = app.documents[i];
            if (doc === active) continue;
            hit = markerOf(doc);
            if (hit) return hit;
        }
        return 'OK:';
    } catch (e) {
        return 'ERR:' + e.message;
    }
}

function markerOf(doc) {
    var value = '';
    try {
        value = String(doc.info.jobName || '');
    } catch (e) {
        value = '';
    }
    if (value.indexOf(FIGMA_BRIDGE_MARKER) !== 0) return null;
    return 'OK:' + value.substring(FIGMA_BRIDGE_MARKER.length) + '|' + doc.name;
}

// 优先按任务标记找文档，其次按文档名，最后退回当前文档
function figmaBridgeSavePng(path, jobId, docName) {
    try {
        if (app.documents.length === 0) return 'ERR:没有打开的文档';
        var doc = null;
        var i;

        if (jobId) {
            var marker = FIGMA_BRIDGE_MARKER + jobId;
            for (i = 0; i < app.documents.length; i++) {
                var marked = '';
                try {
                    marked = String(app.documents[i].info.jobName || '');
                } catch (e) {
                    marked = '';
                }
                if (marked === marker) {
                    doc = app.documents[i];
                    break;
                }
            }
        }

        if (!doc && docName) {
            for (i = 0; i < app.documents.length; i++) {
                if (app.documents[i].name === docName) {
                    doc = app.documents[i];
                    break;
                }
            }
        }
        if (!doc) doc = app.activeDocument;

        var f = new File(path);
        var opts = new PNGSaveOptions();
        opts.compression = 6;
        opts.interlaced = false;
        doc.saveAs(f, opts, true, Extension.LOWERCASE);
        return 'OK:' + doc.width + 'x' + doc.height;
    } catch (e) {
        return 'ERR:' + e.message;
    }
}
