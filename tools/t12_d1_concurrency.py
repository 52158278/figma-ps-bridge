#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""D1 竞态复现脚本（t12 评审用，纯标准库）。

在持续创建 job（POST /api/jobs + PUT image）的同时高频触发 GC 扫描，
验证 bridge/server.py 的修复确实不会把新任务目录当孤儿删掉，也不会出现
PUT image 500；并额外验证「mtime 10 分钟保护」「锁内二次复查」「TTL 正常」。

用法：
    py tools/t12_d1_concurrency.py
    py tools/t12_d1_concurrency.py --server ../bridge/server.py --workers 4 --jobs-per-worker 30
    py tools/t12_d1_concurrency.py --gc-interval-ms 1 --keep

脚本会把 server.py 复制到系统临时目录再导入/启动，不会写入仓库的
bridge/.data；退出码 0=全部通过，1=有失败。
"""

import argparse
import http.client
import importlib.util
import json
import os
import shutil
import struct
import sys
import tempfile
import threading
import time
import zlib

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except (AttributeError, ValueError):
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_SERVER = os.path.join(os.path.dirname(HERE), "bridge", "server.py")


def make_png(width=8, height=8, color=(1, 2, 3)):
    def chunk(tag, payload):
        return (
            struct.pack(">I", len(payload))
            + tag
            + payload
            + struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF)
        )

    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    row = b"\x00" + bytes(color) * width
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(row * height, 9))
        + chunk(b"IEND", b"")
    )


def fake_job(job_id):
    stamp = int(time.time() * 1000)
    return {
        "id": job_id,
        "status": "pending",
        "createdAt": stamp,
        "updatedAt": stamp,
        "lastTouch": stamp,
        "meta": {},
        "hasSource": False,
        "hasResult": False,
        "error": None,
    }


def http_call(port, method, path, body=None, content_type=None):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=15)
    try:
        headers = {}
        if body is not None and content_type:
            headers["Content-Type"] = content_type
        conn.request(method, path, body=body, headers=headers)
        response = conn.getresponse()
        return response.status, response.read()
    finally:
        conn.close()


class Checker(object):
    def __init__(self):
        self.rows = []

    def check(self, name, fn):
        try:
            detail = fn() or ""
            self.rows.append((True, name, detail))
            print("[PASS] %s%s" % (name, ("  · " + detail) if detail else ""))
        except AssertionError as err:
            self.rows.append((False, name, str(err)))
            print("[FAIL] %s\n       -> %s" % (name, err))
        except Exception as err:  # noqa: BLE001
            self.rows.append((False, name, "%s: %s" % (type(err).__name__, err)))
            print("[FAIL] %s\n       -> %s: %s" % (name, type(err).__name__, err))

    @property
    def failed(self):
        return [row for row in self.rows if not row[0]]


def main(argv=None):
    parser = argparse.ArgumentParser(description="D1 GC 竞态并发复现（只读使用 server.py）")
    parser.add_argument("--server", default=DEFAULT_SERVER, help="bridge/server.py 路径")
    parser.add_argument("--workers", type=int, default=4, help="并发创建线程数")
    parser.add_argument("--jobs-per-worker", type=int, default=30, help="每线程创建 job 数")
    parser.add_argument("--gc-threads", type=int, default=2, help="并发 GC 线程数")
    parser.add_argument("--gc-interval-ms", type=float, default=1.0, help="GC 扫描间隔毫秒")
    parser.add_argument("--keep", action="store_true", help="保留临时目录便于排查")
    args = parser.parse_args(argv)

    server_src = os.path.abspath(args.server)
    if not os.path.isfile(server_src):
        print("[FATAL] 找不到 server.py：%s" % server_src)
        return 1

    work_dir = tempfile.mkdtemp(prefix="d1-concurrency-")
    bridge_dir = os.path.join(work_dir, "bridge")
    os.makedirs(bridge_dir)
    server_copy = os.path.join(bridge_dir, "server.py")
    shutil.copy2(server_src, server_copy)

    spec = importlib.util.spec_from_file_location("srv_d1_concurrency", server_copy)
    srv = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(srv)
    data_dir = srv.DATA_DIR

    server = srv.BridgeServer(("127.0.0.1", 0), srv.Handler)
    port = server.server_address[1]
    srv.PORT = port
    threading.Thread(target=server.serve_forever, daemon=True).start()

    checker = Checker()
    errors = []
    created = []
    created_lock = threading.Lock()
    stop = threading.Event()
    expected = args.workers * args.jobs_per_worker
    image = make_png()

    def creator():
        for _ in range(args.jobs_per_worker):
            try:
                status, raw = http_call(port, "POST", "/api/jobs", json.dumps({"nodeName": "d1-probe"}).encode(), "application/json")
                if status != 200:
                    errors.append("POST /api/jobs -> %s %r" % (status, raw[:120]))
                    continue
                job_id = json.loads(raw.decode("utf-8"))["id"]
                status, raw = http_call(port, "PUT", "/api/jobs/%s/image" % job_id, image, "image/png")
                if status != 200:
                    errors.append("PUT image %s -> %s %r" % (job_id, status, raw[:160]))
                    continue
                with created_lock:
                    created.append(job_id)
            except Exception as err:  # noqa: BLE001
                errors.append("%s: %s" % (type(err).__name__, err))

    def gc_worker():
        while not stop.is_set():
            try:
                srv.gc_once()
            except Exception as err:  # noqa: BLE001
                errors.append("gc: %s" % err)
            time.sleep(max(0.0, args.gc_interval_ms / 1000.0))

    gc_threads = [threading.Thread(target=gc_worker) for _ in range(args.gc_threads)]
    workers = [threading.Thread(target=creator) for _ in range(args.workers)]
    for thread in gc_threads:
        thread.start()
    for thread in workers:
        thread.start()
    for thread in workers:
        thread.join()
    stop.set()
    for thread in gc_threads:
        thread.join()

    def check_concurrency():
        assert not errors, "并发期间出现 %d 个错误：%r" % (len(errors), errors[:5])
        assert len(created) == expected, "应创建 %d 个 job，实际 %d" % (expected, len(created))
        missing_dir = [job for job in created if not os.path.isdir(srv.job_dir(job))]
        missing_src = [job for job in created if not os.path.exists(srv.source_path(job))]
        missing_job = [job for job in created if job not in srv.JOBS]
        assert not missing_dir, "%d 个新任务目录被 GC 删掉：%s" % (len(missing_dir), missing_dir[:3])
        assert not missing_src, "%d 个 source.png 丢失：%s" % (len(missing_src), missing_src[:3])
        assert not missing_job, "%d 个 job 记录丢失：%s" % (len(missing_job), missing_job[:3])
        return "%d job / %d source.png / 0 错误 / 0 丢目录（GC 线程 %d 个，间隔 %.1fms）" % (
            len(created), len(created), args.gc_threads, args.gc_interval_ms
        )

    checker.check("并发创建 job + 高频 GC 扫描：无 500、无丢目录/丢图", check_concurrency)

    # mtime 保护 + 锁内复查
    old_orphan = os.path.join(data_dir, "aaaaaaaa")
    os.makedirs(old_orphan, exist_ok=True)
    stamp = time.time() - 11 * 60
    os.utime(old_orphan, (stamp, stamp))
    fresh_orphan = os.path.join(data_dir, "bbbbbbbb")
    os.makedirs(fresh_orphan, exist_ok=True)
    registered = srv.create_job({"nodeName": "registered-old-dir"})
    os.utime(srv.job_dir(registered["id"]), (stamp, stamp))
    srv.gc_once()

    def check_mtime_and_recheck():
        assert not os.path.exists(old_orphan), "11 分钟前的无主目录应被删除"
        assert os.path.exists(fresh_orphan), "刚创建的无主目录不应被删除（10 分钟保护）"
        assert os.path.isdir(srv.job_dir(registered["id"])), "有 job 记录的旧目录被误删（锁内复查失效）"
        assert registered["id"] in srv.JOBS, "有记录的 job 被误删"
        return "旧孤儿删除 / 新孤儿保留 / 有记录旧目录保留"

    checker.check("mtime 10 分钟保护 + 锁内复查有记录目录", check_mtime_and_recheck)

    # 精确复现「GC 已 listdir，之后才登记 job」：挂钩 listdir 注入登记
    injected_id = "dddddddd"
    injected_dir = os.path.join(data_dir, injected_id)
    os.makedirs(injected_dir, exist_ok=True)
    os.utime(injected_dir, (stamp, stamp))
    injected = {"done": False}
    original_listdir = os.listdir

    def hooked_listdir(path):
        names = original_listdir(path)
        try:
            if not injected["done"] and os.path.abspath(path) == os.path.abspath(data_dir):
                injected["done"] = True
                with srv.JOBS_LOCK:
                    srv.JOBS[injected_id] = fake_job(injected_id)
        except Exception as err:  # noqa: BLE001
            errors.append("hook: %s" % err)
        return names

    os.listdir = hooked_listdir
    try:
        srv.gc_once()
    finally:
        os.listdir = original_listdir

    def check_scan_after_register():
        assert injected["done"], "测试钩子没有生效"
        assert os.path.exists(injected_dir), "扫描后才登记 job 的旧目录被误删（旧 known 快照缺陷回归）"
        assert injected_id in srv.JOBS, "扫描后登记的 job 记录丢失"
        with srv.JOBS_LOCK:
            srv.JOBS.pop(injected_id, None)
        srv.gc_once()
        assert not os.path.exists(injected_dir), "移除记录后旧孤儿目录应被删除"
        return "扫描后登记 → 目录保留；移除记录后才删除"

    checker.check("listdir 之后才登记 job：锁内二次复查找回目录", check_scan_after_register)

    # TTL 行为与持久化
    ttl_job = srv.create_job({"nodeName": "ttl"})
    with srv.JOBS_LOCK:
        ttl_job["status"] = "done"
        ttl_job["updatedAt"] = int((time.time() - 31 * 24 * 3600) * 1000)
        srv.save_jobs_locked()
    srv.gc_once()

    def check_ttl():
        assert ttl_job["id"] not in srv.JOBS, "过期 done 记录应被 GC 删除"
        assert not os.path.exists(srv.job_dir(ttl_job["id"])), "过期 job 目录应被删除"
        with open(srv.JOBS_FILE, "r", encoding="utf-8") as handle:
            payload = json.load(handle)
        assert payload.get("version") == 2, "jobs.json version 不是 2"
        return "过期 done 记录+目录删除；jobs.json 可解析（version=2）"

    checker.check("GC TTL 与 jobs.json 持久化未受影响", check_ttl)

    server.shutdown()
    server.server_close()

    failed = checker.failed
    print("\n==== D1 并发复现：%d/%d 通过 ====" % (len(checker.rows) - len(failed), len(checker.rows)))
    for _, name, detail in failed:
        print("  FAIL %s -> %s" % (name, detail))
    if args.keep:
        print("临时目录保留：%s" % work_dir)
    else:
        shutil.rmtree(work_dir, ignore_errors=True)
    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())
