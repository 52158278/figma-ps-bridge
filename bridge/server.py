#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Figma <-> Photoshop 本地桥接服务

零依赖，只用 Python 标准库，仅监听 127.0.0.1。
Figma 插件（含网页版）与 Photoshop UXP 面板都连这个地址。

任务状态流转：
    awaiting-image -> pending -> editing -> ready -> done
                                   \\-> failed
"""

import json
import os
import secrets
import shutil
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

PORT_ENV = os.environ.get("PORT")
# 8765 常被代理软件（Clash / mihomo 等）占用，依次往下找空位
PORT_CANDIDATES = [int(PORT_ENV)] if PORT_ENV else list(range(8765, 8775))
PORT = PORT_CANDIDATES[0]
HOST = os.environ.get("HOST", "127.0.0.1")
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, ".data")
MAX_BODY = 256 * 1024 * 1024
LONG_POLL_SEC = 25
PS_ONLINE_WINDOW = 8  # 秒
# PS 面板崩了/被重载时，任务会一直卡在 editing，超过这个时间自动释放回 pending
EDIT_TIMEOUT_SEC = int(os.environ.get("EDIT_TIMEOUT_SEC", "600"))

os.makedirs(DATA_DIR, exist_ok=True)

JOBS = {}
JOBS_LOCK = threading.Condition()
LAST_PS_SEEN = 0.0
SETTLED = ("ready", "failed", "done")

JOBS_FILE = os.path.join(DATA_DIR, "jobs.json")
# 已完成/失败的任务只留 7 天，避免任务表无限增长
JOB_TTL_SEC = 7 * 24 * 3600

CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    # Chrome 私有网络访问预检，网页版 Figma 访问 127.0.0.1 必需
    "Access-Control-Allow-Private-Network": "true",
    "Access-Control-Max-Age": "86400",
    "Cache-Control": "no-store",
}


def now_ms():
    return int(time.time() * 1000)


def job_dir(job_id):
    return os.path.join(DATA_DIR, job_id)


def source_path(job_id):
    return os.path.join(job_dir(job_id), "source.png")


def result_path(job_id):
    return os.path.join(job_dir(job_id), "result.png")


def save_jobs_locked():
    """把任务表落盘（调用方需持有 JOBS_LOCK），服务重启后还能接着用。"""
    payload = {"version": 1, "jobs": list(JOBS.values())}
    tmp = JOBS_FILE + ".tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False)
        os.replace(tmp, JOBS_FILE)
    except OSError:
        pass


def load_jobs():
    """启动时恢复上次的任务表。"""
    try:
        with open(JOBS_FILE, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        return
    items = data.get("jobs") if isinstance(data, dict) else None
    if not isinstance(items, list):
        return
    now = time.time()
    with JOBS_LOCK:
        for job in items:
            if not isinstance(job, dict) or not job.get("id"):
                continue
            created = job.get("createdAt") or now_ms()
            updated = job.get("updatedAt") or created
            # 已完成/失败的任务超过保留期就丢掉
            if job.get("status") in SETTLED and now - updated / 1000.0 > JOB_TTL_SEC:
                continue
            job["createdAt"] = created
            job["updatedAt"] = updated
            job.setdefault("meta", {})
            job.setdefault("error", None)
            # 上次退出时还停在 editing 的任务，重启后放回 pending 方便重新接上
            if job.get("status") == "editing":
                job["status"] = "pending"
                job["updatedAt"] = now_ms()
            job["hasSource"] = os.path.exists(source_path(job["id"]))
            job["hasResult"] = os.path.exists(result_path(job["id"]))
            JOBS[job["id"]] = job
        save_jobs_locked()


def public_job(job):
    return {
        "id": job["id"],
        "status": job["status"],
        "createdAt": job["createdAt"],
        "updatedAt": job["updatedAt"],
        "meta": job["meta"],
        "hasSource": job["hasSource"],
        "hasResult": job["hasResult"],
        "error": job["error"],
    }


def set_status(job, status, error=None):
    with JOBS_LOCK:
        job["status"] = status
        job["updatedAt"] = now_ms()
        if error is not None:
            job["error"] = error
        save_jobs_locked()
        JOBS_LOCK.notify_all()


def wait_for_settle(job, seconds):
    deadline = time.time() + seconds
    with JOBS_LOCK:
        while job["status"] not in SETTLED:
            remaining = deadline - time.time()
            if remaining <= 0:
                break
            JOBS_LOCK.wait(remaining)
        return public_job(job)


def create_job(meta):
    job_id = secrets.token_hex(4)
    now = now_ms()
    job = {
        "id": job_id,
        "status": "awaiting-image",
        "createdAt": now,
        "updatedAt": now,
        "meta": meta if isinstance(meta, dict) else {},
        "hasSource": False,
        "hasResult": False,
        "error": None,
    }
    os.makedirs(job_dir(job_id), exist_ok=True)
    with JOBS_LOCK:
        JOBS[job_id] = job
        save_jobs_locked()
    return job


def cleanup(job):
    for path in (source_path(job["id"]), result_path(job["id"])):
        try:
            if os.path.exists(path):
                os.remove(path)
        except OSError:
            pass
    job["hasSource"] = False
    job["hasResult"] = False


def escape_html(text):
    return (
        str(text)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def status_page():
    with JOBS_LOCK:
        items = sorted(JOBS.values(), key=lambda j: j["createdAt"], reverse=True)
    rows = []
    for job in items:
        meta = job["meta"] or {}
        name = meta.get("nodeName") or meta.get("targetName") or "-"
        size = "%sx%s" % (meta.get("imageWidth", "-"), meta.get("imageHeight", "-"))
        stamp = time.strftime("%H:%M:%S", time.localtime(job["updatedAt"] / 1000))
        rows.append(
            "<tr><td>%s</td><td>%s</td><td>%s</td><td>%s</td><td>%s</td></tr>"
            % (job["id"], job["status"], escape_html(name), size, stamp)
        )
    body_rows = "".join(rows) or '<tr><td colspan="5">暂无任务</td></tr>'
    return """<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>PS 桥接</title><meta http-equiv="refresh" content="2">
<style>
body{font:14px/1.6 "Segoe UI","Microsoft YaHei",sans-serif;margin:24px;color:#171717;background:#f7f7f8}
h1{font-size:16px;margin:0 0 4px}p{margin:0 0 16px;color:#52525b}
table{border-collapse:collapse;width:100%%;background:#fff;border:1px solid #e4e4e7}
th,td{padding:8px 12px;border-bottom:1px solid #eee;text-align:left;font-size:13px}
th{background:#fafafa;font-weight:500}
</style></head><body>
<h1>PS 桥接服务</h1>
<p>监听 %s:%s · 任务数 %s</p>
<table><thead><tr><th>ID</th><th>状态</th><th>节点</th><th>尺寸</th><th>更新</th></tr></thead>
<tbody>%s</tbody></table>
</body></html>""" % (HOST, PORT, len(items), body_rows)


class HttpError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "PSBridge/0.1"

    # ---------------- 基础输出 ----------------

    def send_json(self, code, data):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        for key, value in CORS.items():
            self.send_header(key, value)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_html(self, html):
        body = html.encode("utf-8")
        self.send_response(200)
        for key, value in CORS.items():
            self.send_header(key, value)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_file(self, path, content_type):
        if not os.path.exists(path):
            return self.send_json(404, {"error": "文件不存在"})
        size = os.path.getsize(path)
        self.send_response(200)
        for key, value in CORS.items():
            self.send_header(key, value)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(size))
        self.end_headers()
        with open(path, "rb") as handle:
            shutil.copyfileobj(handle, self.wfile, 256 * 1024)

    def read_body(self, limit=MAX_BODY):
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length > limit:
            raise HttpError(413, "请求体过大（上限 %dMB）" % (limit // 1024 // 1024))
        if length <= 0:
            return b""
        return self.rfile.read(length)

    def log_message(self, fmt, *args):
        pass

    # ---------------- 方法分发 ----------------

    def do_OPTIONS(self):
        self.send_response(204)
        for key, value in CORS.items():
            self.send_header(key, value)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        self.dispatch("GET")

    def do_POST(self):
        self.dispatch("POST")

    def do_PUT(self):
        self.dispatch("PUT")

    def dispatch(self, method):
        parsed = urlparse(self.path)
        parts = [p for p in parsed.path.split("/") if p]
        query = parse_qs(parsed.query)
        try:
            self.route(method, parts, query)
        except HttpError as err:
            self.send_json(err.code, {"error": err.message})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as err:  # noqa: BLE001
            try:
                self.send_json(500, {"error": str(err)})
            except OSError:
                pass

    # ---------------- 路由 ----------------

    def route(self, method, parts, query):
        global LAST_PS_SEEN

        if not parts and method == "GET":
            return self.send_html(status_page())

        if not parts or parts[0] != "api":
            raise HttpError(404, "未知路径")

        section = parts[1] if len(parts) > 1 else ""

        if section == "health":
            online = (time.time() - LAST_PS_SEEN) < PS_ONLINE_WINDOW
            return self.send_json(
                200,
                {
                    "ok": True,
                    "version": "0.1.0",
                    "jobs": len(JOBS),
                    "port": PORT,
                    "psOnline": online,
                },
            )

        # PS 面板拉取待处理任务（同时充当心跳）
        if section == "ps" and len(parts) > 2 and parts[2] == "pending":
            LAST_PS_SEEN = time.time()
            with JOBS_LOCK:
                editing = next(
                    (j for j in JOBS.values() if j["status"] == "editing"), None
                )
                if editing is not None:
                    stale = time.time() - editing["updatedAt"] / 1000.0 > EDIT_TIMEOUT_SEC
                    if not stale:
                        return self.send_json(200, {"job": None, "busy": True})
                    editing["status"] = "pending"
                    editing["updatedAt"] = now_ms()
                    save_jobs_locked()
                candidates = sorted(
                    (j for j in JOBS.values() if j["status"] == "pending"),
                    key=lambda j: j["createdAt"],
                )
                if not candidates:
                    return self.send_json(200, {"job": None})
                job = candidates[0]
                job["status"] = "editing"
                job["updatedAt"] = now_ms()
                save_jobs_locked()
                payload = public_job(job)
            return self.send_json(
                200, {"job": payload, "sourceUrl": "/api/jobs/%s/image" % job["id"]}
            )

        if section != "jobs":
            raise HttpError(404, "未知路径")

        # /api/jobs
        if len(parts) == 2:
            if method == "POST":
                raw = self.read_body().decode("utf-8", "replace")
                meta = {}
                if raw.strip():
                    try:
                        meta = json.loads(raw)
                    except ValueError:
                        raise HttpError(400, "元数据不是合法 JSON")
                job = create_job(meta)
                return self.send_json(
                    200,
                    {
                        "id": job["id"],
                        "status": job["status"],
                        "uploadUrl": "/api/jobs/%s/image" % job["id"],
                    },
                )
            with JOBS_LOCK:
                data = [public_job(j) for j in JOBS.values()]
            return self.send_json(200, {"jobs": data})

        job = JOBS.get(parts[2])
        if job is None:
            raise HttpError(404, "任务不存在")

        action = parts[3] if len(parts) > 3 else ""

        if not action:
            return self.send_json(200, public_job(job))

        if action == "status" and method == "GET":
            wait_values = query.get("wait") or ["0"]
            try:
                seconds = min(float(wait_values[0]), LONG_POLL_SEC)
            except ValueError:
                seconds = 0
            data = wait_for_settle(job, seconds) if seconds > 0 else public_job(job)
            return self.send_json(200, data)

        if action == "image":
            if method == "PUT":
                body = self.read_body()
                if not body:
                    raise HttpError(400, "图片为空")
                with open(source_path(job["id"]), "wb") as handle:
                    handle.write(body)
                job["hasSource"] = True
                set_status(job, "pending")
                return self.send_json(200, {"ok": True, "bytes": len(body)})
            return self.send_file(source_path(job["id"]), "image/png")

        if action == "claim" and method == "POST":
            set_status(job, "editing")
            return self.send_json(200, public_job(job))

        if action == "result":
            if method == "PUT":
                body = self.read_body()
                if not body:
                    raise HttpError(400, "图片为空")
                with open(result_path(job["id"]), "wb") as handle:
                    handle.write(body)
                job["hasResult"] = True
                LAST_PS_SEEN = time.time()
                set_status(job, "ready")
                return self.send_json(200, {"ok": True, "bytes": len(body)})
            if not job["hasResult"]:
                raise HttpError(404, "结果还没生成")
            return self.send_file(result_path(job["id"]), "image/png")

        if action == "fail" and method == "POST":
            message = "PS 端处理失败"
            raw = self.read_body().decode("utf-8", "replace")
            if raw.strip():
                try:
                    message = json.loads(raw).get("error") or message
                except (ValueError, AttributeError):
                    pass
            set_status(job, "failed", message)
            return self.send_json(200, public_job(job))

        if action == "ack" and method == "POST":
            cleanup(job)
            set_status(job, "done")
            return self.send_json(200, public_job(job))

        raise HttpError(404, "未知任务操作")


class BridgeServer(ThreadingHTTPServer):
    daemon_threads = True
    # Windows 上 SO_REUSEADDR 允许和别的进程「抢」同一端口，会抢到却不收包
    allow_reuse_address = False


def bind_server():
    """按候选端口依次尝试，返回 (server, port)。"""
    failed = []
    for port in PORT_CANDIDATES:
        try:
            return BridgeServer((HOST, port), Handler), port
        except OSError as err:
            failed.append("%d（%s）" % (port, err.strerror or err))
    raise SystemExit(
        "[ps-bridge] 候选端口全部被占用：%s\n"
        "[ps-bridge] 关掉占用端口的程序后重试，或设置环境变量 PORT 指定端口" % "、".join(failed)
    )


def main():
    global PORT
    # 先恢复上次的任务表，重启后 Figma / PS 还能接着续上
    load_jobs()
    server, PORT = bind_server()
    print("[ps-bridge] 已启动: http://%s:%s" % (HOST, PORT))
    print("[ps-bridge] Figma 插件与 PS 面板会自动找到这个端口，按 Ctrl+C 结束")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[ps-bridge] 已停止")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
