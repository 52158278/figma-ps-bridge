#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""多文档并行 e2e 验收脚本（纯 Python 标准库，零依赖）。

按 docs/multi-doc-spec.md 第 8 章 B2 实现：脚本自己挑一个空闲端口、把
bridge/server.py 拉起来，然后扮演 Figma 端与 PS 端，把多图并行的完整流程
跑一遍。默认把 server.py 复制到系统临时目录再启动，跑完自动清理，不会
污染仓库里的 bridge/.data；需要直接就地跑真实服务时加 --no-isolate。

用法：
    py tools/e2e_multi.py --port 18765      # 指定端口
    py tools/e2e_multi.py                   # 自动挑空闲端口
    py tools/e2e_multi.py --no-isolate      # 直接启动仓库里的 bridge/server.py
    py tools/e2e_multi.py --edit-timeout 2 --lease-wait 30 --keep

断言（全部通过退出码 0，否则非 0 并逐条打印失败原因）：
    1) 建 3 个 job → 上传 3 张不同尺寸 PNG → 全部 pending
    2) 连续 claim 3 个 → 3 个同时 editing（不再有全局 busy）
    3) 每个 job touch 续租；EDIT_TIMEOUT_SEC=2 下停止 touch → 释放回 pending
    4) 3 个 job 各自 PUT result → GET /api/jobs/watch?ids=... 被唤起并返回新状态（不等满 25s）
    5) 带正确 updatedAt 的 ack → done 且 result.png 被删除
    6) 带错误 updatedAt 的 stale ack → {ok:false,stale:true}、状态不变、result.png 仍在
    7) POST /api/ps/heartbeat 后 health.psOnline=true；停 8 秒以上不调 → false
    8) GET /api/ps/pending 响应里不再有 busy 字段
"""

import argparse
import json
import os
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import urllib.error
import urllib.request
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_SERVER = os.path.join(os.path.dirname(HERE), "bridge", "server.py")

# 三张不同尺寸的输入图 / 三张不同尺寸的回传图，避免「同尺寸覆盖」掩盖问题
SOURCE_SIZES = [(48, 32), (73, 55), (120, 90)]
SOURCE_COLORS = [(220, 48, 48), (40, 160, 96), (56, 96, 224)]
RESULT_SIZES = [(96, 64), (146, 110), (240, 180)]
RESULT_COLORS = [(48, 48, 220), (220, 160, 32), (32, 180, 180)]

OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


class CheckFailed(AssertionError):
    """一条断言失败；Runner 会打印原因但不再抛栈。"""


def need(condition, message):
    if not condition:
        raise CheckFailed(message)


# ---------------------------------------------------------------- HTTP 客户端


def http_call(base, method, path, body=None, json_body=None, timeout=35):
    """发一个 HTTP 请求，返回 (status_code, parsed_json_or_bytes)。

    HTTP 4xx/5xx 不抛异常（e2e 需要断言状态码），网络错误才抛 CheckFailed。
    """
    url = base + path
    data = None
    headers = {}
    if json_body is not None:
        data = json.dumps(json_body, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json; charset=utf-8"
    elif body is not None:
        data = body
        headers["Content-Type"] = "image/png"
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with OPENER.open(request, timeout=timeout) as response:
            raw = response.read()
            status = response.getcode()
    except urllib.error.HTTPError as err:
        raw = err.read()
        status = err.code
    except (urllib.error.URLError, OSError) as err:
        reason = getattr(err, "reason", err)
        raise CheckFailed("请求 %s %s 失败：%s" % (method, path, reason))
    try:
        return status, json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return status, raw


def get_result_status(base, job_id):
    """GET /api/jobs/<id>/result，只关心状态码。"""
    status, _ = http_call(base, "GET", "/api/jobs/%s/result" % job_id, timeout=10)
    return status


def extract_job(payload):
    """ack 等接口的响应既可能是 publicJob 本体，也可能是 {job:...} 包裹。"""
    if not isinstance(payload, dict):
        return None
    if isinstance(payload.get("job"), dict):
        return payload["job"]
    if "status" in payload and "id" in payload:
        return payload
    return None


# ---------------------------------------------------------------- PNG 生成


def _png_chunk(tag, payload):
    return (
        struct.pack(">I", len(payload))
        + tag
        + payload
        + struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF)
    )


def make_png(width, height, color):
    """生成一张纯色 RGB PNG（不依赖 Pillow）。"""
    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    row = b"\x00" + bytes(color) * width
    return (
        b"\x89PNG\r\n\x1a\n"
        + _png_chunk(b"IHDR", header)
        + _png_chunk(b"IDAT", zlib.compress(row * height, 9))
        + _png_chunk(b"IEND", b"")
    )


# ---------------------------------------------------------------- 端口 / 服务进程


def find_free_port():
    probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]
    finally:
        probe.close()


def port_is_free(port):
    probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        probe.bind(("127.0.0.1", port))
        return True
    except OSError:
        return False
    finally:
        probe.close()


class Bridge(object):
    """在临时目录里拉起一份 bridge/server.py，并等它 /api/health 就绪。"""

    def __init__(self, server_path, port, edit_timeout, isolate=True, keep=False):
        self.source = os.path.abspath(server_path)
        self.port = port
        self.edit_timeout = edit_timeout
        self.isolate = isolate
        self.keep = keep
        self.work_dir = None
        self.launch_path = None
        self.log_path = None
        self.proc = None
        self._log_handle = None

    @property
    def base(self):
        return "http://127.0.0.1:%d" % self.port

    def result_file(self, job_id):
        """按 server.py 的 DATA_DIR 约定推算出 result.png 的真实路径。"""
        bridge_dir = os.path.dirname(self.launch_path)
        return os.path.join(bridge_dir, ".data", job_id, "result.png")

    def start(self):
        if not os.path.isfile(self.source):
            raise CheckFailed("找不到桥接服务文件：%s" % self.source)
        self.work_dir = tempfile.mkdtemp(prefix="ps-bridge-e2e-")
        if self.isolate:
            bridge_dir = os.path.join(self.work_dir, "bridge")
            os.makedirs(bridge_dir)
            self.launch_path = os.path.join(bridge_dir, "server.py")
            shutil.copy2(self.source, self.launch_path)
        else:
            self.launch_path = self.source
        self.log_path = os.path.join(self.work_dir, "server.log")
        self._log_handle = open(self.log_path, "wb")
        env = dict(os.environ)
        env["HOST"] = "127.0.0.1"
        env["PORT"] = str(self.port)
        env["EDIT_TIMEOUT_SEC"] = str(self.edit_timeout)
        env["PYTHONUNBUFFERED"] = "1"
        # 子进程 stdout 被重定向时 Python 默认用系统编码；统一成 UTF-8 便于回读日志
        env["PYTHONIOENCODING"] = "utf-8"
        self.proc = subprocess.Popen(
            [sys.executable, self.launch_path],
            cwd=os.path.dirname(self.launch_path),
            env=env,
            stdout=self._log_handle,
            stderr=subprocess.STDOUT,
        )
        self._wait_ready()

    def _wait_ready(self, timeout=20.0):
        deadline = time.time() + timeout
        last_error = "无响应"
        while time.time() < deadline:
            if self.proc.poll() is not None:
                raise CheckFailed(
                    "桥接进程启动即退出（exit=%s）\n%s"
                    % (self.proc.returncode, self.log_tail())
                )
            try:
                status, payload = http_call(self.base, "GET", "/api/health", timeout=2)
                if status == 200 and isinstance(payload, dict) and payload.get("ok"):
                    return
                last_error = "HTTP %s %r" % (status, payload)
            except CheckFailed as err:
                last_error = str(err)
            time.sleep(0.2)
        raise CheckFailed(
            "桥接服务 %.0f 秒内未就绪（最后一次：%s）\n%s"
            % (timeout, last_error, self.log_tail())
        )

    def log_tail(self, lines=40):
        if not self.log_path or not os.path.exists(self.log_path):
            return ""
        try:
            with open(self.log_path, "rb") as handle:
                raw = handle.read()
        except OSError:
            return ""
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            # 子进程若没按 UTF-8 输出（例如用户手动改过环境），退回系统编码
            try:
                text = raw.decode(sys.getfilesystemencoding(), "replace")
            except (LookupError, TypeError):
                text = raw.decode("latin-1", "replace")
        return "\n".join(text.splitlines()[-lines:])

    def stop(self):
        if self.proc is not None and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(5)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                try:
                    self.proc.wait(5)
                except subprocess.TimeoutExpired:
                    pass
        if self._log_handle is not None:
            try:
                self._log_handle.close()
            except OSError:
                pass
            self._log_handle = None
        if self.work_dir and not self.keep:
            shutil.rmtree(self.work_dir, ignore_errors=True)


# ---------------------------------------------------------------- 断言执行器


class Runner(object):
    def __init__(self, total):
        self.total = total
        self.passed = 0
        self.failures = []

    def check(self, label, func):
        started = time.time()
        try:
            detail = func()
        except CheckFailed as err:
            self.failures.append((label, str(err)))
            print("[FAIL] %s  (%.2fs)" % (label, time.time() - started))
            print("       → %s" % err)
            return
        except Exception as err:  # noqa: BLE001 - e2e 要把意外异常也报成失败
            self.failures.append((label, "%s: %s" % (type(err).__name__, err)))
            print("[FAIL] %s  (%.2fs) 意外异常" % (label, time.time() - started))
            print("       → %s: %s" % (type(err).__name__, err))
            traceback.print_exc()
            return
        self.passed += 1
        print("[PASS] %s  (%.2fs)" % (label, time.time() - started))
        if detail:
            print("       · %s" % detail)


# ---------------------------------------------------------------- e2e 场景


class E2E(object):
    def __init__(self, bridge, edit_timeout, lease_wait):
        self.bridge = bridge
        self.base = bridge.base
        self.edit_timeout = edit_timeout
        self.lease_wait = lease_wait
        self.jobs = []

    # ---------- 公共小工具 ----------

    def fetch_jobs(self):
        status, payload = http_call(self.base, "GET", "/api/jobs")
        need(
            status == 200,
            "GET /api/jobs 返回 HTTP %s：%r" % (status, payload),
        )
        need(
            isinstance(payload, dict) and isinstance(payload.get("jobs"), list),
            "GET /api/jobs 响应格式不对：%r" % (payload,),
        )
        return dict(
            (job.get("id"), job) for job in payload["jobs"] if isinstance(job, dict)
        )

    def fetch_job(self, job_id):
        status, payload = http_call(self.base, "GET", "/api/jobs/%s" % job_id)
        need(
            status == 200 and isinstance(payload, dict) and payload.get("id") == job_id,
            "GET /api/jobs/%s 异常：HTTP %s %r" % (job_id, status, payload),
        )
        return payload

    def status_map(self):
        jobs = self.fetch_jobs()
        return dict(
            (job_id, (jobs.get(job_id) or {}).get("status", "<missing>"))
            for job_id in self.jobs
        )

    def status_text(self, statuses=None):
        statuses = statuses or self.status_map()
        return ", ".join("%s=%s" % (job_id, statuses.get(job_id)) for job_id in self.jobs)

    # ---------- 1) 建 3 个 job + 上传 3 张不同尺寸 PNG → pending ----------

    def step_create_and_upload(self):
        created = []
        for index in range(3):
            width, height = SOURCE_SIZES[index]
            png = make_png(width, height, SOURCE_COLORS[index])
            meta = {
                "nodeName": "e2e-node-%d" % (index + 1),
                "targetName": "e2e-target-name-%d" % (index + 1),
                "targetId": "e2e-target-%d" % (index + 1),
                "imageWidth": width,
                "imageHeight": height,
                "fileKey": "e2e-test-file",
            }
            status, payload = http_call(self.base, "POST", "/api/jobs", json_body=meta)
            need(status == 200, "创建第 %d 个 job 失败：HTTP %s %r" % (index + 1, status, payload))
            need(
                isinstance(payload, dict) and isinstance(payload.get("id"), str),
                "创建 job 的响应没有 id：%r" % (payload,),
            )
            job_id = payload["id"]
            need(
                len(job_id) == 8 and all(ch in "0123456789abcdef" for ch in job_id),
                "job id 不是 8 位小写 hex：%r" % (job_id,),
            )
            status, payload = http_call(
                self.base, "PUT", "/api/jobs/%s/image" % job_id, body=png
            )
            need(
                status == 200,
                "第 %d 个 job 上传图片失败：HTTP %s %r" % (index + 1, status, payload),
            )
            created.append(job_id)

        self.jobs = created
        statuses = self.status_map()
        for job_id in created:
            need(
                statuses.get(job_id) == "pending",
                "上传后 job %s 状态应为 pending，实际 %r" % (job_id, statuses.get(job_id)),
            )
        return "3 个 job 全部 pending：%s（尺寸 %s）" % (
            ", ".join(created),
            " / ".join("%dx%d" % size for size in SOURCE_SIZES),
        )

    # ---------- 2) 连续 claim 3 个 → 3 个同时 editing ----------

    def step_claim_all(self):
        for job_id in self.jobs:
            status, payload = http_call(
                self.base, "POST", "/api/jobs/%s/claim" % job_id
            )
            need(status == 200, "claim job %s 失败：HTTP %s %r" % (job_id, status, payload))
            need(
                isinstance(payload, dict) and payload.get("status") == "editing",
                "claim job %s 后响应状态不是 editing：%r" % (job_id, payload),
            )
        statuses = self.status_map()
        for job_id in self.jobs:
            need(
                statuses.get(job_id) == "editing",
                "连续 claim 后 job %s 状态应为 editing（多 job 应可并行），实际 %r"
                % (job_id, statuses.get(job_id)),
            )
        return "3 个 job 同时 editing：%s" % self.status_text(statuses)

    # ---------- 8) /api/ps/pending 不再返回 busy ----------

    def step_pending_no_busy(self):
        status, payload = http_call(self.base, "GET", "/api/ps/pending")
        need(status == 200, "GET /api/ps/pending 返回 HTTP %s：%r" % (status, payload))
        need(isinstance(payload, dict), "GET /api/ps/pending 返回不是 JSON：%r" % (payload,))
        need(
            "busy" not in payload,
            "GET /api/ps/pending 仍带 busy 字段（全局 busy 未删除）：%r" % (payload,),
        )
        detail = "响应键：%s" % (", ".join(sorted(payload)) or "<空>")
        if payload.get("job") is not None:
            job = payload["job"]
            detail += "；返回了 job=%s（status=%s）" % (
                job.get("id") if isinstance(job, dict) else job,
                job.get("status") if isinstance(job, dict) else "?",
            )
        return detail

    # ---------- 3) touch 续租 → 停止 touch → 租约释放回 pending ----------

    def step_lease_release(self):
        for job_id in self.jobs:
            status, payload = http_call(
                self.base, "POST", "/api/jobs/%s/touch" % job_id
            )
            need(status == 200, "touch job %s 失败：HTTP %s %r" % (job_id, status, payload))
            need(
                isinstance(payload, dict) and payload.get("status") == "editing",
                "touch job %s 后状态不是 editing：%r" % (job_id, payload),
            )
        statuses = self.status_map()
        for job_id in self.jobs:
            need(
                statuses.get(job_id) == "editing",
                "touch 续租后 job %s 应仍为 editing，实际 %r"
                % (job_id, statuses.get(job_id)),
            )

        started = time.time()
        deadline = started + self.lease_wait
        elapsed = None
        last = statuses
        while time.time() < deadline:
            last = self.status_map()
            if all(last.get(job_id) == "pending" for job_id in self.jobs):
                elapsed = time.time() - started
                break
            time.sleep(0.5)
        need(
            elapsed is not None,
            "停止 touch 后 %.0f 秒内租约没有释放回 pending（EDIT_TIMEOUT_SEC=%s）；当前状态：%s"
            % (self.lease_wait, self.edit_timeout, self.status_text(last)),
        )
        return "EDIT_TIMEOUT_SEC=%s，停 touch 后 %.1fs 三个 job 均释放回 pending" % (
            self.edit_timeout,
            elapsed,
        )

    # ---------- 4) PUT result → /api/jobs/watch 唤起并返回新状态 ----------

    def step_watch_wake(self):
        elapsed_list = []
        for index, job_id in enumerate(self.jobs):
            # 先夺回租约并刷新 lastTouch：即使上一步租约没释放，也不让扫描线程
            # 在 watch 等待期间把状态改掉、造成假唤醒
            status, payload = http_call(
                self.base, "POST", "/api/jobs/%s/claim" % job_id
            )
            need(
                status == 200,
                "watch 场景重新 claim job %s 失败：HTTP %s %r" % (job_id, status, payload),
            )
            job = self.fetch_job(job_id)
            previous_updated = job.get("updatedAt")
            holder = {}

            def watcher(target_id=job_id, box=holder):
                started = time.time()
                try:
                    box["result"] = http_call(
                        self.base,
                        "GET",
                        "/api/jobs/watch?ids=%s&wait=25" % target_id,
                        timeout=40,
                    )
                except Exception as err:  # noqa: BLE001 - 线程内错误带回主线程断言
                    box["error"] = err
                box["elapsed"] = time.time() - started

            thread = threading.Thread(target=watcher, daemon=True)
            started = time.time()
            thread.start()
            # 给 watch 一点时间进入服务端快照（快照之后再改 updatedAt 才能被唤醒）
            time.sleep(1.0)
            png = make_png(RESULT_SIZES[index][0], RESULT_SIZES[index][1], RESULT_COLORS[index])
            status, payload = http_call(
                self.base, "PUT", "/api/jobs/%s/result" % job_id, body=png
            )
            need(
                status == 200,
                "为 job %s 回传 result 失败：HTTP %s %r" % (job_id, status, payload),
            )
            thread.join(20)
            need(
                not thread.is_alive(),
                "job %s 回传后 /api/jobs/watch 20 秒仍未返回（长轮询没有唤醒）" % job_id,
            )
            need("error" not in holder, "job %s 的 watch 请求失败：%s" % (job_id, holder.get("error")))
            status, payload = holder.get("result", (0, None))
            need(status == 200, "job %s 的 watch 返回 HTTP %s：%r" % (job_id, status, payload))
            need(
                isinstance(payload, dict) and isinstance(payload.get("jobs"), list),
                "watch 响应格式不对（应为 {jobs:[...]}）：%r" % (payload,),
            )
            found = None
            for item in payload["jobs"]:
                if isinstance(item, dict) and item.get("id") == job_id:
                    found = item
                    break
            need(found is not None, "watch 响应里没有 job %s：%r" % (job_id, payload))
            need(
                found.get("status") == "ready",
                "watch 返回的 job %s 状态应为 ready，实际 %r" % (job_id, found.get("status")),
            )
            need(
                found.get("updatedAt") != previous_updated,
                "watch 返回的 job %s updatedAt 没变化（%r）" % (job_id, previous_updated),
            )
            elapsed = holder.get("elapsed", time.time() - started)
            need(
                elapsed < 20,
                "job %s 的 watch 用了 %.1f 秒才返回（应远小于 25 秒长轮询上限）"
                % (job_id, elapsed),
            )
            elapsed_list.append(elapsed)

        statuses = self.status_map()
        for job_id in self.jobs:
            need(
                statuses.get(job_id) == "ready",
                "三个 job 回传后状态应均为 ready，job %s 实际 %r"
                % (job_id, statuses.get(job_id)),
            )
        return "每次回传后 watch 均被唤起（耗时 %s 秒，均 < 25s 上限）；三个 job 均 ready" % (
            " / ".join("%.2f" % elapsed for elapsed in elapsed_list)
        )

    # ---------- 5) 正确 updatedAt 的 ack → done + 删除 result.png ----------

    def step_ack_done(self):
        job_id = self.jobs[0]
        job = self.fetch_job(job_id)
        need(
            job.get("status") == "ready",
            "ack 前 job %s 状态应为 ready，实际 %r" % (job_id, job.get("status")),
        )
        updated_at = job.get("updatedAt")
        need(isinstance(updated_at, (int, float)), "job %s 的 updatedAt 不是数值：%r" % (job_id, updated_at))
        path = self.bridge.result_file(job_id)
        need(os.path.exists(path), "ack 前 result.png 不存在：%s" % path)

        status, payload = http_call(
            self.base,
            "POST",
            "/api/jobs/%s/ack" % job_id,
            json_body={"updatedAt": updated_at},
        )
        need(status == 200, "ack job %s 失败：HTTP %s %r" % (job_id, status, payload))
        acked = extract_job(payload)
        need(
            acked is not None and acked.get("status") == "done",
            "正确 updatedAt 的 ack 后响应状态不是 done：HTTP %s %r" % (status, payload),
        )
        job = self.fetch_job(job_id)
        need(job.get("status") == "done", "ack 后 job %s 状态应为 done，实际 %r" % (job_id, job.get("status")))
        need(not job.get("hasResult"), "ack 后 job %s 的 hasResult 仍为 true" % job_id)
        need(not os.path.exists(path), "ack 后 result.png 仍在磁盘（没被删除）：%s" % path)
        result_status = get_result_status(self.base, job_id)
        need(
            result_status == 404,
            "ack 后 GET /api/jobs/%s/result 应 404（文件已删），实际 %s"
            % (job_id, result_status),
        )
        return "job %s：updatedAt=%d 的 ack → done，result.png 已删除（GET result=%s）" % (
            job_id,
            updated_at,
            result_status,
        )

    # ---------- 6) stale ack 回归：不删图、不改状态 ----------

    def step_stale_ack(self):
        job_id = self.jobs[1]
        job = self.fetch_job(job_id)
        need(
            job.get("status") == "ready",
            "stale ack 前 job %s 状态应为 ready，实际 %r" % (job_id, job.get("status")),
        )
        stale_updated = job.get("updatedAt")
        need(
            isinstance(stale_updated, (int, float)),
            "job %s 的 updatedAt 不是数值：%r" % (job_id, stale_updated),
        )
        path = self.bridge.result_file(job_id)
        need(os.path.exists(path), "stale ack 前 result.png 不存在：%s" % path)

        # 模拟 PS 又贴了一版：再 PUT 一次 result，updatedAt 前移，旧 ack 变 stale
        time.sleep(1.1)
        png = make_png(180, 120, RESULT_COLORS[1])
        status, payload = http_call(
            self.base, "PUT", "/api/jobs/%s/result" % job_id, body=png
        )
        need(
            status == 200,
            "为 stale 场景重新回传 result 失败：HTTP %s %r" % (status, payload),
        )
        job_after_put = self.fetch_job(job_id)
        need(
            job_after_put.get("updatedAt") != stale_updated,
            "重新回传后 updatedAt 未变化（%r），无法构造 stale 场景" % (stale_updated,),
        )
        need(
            job_after_put.get("status") == "ready",
            "重新回传后 job %s 状态应为 ready，实际 %r"
            % (job_id, job_after_put.get("status")),
        )

        status, payload = http_call(
            self.base,
            "POST",
            "/api/jobs/%s/ack" % job_id,
            json_body={"updatedAt": stale_updated},
        )
        need(status == 200, "stale ack 返回 HTTP %s（应仍为 200）：%r" % (status, payload))
        need(isinstance(payload, dict), "stale ack 返回不是 JSON：%r" % (payload,))
        need(
            payload.get("ok") is False,
            "stale ack 未返回 ok:false（丢图缺陷回归）：%r" % (payload,),
        )
        need(
            payload.get("stale") is True,
            "stale ack 未返回 stale:true（丢图缺陷回归）：%r" % (payload,),
        )
        embedded = payload.get("job")
        if isinstance(embedded, dict):
            need(
                embedded.get("status") == "ready",
                "stale ack 响应里的 job 状态应为 ready，实际 %r" % (embedded.get("status"),),
            )

        job_now = self.fetch_job(job_id)
        need(
            job_now.get("status") == "ready",
            "stale ack 后 job %s 状态应保持 ready，实际 %r"
            % (job_id, job_now.get("status")),
        )
        need(
            job_now.get("updatedAt") == job_after_put.get("updatedAt"),
            "stale ack 不应改动 updatedAt：%r → %r"
            % (job_after_put.get("updatedAt"), job_now.get("updatedAt")),
        )
        need(os.path.exists(path), "stale ack 把 result.png 删掉了（丢图回归）：%s" % path)
        result_status = get_result_status(self.base, job_id)
        need(
            result_status == 200,
            "stale ack 后 GET /api/jobs/%s/result 应仍为 200（图还在），实际 %s"
            % (job_id, result_status),
        )
        return "job %s：旧 updatedAt=%d 的 ack 被拒（ok:false/stale:true），状态仍 ready，result.png 仍在" % (
            job_id,
            stale_updated,
        )

    # ---------- 7) 心跳 → psOnline true；停 8 秒后 false ----------

    def step_heartbeat_offline(self):
        status, payload = http_call(self.base, "POST", "/api/ps/heartbeat", json_body={})
        need(status == 200, "POST /api/ps/heartbeat 失败：HTTP %s %r" % (status, payload))
        need(
            isinstance(payload, dict) and payload.get("psOnline") is True,
            "heartbeat 响应 psOnline 应为 true：%r" % (payload,),
        )

        status, health = http_call(self.base, "GET", "/api/health")
        need(status == 200 and isinstance(health, dict), "GET /api/health 异常：HTTP %s %r" % (status, health))
        need(
            health.get("psOnline") is True,
            "心跳后 /api/health 的 psOnline 应为 true：%r" % (health,),
        )

        # PS_ONLINE_WINDOW = 8 秒；这里期间不再发任何请求，避免别的接口顺手刷新心跳
        deadline = time.time() + 12
        last = health
        while time.time() < deadline:
            status, last = http_call(self.base, "GET", "/api/health", timeout=5)
            if isinstance(last, dict) and last.get("psOnline") is False:
                break
            time.sleep(0.5)
        need(
            isinstance(last, dict) and last.get("psOnline") is False,
            "停止心跳 12 秒后 /api/health 的 psOnline 仍为 true（窗口应为 8 秒）：%r"
            % (last,),
        )
        return "heartbeat 后 psOnline=true，停止心跳 8 秒后变为 false"


# ---------------------------------------------------------------- main


def parse_args(argv):
    parser = argparse.ArgumentParser(
        description="多文档并行 e2e 验收（自动拉起 bridge/server.py，模拟 Figma + PS）"
    )
    parser.add_argument(
        "--port",
        type=int,
        default=0,
        help="桥接服务端口；0（默认）自动挑一个空闲端口",
    )
    parser.add_argument(
        "--server",
        default=DEFAULT_SERVER,
        help="bridge/server.py 路径（默认 %(default)s）",
    )
    parser.add_argument(
        "--edit-timeout",
        type=int,
        default=2,
        help="传给子进程的 EDIT_TIMEOUT_SEC（默认 2 秒，便于观察租约释放）",
    )
    parser.add_argument(
        "--lease-wait",
        type=float,
        default=None,
        help="等待租约释放的最长秒数（默认按扫描周期取 30 秒）",
    )
    parser.add_argument(
        "--no-isolate",
        action="store_true",
        help="不复制 server.py，直接就地运行（会写入 bridge/.data）",
    )
    parser.add_argument(
        "--keep",
        action="store_true",
        help="保留临时目录与 server.log 便于排查",
    )
    return parser.parse_args(argv)


def _force_utf8_output():
    """Windows 控制台/重定向下统一用 UTF-8，避免中文断言信息变成乱码。"""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass


def main(argv=None):
    _force_utf8_output()
    args = parse_args(argv)
    if args.edit_timeout < 1:
        print("[FATAL] --edit-timeout 至少为 1 秒")
        return 1
    lease_wait = args.lease_wait
    if lease_wait is None:
        # 规格里租约扫描线程每 15 秒跑一次，默认等到 30 秒足够
        lease_wait = 30.0 if args.edit_timeout <= 15 else min(args.edit_timeout + 20.0, 120.0)

    port = args.port or find_free_port()
    if args.port and not port_is_free(port):
        print("[FATAL] 端口 %d 已被占用，请换一个 --port 或让脚本自动挑选" % port)
        return 1

    print("=" * 78)
    print("多文档并行 e2e 验收（docs/multi-doc-spec.md 第 8 章 B2）")
    print("server    : %s" % os.path.abspath(args.server))
    print("port      : %d%s" % (port, "（自动）" if not args.port else ""))
    print("隔离运行  : %s" % ("是（临时目录）" if not args.no_isolate else "否（就地运行）"))
    print("EDIT_TIMEOUT_SEC=%s，租约等待上限 %.0fs" % (args.edit_timeout, lease_wait))
    print("=" * 78)

    bridge = Bridge(
        server_path=args.server,
        port=port,
        edit_timeout=args.edit_timeout,
        isolate=not args.no_isolate,
        keep=args.keep,
    )
    e2e = E2E(bridge, args.edit_timeout, lease_wait)
    cases = [
        ("建 3 个 job → 上传 3 张不同尺寸 PNG → 全部 pending", e2e.step_create_and_upload),
        ("连续 claim 3 个 → 3 个同时 editing（无全局 busy）", e2e.step_claim_all),
        ("GET /api/ps/pending 响应不含 busy 字段", e2e.step_pending_no_busy),
        ("touch 续租 → 停止 touch 后租约释放回 pending", e2e.step_lease_release),
        ("PUT result → /api/jobs/watch 被唤起并返回新状态", e2e.step_watch_wake),
        ("正确 updatedAt 的 ack → done 且 result.png 被删除", e2e.step_ack_done),
        ("错误 updatedAt 的 stale ack → ok:false/stale:true 且 result.png 仍在", e2e.step_stale_ack),
        ("心跳后 psOnline=true；停止心跳 8 秒后 false", e2e.step_heartbeat_offline),
    ]
    runner = Runner(len(cases))
    fatal = None
    try:
        bridge.start()
        print(
            "桥接服务已就绪：pid=%s，%s\n"
            % (bridge.proc.pid if bridge.proc else "?", bridge.base)
        )
        for label, func in cases:
            runner.check(label, func)
    except CheckFailed as err:
        fatal = err
        print("\n[FATAL] %s" % err)
    except Exception as err:  # noqa: BLE001
        fatal = err
        print("\n[FATAL] %s: %s" % (type(err).__name__, err))
        traceback.print_exc()
    finally:
        if runner.failures or fatal is not None:
            tail = bridge.log_tail()
            if tail:
                print("\n---- bridge/server.py 日志（末尾）----")
                print(tail)
                print("-" * 40)
        if bridge.keep:
            print("临时目录保留：%s" % bridge.work_dir)
        bridge.stop()

    print("\n" + "=" * 78)
    if runner.failures:
        print("结果：%d/%d 通过，%d 条断言失败" % (runner.passed, runner.total, len(runner.failures)))
        for label, reason in runner.failures:
            print("  ✗ %s\n    %s" % (label, reason))
    else:
        print("结果：%d/%d 全部通过" % (runner.passed, runner.total))
    print("=" * 78)

    if fatal is not None:
        print("[FATAL] e2e 无法继续执行：%s" % fatal)
        return 1
    return 0 if not runner.failures else 1


if __name__ == "__main__":
    sys.exit(main())
