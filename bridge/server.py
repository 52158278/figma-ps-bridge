#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Figma <-> Photoshop 本地桥接服务

零依赖，只用 Python 标准库，仅监听 127.0.0.1。
Figma 插件（含网页版）与 Photoshop CEP 面板都连这个地址。

多文档并行（0.2.0）：允许任意多个任务同时处于 editing，各自用租约保活。
任务状态流转：
    awaiting-image -> pending -> editing -> ready -> done
                                    \\-> failed
    editing 超过 EDIT_TIMEOUT_SEC 无 touch -> pending（释放租约）
"""

import json
import math
import os
import re
import secrets
import shutil
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs
from urllib.request import urlopen

VERSION = "0.3.1"

HOST = os.environ.get("HOST", "127.0.0.1")
PORT_ENV = os.environ.get("PORT")
try:
    # 8765 常被代理软件（Clash / mihomo 等）占用，依次往下找空位
    PORT_CANDIDATES = [int(PORT_ENV)] if PORT_ENV else list(range(8765, 8775))
except (TypeError, ValueError):
    PORT_CANDIDATES = list(range(8765, 8775))
PORT = PORT_CANDIDATES[0]
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, ".data")
JOBS_FILE = os.path.join(DATA_DIR, "jobs.json")
MAX_BODY = 256 * 1024 * 1024
LONG_POLL_SEC = 25
PS_ONLINE_WINDOW = 8  # 秒


def env_int(name, default, minimum=1):
    """读整型环境变量，非法值退回默认值（不让启动因为一个环境变量崩掉）。"""
    raw = os.environ.get(name)
    if raw is None or not str(raw).strip():
        return default
    try:
        value = int(float(raw))
    except (TypeError, ValueError):
        print("[ps-bridge] 环境变量 %s=%r 不是数字，改用默认值 %s" % (name, raw, default))
        return default
    return value if value >= minimum else minimum


# PS 面板崩了/被重载时，任务会一直卡在 editing，超过这个时间没有 touch 就自动释放回 pending
EDIT_TIMEOUT_SEC = env_int("EDIT_TIMEOUT_SEC", 600)
EDIT_TIMEOUT_MS = EDIT_TIMEOUT_SEC * 1000
LEASE_SWEEP_SEC = 15
GC_INTERVAL_SEC = 10 * 60
# 孤儿目录至少要「闲置」这么久才允许清理：create_job 是「登记 + 建目录」两步，
# 给这段窗口留足余量，刚建好的目录永远不会被 GC 当成孤儿（D1）
GC_ORPHAN_MIN_AGE_SEC = 10 * 60
# 已完成/失败的任务留 30 天：PS 里存过的 PSD 隔很久再打开也能认出原图层
JOB_TTL_SEC = 30 * 24 * 3600

os.makedirs(DATA_DIR, exist_ok=True)

JOBS = {}
JOBS_LOCK = threading.Condition()
LAST_PS_SEEN = 0.0
# PS 面板上报的现场状态（只读展示用，不参与任务流转）：
# activeJobId = PS 当前活动文档对应的任务；openJobIds = PS 里开着文档的任务集合。
PS_STATE = {"activeJobId": None, "openJobIds": [], "updatedAt": 0}
SETTLED = ("ready", "failed", "done")
STATUSES = ("awaiting-image", "pending", "editing") + SETTLED
JOB_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

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


def as_ms(value):
    """把时间戳安全地规整成毫秒整数：非数值/NaN/∞ 一律按 0 处理（§3.6）。"""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return 0
    try:
        if not math.isfinite(value):
            return 0
    except (TypeError, ValueError):
        return 0
    return int(value)


def job_dir(job_id):
    return os.path.join(DATA_DIR, job_id)


def source_path(job_id):
    return os.path.join(job_dir(job_id), "source.png")


def result_path(job_id):
    return os.path.join(job_dir(job_id), "result.png")


def save_jobs_locked():
    """把任务表落盘（调用方需持有 JOBS_LOCK），服务重启后还能接着用。"""
    payload = {"version": 2, "jobs": list(JOBS.values())}
    tmp = JOBS_FILE + ".tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False)
        os.replace(tmp, JOBS_FILE)
    except OSError:
        pass


def backup_bad_jobs_file():
    """jobs.json 解析失败时改名备份，保留现场方便排查（§3.6）。"""
    stamp = time.strftime("%Y%m%d-%H%M%S")
    target = os.path.join(DATA_DIR, "jobs.bad.%s.json" % stamp)
    try:
        os.replace(JOBS_FILE, target)
        print("[ps-bridge] 警告：jobs.json 解析失败，已备份为 %s，从空任务表启动" % target)
    except OSError as err:
        print("[ps-bridge] 警告：jobs.json 解析失败且备份失败（%s），从空任务表启动" % err)


def normalize_job(raw):
    """把磁盘上的一条记录整理成可用的 job；不合法返回 None（§3.6 健壮性）。"""
    if not isinstance(raw, dict):
        return None
    job_id = raw.get("id")
    if not isinstance(job_id, str) or not JOB_ID_RE.match(job_id):
        return None
    status = raw.get("status")
    if status not in STATUSES:
        status = "failed"
        raw["error"] = raw.get("error") or "任务状态异常"
    created = as_ms(raw.get("createdAt"))
    updated = as_ms(raw.get("updatedAt")) or created
    meta = raw.get("meta")
    raw["meta"] = meta if isinstance(meta, dict) else {}
    if raw.get("error") is not None and not isinstance(raw.get("error"), str):
        raw["error"] = str(raw.get("error"))
    raw.setdefault("error", None)
    raw["id"] = job_id
    raw["status"] = status
    raw["createdAt"] = created
    raw["updatedAt"] = updated
    raw["hasSource"] = os.path.exists(source_path(job_id))
    raw["hasResult"] = os.path.exists(result_path(job_id))
    return raw


def load_jobs():
    """启动时恢复上次的任务表。"""
    if not os.path.exists(JOBS_FILE):
        return
    try:
        with open(JOBS_FILE, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except ValueError:
        backup_bad_jobs_file()
        return
    except OSError as err:
        print("[ps-bridge] 警告：读取 %s 失败：%s" % (JOBS_FILE, err))
        return

    if isinstance(data, dict):
        items = data.get("jobs")
    elif isinstance(data, list):
        items = data
    else:
        items = None
    if not isinstance(items, list):
        print("[ps-bridge] 警告：jobs.json 结构异常（缺少 jobs 数组），忽略历史任务")
        return

    now = time.time()
    restored = {}
    for raw in items:
        job = normalize_job(raw)
        if job is None:
            continue
        # 已完成/失败的任务超过保留期就丢掉
        if job["status"] in SETTLED and now - job["updatedAt"] / 1000.0 > JOB_TTL_SEC:
            continue
        # 上次退出时还停在 editing 的任务，重启后放回 pending 方便重新接上
        if job["status"] == "editing":
            job["status"] = "pending"
            job["updatedAt"] = now_ms()
        # 旧数据没有 lastTouch（§7）：按当前时间补齐，不影响启动
        job["lastTouch"] = as_ms(job.get("lastTouch")) or now_ms()
        restored[job["id"]] = job

    with JOBS_LOCK:
        JOBS.update(restored)
        save_jobs_locked()
    if restored:
        print("[ps-bridge] 已恢复 %d 个历史任务" % len(restored))


def public_job(job):
    meta = job.get("meta")
    return {
        "id": job.get("id"),
        "status": job.get("status"),
        "createdAt": as_ms(job.get("createdAt")),
        "updatedAt": as_ms(job.get("updatedAt")),
        "meta": meta if isinstance(meta, dict) else {},
        "hasSource": bool(job.get("hasSource")),
        "hasResult": bool(job.get("hasResult")),
        "error": job.get("error"),
    }


def public_jobs():
    with JOBS_LOCK:
        items = sorted(JOBS.values(), key=lambda j: as_ms(j.get("createdAt")))
        return [public_job(job) for job in items]


def job_count():
    with JOBS_LOCK:
        return len(JOBS)


def ps_online():
    return (time.time() - LAST_PS_SEEN) < PS_ONLINE_WINDOW


def mark_ps_seen():
    """刷新 PS 面板最后在线时间。"""
    global LAST_PS_SEEN
    LAST_PS_SEEN = time.time()


def ps_state():
    """当前 PS 现场状态；离线时不暴露过期的 activeJobId。"""
    if not ps_online():
        return {"online": False, "activeJobId": None, "openJobIds": [], "updatedAt": 0}
    return {
        "online": True,
        "activeJobId": PS_STATE["activeJobId"],
        "openJobIds": list(PS_STATE["openJobIds"]),
        "updatedAt": PS_STATE["updatedAt"],
    }


def update_ps_state(raw):
    """合并 PS 面板心跳里带的上报。

    只有 activeJobId / openJobIds 真的变化时才唤醒长轮询 —— 心跳每 2 秒一次，
    每次都 notify 会把所有等待者变成 2 秒一轮的热循环。
    """
    if not raw:
        return False
    try:
        data = json.loads(raw.decode("utf-8", "replace") or "{}")
    except ValueError:
        return False
    if not isinstance(data, dict):
        return False

    with JOBS_LOCK:
        active = data.get("activeJobId")
        active = str(active) if active else None
        if active is not None and active not in JOBS:
            active = None

        open_ids = data.get("openJobIds")
        if isinstance(open_ids, list):
            cleaned = []
            for item in open_ids:
                job_id = str(item) if item else ""
                if job_id and job_id in JOBS and job_id not in cleaned:
                    cleaned.append(job_id)
            open_ids = cleaned
        else:
            open_ids = list(PS_STATE["openJobIds"])

        if active == PS_STATE["activeJobId"] and open_ids == PS_STATE["openJobIds"]:
            return False

        PS_STATE["activeJobId"] = active
        PS_STATE["openJobIds"] = open_ids
        PS_STATE["updatedAt"] = now_ms()
        JOBS_LOCK.notify_all()
        return True


def set_status(job, status, error=None):
    with JOBS_LOCK:
        job["status"] = status
        job["updatedAt"] = now_ms()
        if error is not None:
            job["error"] = error
        save_jobs_locked()
        JOBS_LOCK.notify_all()


def claim_locked(job):
    """把 job 置为 editing 并刷新租约（调用方需持有 JOBS_LOCK）。"""
    stamp = now_ms()
    job["status"] = "editing"
    job["updatedAt"] = stamp
    job["lastTouch"] = stamp
    return public_job(job)


def claim_job(job):
    with JOBS_LOCK:
        payload = claim_locked(job)
        save_jobs_locked()
        JOBS_LOCK.notify_all()
    return payload


def touch_job(job):
    """续租：只刷新 lastTouch，不动 updatedAt（免得白唤醒 Figma 的 watch）。"""
    with JOBS_LOCK:
        job["lastTouch"] = now_ms()
        save_jobs_locked()
        return public_job(job)


def sweep_leases():
    """把超时未 touch 的 editing 任务释放回 pending，返回被释放的 id 列表（§3.2）。"""
    stamp = now_ms()
    released = []
    with JOBS_LOCK:
        for job in JOBS.values():
            if job.get("status") != "editing":
                continue
            last = as_ms(job.get("lastTouch")) or as_ms(job.get("updatedAt"))
            if stamp - last > EDIT_TIMEOUT_MS:
                job["status"] = "pending"
                job["updatedAt"] = stamp
                released.append(job.get("id"))
        if released:
            save_jobs_locked()
            JOBS_LOCK.notify_all()
    return released


def next_pending_job():
    """领取下一个 pending 任务（一次一个），没有则返回 None（§3.3）。"""
    # 顺手清一次过期租约，不必干等后台线程的下一轮扫描
    sweep_leases()
    with JOBS_LOCK:
        candidates = sorted(
            (job for job in JOBS.values() if job.get("status") == "pending"),
            key=lambda job: as_ms(job.get("createdAt")),
        )
        if not candidates:
            return None
        payload = claim_locked(candidates[0])
        save_jobs_locked()
        JOBS_LOCK.notify_all()
    return payload


def wait_for_settle(job, seconds):
    deadline = time.time() + seconds
    with JOBS_LOCK:
        while job.get("status") not in SETTLED:
            remaining = deadline - time.time()
            if remaining <= 0:
                break
            JOBS_LOCK.wait(remaining)
        return public_job(job)


def watch_jobs(ids, seconds):
    """长轮询：任一 id 的 updatedAt 变化（或记录消失）、或 PS 现场状态变化即返回。

    PS 现场状态（activeJobId/openJobIds）变化也要唤醒 —— 否则 Figma 端
    「PS 正在看哪张」要等到某个任务更新才刷新，最长要等 25 秒。
    ids 为空立即返回（§3.4）。
    """
    if not ids:
        return []
    deadline = time.time() + max(0.0, seconds)
    with JOBS_LOCK:
        snapshot = {}
        for job_id in ids:
            job = JOBS.get(job_id)
            if job is not None:
                snapshot[job_id] = as_ms(job.get("updatedAt"))
        if not snapshot:
            return []
        ps_stamp = as_ms(PS_STATE.get("updatedAt"))
        while True:
            changed = False
            for job_id, stamp in snapshot.items():
                job = JOBS.get(job_id)
                if job is None or as_ms(job.get("updatedAt")) != stamp:
                    changed = True
                    break
            if not changed and as_ms(PS_STATE.get("updatedAt")) != ps_stamp:
                changed = True
            if changed:
                break
            remaining = deadline - time.time()
            if remaining <= 0:
                break
            JOBS_LOCK.wait(remaining)
        return [public_job(JOBS[job_id]) for job_id in ids if job_id in JOBS]


def create_job(meta):
    job_id = secrets.token_hex(4)
    stamp = now_ms()
    job = {
        "id": job_id,
        "status": "awaiting-image",
        "createdAt": stamp,
        "updatedAt": stamp,
        "lastTouch": stamp,
        "meta": meta if isinstance(meta, dict) else {},
        "hasSource": False,
        "hasResult": False,
        "error": None,
    }
    with JOBS_LOCK:
        # 先登记、再在同一个锁区里建目录：GC 的孤儿清理也在这把锁内复查并删除，
        # 两者串行，任何时刻都不会出现「目录已建好但 JOBS 里还没有」的窗口（D1）
        JOBS[job_id] = job
        try:
            os.makedirs(job_dir(job_id), exist_ok=True)
        except OSError:
            JOBS.pop(job_id, None)
            raise
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


def gc_once():
    """清理过期的 settled 记录与目录，以及没有 job 记录的孤儿目录（§3.5）。

    删除目录一律在 JOBS_LOCK 内做二次复查，并且跳过最近 10 分钟新建的目录，
    避免和 create_job 的「登记 + 建目录」抢跑（D1）。
    """
    now = time.time()
    removed = []
    with JOBS_LOCK:
        for job_id, job in list(JOBS.items()):
            if job.get("status") not in SETTLED:
                continue
            if now - as_ms(job.get("updatedAt")) / 1000.0 <= JOB_TTL_SEC:
                continue
            JOBS.pop(job_id, None)
            removed.append(job_id)
        if removed:
            save_jobs_locked()
            JOBS_LOCK.notify_all()
        # 记录摘掉后目录也在这把锁内删，杜绝「同一 id 刚被新任务复用就被删」的窗口
        for job_id in removed:
            shutil.rmtree(job_dir(job_id), ignore_errors=True)

    orphans = 0
    try:
        names = os.listdir(DATA_DIR)
    except OSError:
        names = []
    for name in names:
        # 只认 job id 形态的目录，避免误删 .data 下别的东西
        if not re.match(r"^[0-9a-f]{8}$", name):
            continue
        path = os.path.join(DATA_DIR, name)
        try:
            if not os.path.isdir(path):
                continue
            # 刚创建的目录一律不碰：create_job 的登记/建目录可能正在排队
            if time.time() - os.path.getmtime(path) <= GC_ORPHAN_MIN_AGE_SEC:
                continue
        except OSError:
            continue
        with JOBS_LOCK:
            # 关键：不能只用扫描时的快照，必须在锁内复查该 id 现在仍没有记录
            if name in JOBS:
                continue
            shutil.rmtree(path, ignore_errors=True)
        orphans += 1

    if removed or orphans:
        print(
            "[ps-bridge] GC：清理过期任务 %d 个、孤儿目录 %d 个" % (len(removed), orphans)
        )


def escape_html(text):
    return (
        str(text)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
        .replace("'", "&#39;")
    )


def status_page():
    with JOBS_LOCK:
        items = sorted(
            JOBS.values(), key=lambda j: as_ms(j.get("createdAt")), reverse=True
        )
        total = len(items)
        online = ps_online()
    rows = []
    for job in items:
        meta = job.get("meta") if isinstance(job.get("meta"), dict) else {}
        name = meta.get("nodeName") or meta.get("targetName") or "-"
        size = "%sx%s" % (meta.get("imageWidth", "-"), meta.get("imageHeight", "-"))
        updated = as_ms(job.get("updatedAt"))
        stamp = time.strftime("%H:%M:%S", time.localtime(updated / 1000.0))
        rows.append(
            "<tr><td>%s</td><td>%s</td><td>%s</td><td>%s</td><td>%s</td></tr>"
            % (
                escape_html(job.get("id", "-")),
                escape_html(job.get("status", "-")),
                escape_html(name),
                escape_html(size),
                escape_html(stamp),
            )
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
<h1>PS 桥接服务 v%s</h1>
<p>监听 %s:%s · 任务数 %s · PS 面板 %s</p>
<table><thead><tr><th>ID</th><th>状态</th><th>节点</th><th>尺寸</th><th>更新</th></tr></thead>
<tbody>%s</tbody></table>
</body></html>""" % (
        escape_html(VERSION),
        escape_html(HOST),
        escape_html(PORT),
        escape_html(total),
        "在线" if online else "离线",
        body_rows,
    )


def parse_seconds(values, cap, default=0.0):
    """把 ?wait= 解析成秒，限制在 [0, cap]（§3.3 / §3.4）。"""
    if not values:
        return min(default, cap)
    try:
        seconds = float(values[0])
    except (TypeError, ValueError):
        return 0.0
    if not math.isfinite(seconds):
        return 0.0
    return max(0.0, min(seconds, cap))


class HttpError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "PSBridge/" + VERSION
    _body = None

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
        # dispatch() 会把请求体先读进 self._body：HTTP/1.1 长连接下，
        # 任何没被读走的 body 字节都会被当成下一个请求的开头，导致解析错乱。
        if self._body is not None:
            if len(self._body) > limit:
                raise HttpError(413, "请求体过大（上限 %dMB）" % (limit // 1024 // 1024))
            return self._body
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length > limit:
            # 这么大的 body 不读了，直接断开连接，免得残留字节污染后续请求
            self.close_connection = True
            raise HttpError(413, "请求体过大（上限 %dMB）" % (limit // 1024 // 1024))
        if length <= 0:
            self._body = b""
            return self._body
        self._body = self.rfile.read(length)
        return self._body

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
        self._body = None
        parsed = urlparse(self.path)
        parts = [p for p in parsed.path.split("/") if p]
        query = parse_qs(parsed.query)
        try:
            if method in ("POST", "PUT", "PATCH"):
                # 先把请求体读干净，保证 keep-alive 连接上的下一个请求不被污染
                self.read_body()
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
        if not parts and method == "GET":
            return self.send_html(status_page())

        if not parts or parts[0] != "api":
            raise HttpError(404, "未知路径")

        section = parts[1] if len(parts) > 1 else ""

        if section == "health":
            if method != "GET":
                raise HttpError(404, "未知路径")
            # 注意：/api/health 不再刷新心跳，心跳统一走 POST /api/ps/heartbeat
            return self.send_json(
                200,
                {
                    "ok": True,
                    "version": VERSION,
                    "jobs": job_count(),
                    "port": PORT,
                    "psOnline": ps_online(),
                    "ps": ps_state(),
                },
            )

        if section == "ps":
            return self.route_ps(method, parts)

        if section != "jobs":
            raise HttpError(404, "未知路径")

        # /api/jobs/watch —— 必须放在按 id 取 job 之前（watch 也是三段路径）
        if len(parts) == 3 and parts[2] == "watch":
            if method != "GET":
                raise HttpError(404, "未知路径")
            ids = []
            for chunk in query.get("ids") or []:
                for piece in chunk.split(","):
                    piece = piece.strip()
                    if piece and piece not in ids:
                        ids.append(piece)
            seconds = parse_seconds(query.get("wait"), LONG_POLL_SEC, LONG_POLL_SEC)
            return self.send_json(
                200, {"jobs": watch_jobs(ids, seconds), "ps": ps_state()}
            )

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
            if method == "GET":
                return self.send_json(200, {"jobs": public_jobs()})
            raise HttpError(404, "未知路径")

        job = JOBS.get(parts[2])
        if job is None:
            raise HttpError(404, "任务不存在")

        action = parts[3] if len(parts) > 3 else ""

        if not action:
            return self.send_json(200, public_job(job))

        if action == "status" and method == "GET":
            seconds = parse_seconds(query.get("wait"), LONG_POLL_SEC, 0.0)
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
            return self.send_json(200, claim_job(job))

        if action == "touch" and method == "POST":
            return self.send_json(200, touch_job(job))

        if action == "meta" and method == "POST":
            # 合并客户端发回来的 meta 字段（如 resultLayerId），保存后下次回传带过来
            raw = self.read_body().decode("utf-8", "replace")
            updates = {}
            if raw.strip():
                try:
                    updates = json.loads(raw)
                except ValueError:
                    raise HttpError(400, "meta 不是合法 JSON")
            if not isinstance(updates, dict):
                raise HttpError(400, "meta 必须是对象")
            with JOBS_LOCK:
                merged = dict(job.get("meta") if isinstance(job.get("meta"), dict) else {})
                merged.update(updates)
                job["meta"] = merged
                save_jobs_locked()
            return self.send_json(200, public_job(job))

        if action == "result":
            if method == "PUT":
                body = self.read_body()
                if not body:
                    raise HttpError(400, "图片为空")
                with open(result_path(job["id"]), "wb") as handle:
                    handle.write(body)
                job["hasResult"] = True
                mark_ps_seen()
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
                    payload = json.loads(raw)
                except ValueError:
                    payload = None
                if isinstance(payload, dict) and payload.get("error"):
                    message = str(payload["error"])
            set_status(job, "failed", message)
            return self.send_json(200, public_job(job))

        if action == "ack" and method == "POST":
            expected = self.read_ack_updated_at()
            with JOBS_LOCK:
                # 条件 ack（P0 丢图根治点）：带了 updatedAt 且和当前值不一致，
                # 说明 Figma 贴的是旧结果、PS 之后又回传了新图 —— 绝不能删文件改状态。
                stale = expected is not None and expected != as_ms(job.get("updatedAt"))
                if not stale:
                    cleanup(job)
                    job["status"] = "done"
                    job["updatedAt"] = now_ms()
                    save_jobs_locked()
                    JOBS_LOCK.notify_all()
                payload = public_job(job)
            if stale:
                return self.send_json(200, {"ok": False, "stale": True, "job": payload})
            return self.send_json(200, dict(payload, ok=True))

        raise HttpError(404, "未知任务操作")

    def read_ack_updated_at(self):
        """ack 的 body 可选：`{"updatedAt": <ms>}`；没有 body / 没有该字段返回 None。"""
        raw = self.read_body().decode("utf-8", "replace")
        if not raw.strip():
            return None
        try:
            payload = json.loads(raw)
        except ValueError:
            raise HttpError(400, "确认内容不是合法 JSON")
        if not isinstance(payload, dict):
            raise HttpError(400, "确认内容不是 JSON 对象")
        if "updatedAt" not in payload or payload["updatedAt"] is None:
            return None
        return as_ms(payload["updatedAt"])

    # ---------------- PS 面板专用 ----------------

    def route_ps(self, method, parts):
        action = parts[2] if len(parts) > 2 else ""

        if action == "heartbeat" and method == "POST":
            mark_ps_seen()
            # 新版面板会在心跳里带上 {activeJobId, openJobIds}，供 Figma 端展示“PS 正在看哪张”
            update_ps_state(self.read_body())
            return self.send_json(
                200,
                {
                    "ok": True,
                    "psOnline": True,
                    "jobs": job_count(),
                    "ps": ps_state(),
                },
            )

        if action == "jobs" and method == "GET":
            return self.send_json(200, {"jobs": public_jobs(), "ps": ps_state()})

        if action == "pending" and method == "GET":
            # 老接口顺带当心跳；新面板请用 POST /api/ps/heartbeat
            mark_ps_seen()
            payload = next_pending_job()
            if payload is None:
                return self.send_json(200, {"job": None})
            return self.send_json(
                200,
                {"job": payload, "sourceUrl": "/api/jobs/%s/image" % payload["id"]},
            )

        raise HttpError(404, "未知路径")


class BridgeServer(ThreadingHTTPServer):
    daemon_threads = True
    # Windows 上 SO_REUSEADDR 允许和别的进程「抢」同一端口，会抢到却不收包
    allow_reuse_address = False


def start_background_threads():
    """租约扫描（15s）与 GC（10min）两个后台线程。"""

    def lease_loop():
        while True:
            time.sleep(LEASE_SWEEP_SEC)
            try:
                released = sweep_leases()
            except Exception as err:  # noqa: BLE001
                print("[ps-bridge] 租约扫描失败：%s" % err)
                continue
            if released:
                print(
                    "[ps-bridge] 租约超时，已释放回 pending：%s" % "、".join(released)
                )

    def gc_loop():
        while True:
            time.sleep(GC_INTERVAL_SEC)
            try:
                gc_once()
            except Exception as err:  # noqa: BLE001
                print("[ps-bridge] GC 失败：%s" % err)

    threading.Thread(target=lease_loop, name="lease-sweeper", daemon=True).start()
    threading.Thread(target=gc_loop, name="job-gc", daemon=True).start()


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


def find_running_instance():
    """检查候选端口上是否已经有桥接实例在跑。

    防止双击两次「启动桥接」起出两个服务：那样 Figma 和 PS 可能分别连到不同实例，
    表现为「任务明明在，PS 却说任务不存在」。这里发现已有实例就退出，只保留一个。
    """
    probe_host = "127.0.0.1"
    for port in PORT_CANDIDATES:
        url = "http://%s:%d/api/health" % (probe_host, port)
        try:
            with urlopen(url, timeout=0.6) as resp:  # noqa: S310 - 只探本机
                data = json.loads(resp.read().decode("utf-8", "replace"))
        except Exception:  # noqa: BLE001 - 连不上就说明这个端口没有实例
            continue
        if isinstance(data, dict) and data.get("ok") is True and data.get("version"):
            return port, data.get("jobs", 0)
    return None, 0


def main():
    global PORT
    running_port, running_jobs = find_running_instance()
    if running_port is not None:
        print()
        print("[ps-bridge] 已经有一个桥接服务在运行：http://127.0.0.1:%d" % running_port)
        print("[ps-bridge] 当前有 %d 个任务记录。不会重复启动。" % running_jobs)
        print()
        print("  需要重启的话：先关掉那个黑色的桥接窗口，再双击「启动 PS 桥接」。")
        print("  同时开两个会导致 Figma 和 Photoshop 连到不同实例，出现「任务不存在」的假象。")
        print()
        return 0
    # 先恢复上次的任务表，重启后 Figma / PS 还能接着续上
    load_jobs()
    server, PORT = bind_server()
    start_background_threads()
    print("[ps-bridge] 已启动 v%s: http://%s:%s" % (VERSION, HOST, PORT))
    print(
        "[ps-bridge] 多文档并行已开启（租约 %ss，无 touch 自动释放回 pending）"
        % EDIT_TIMEOUT_SEC
    )
    print("[ps-bridge] Figma 插件与 PS 面板会自动找到这个端口，按 Ctrl+C 结束")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[ps-bridge] 已停止")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
