// Figma 桥接 · ExtendScript 宿主脚本
// 只负责两件事：打开图片、导出 PNG 副本

function figmaBridgeOpenImage(path) {
    try {
        var f = new File(path);
        if (!f.exists) return 'ERR:文件不存在 ' + path;
        var doc = app.open(f);
        if (!doc) return 'ERR:打开失败';
        return 'OK:' + doc.name;
    } catch (e) {
        return 'ERR:' + e.message;
    }
}

function figmaBridgeSavePng(path, docName) {
    try {
        if (app.documents.length === 0) return 'ERR:没有打开的文档';
        var doc = null;
        if (docName) {
            for (var i = 0; i < app.documents.length; i++) {
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
