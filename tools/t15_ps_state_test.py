"""t15：PS 现场状态（v0.3.0）回归测试。

验证 bridge 的 /api/ps/heartbeat 上报、health/watch 透传，以及「PS 状态变化唤醒长轮询」。

用法：py tools/t15_ps_state_test.py [--port 18767]
退出码 0 = 全过。
"""

import argparse
import http.client
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SERVER = os.path.join(REPO, "bridge", "server.py")


class Bridge:
    def __init__(self, port):
        self.port = port
        self.proc = None
        self.workdir = None

    def start(self):
        self.workdir = tempfile.mkdtemp(prefix="psbridge-t15-")
        target = os.path.join(self.workdir, "server.py")
        shutil.copy(SERVER, target)
        env = dict(os.environ)
        env["PYTHONIOENCODING"] = "utf-8"
        env["PORT"] = str(self.port)  # 必须指定，否则它会自己去抢 8765（可能被别的服务占着）
        self.logpath = os.path.join(self.workdir, "server.log")
        self.logfile = open(self.logpath, "w", encoding="utf-8")
        self.proc = subprocess.Popen(
            [sys.executable, target],
            cwd=self.workdir,
            env=env,
            stdout=self.logfile,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        for _ in range(100):
            try:
                self.get("/api/health", timeout=2)
                return
            except Exception:
                time.sleep(0.1)
        raise RuntimeError("桥接服务没能启动：\n" + self.read_log())

    def read_log(self):
        try:
            self.logfile.flush()
            with open(self.logpath, encoding="utf-8", errors="replace") as fh:
                return fh.read()[-2000:]
        except Exception:
            return "(读不到日志)"

    def stop(self):
        if self.proc:
            self.proc.kill()
            self.proc.wait(timeout=5)
        try:
            self.logfile.close()
        except Exception:
            pass
        if self.workdir:
            shutil.rmtree(self.workdir, ignore_errors=True)

    def request(self, method, path, body=None, ctype="application/json", timeout=40):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=timeout)
        data = None
        headers = {}
        if body is not None:
            if isinstance(body, (bytes, bytearray)):
                data = bytes(body)
                headers["Content-Type"] = ctype
            else:
                data = json.dumps(body).encode("utf-8")
                headers["Content-Type"] = ctype
        try:
            conn.request(method, path, body=data, headers=headers)
            resp = conn.getresponse()
            raw = resp.read()
            return resp.status, raw
        finally:
            conn.close()

    def get(self, path, timeout=40):
        status, raw = self.request("GET", path, timeout=timeout)
        return status, json.loads(raw.decode("utf-8") or "{}")

    def post(self, path, body=None):
        status, raw = self.request("POST", path, body if body is not None else {})
        text = raw.decode("utf-8") or "{}"
        return status, json.loads(text)

    def put_image(self, job_id):
        png = b"\x89PNG\r\n\x1a\n" + b"t15" * 4
        status, raw = self.request("PUT", "/api/jobs/%s/image" % job_id, body=png, ctype="image/png")
        return status


RESULTS = []


def check(name, ok, detail=""):
    RESULTS.append((name, ok, detail))
    print(("[PASS] " if ok else "[FAIL] ") + name + (("\n         · " + detail) if detail else ""))


def free_port(start=18767):
    port = start
    while port < start + 50:
        with socket.socket() as s:
            try:
                s.bind(("127.0.0.1", port))
                return port
            except OSError:
                port += 1
    raise RuntimeError("找不到空闲端口")


def make_job(bridge, name):
    status, created = bridge.post("/api/jobs", {"targetName": name, "client": "test"})
    job_id = created["id"]
    bridge.put_image(job_id)
    return job_id


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=0)
    args = parser.parse_args()

    port = args.port or free_port()
    bridge = Bridge(port)
    bridge.start()
    try:
        job_a = make_job(bridge, "A")
        job_b = make_job(bridge, "B")

        # 1) 上报 PS 现场状态 → health 里能读到
        st, hb = bridge.post("/api/ps/heartbeat", {"activeJobId": job_a, "openJobIds": [job_a, job_b]})
        check("heartbeat 接受 activeJobId/openJobIds", st == 200 and hb.get("ok") is True)
        st, health = bridge.get("/api/health")
        ps = health.get("ps") or {}
        check("health 透传 ps.activeJobId", ps.get("activeJobId") == job_a,
              "activeJobId=%r" % ps.get("activeJobId"))
        check("health 透传 ps.openJobIds", sorted(ps.get("openJobIds") or []) == sorted([job_a, job_b]),
              "openJobIds=%r" % (ps.get("openJobIds"),))
        check("health 的 ps.online 为 true", ps.get("online") is True)

        # 2) 长轮询会被 PS 状态变化唤醒（不是只等 job.updatedAt）
        woke = {"at": None}

        def watch():
            t0 = time.time()
            try:
                bridge.get("/api/jobs/watch?ids=%s&wait=25" % job_a)
            except Exception:
                return
            woke["at"] = time.time() - t0

        th = threading.Thread(target=watch, daemon=True)
        th.start()
        time.sleep(0.8)  # 让 watch 先挂上
        bridge.post("/api/ps/heartbeat", {"activeJobId": job_b, "openJobIds": [job_a, job_b]})
        th.join(timeout=10)
        elapsed = woke["at"]
        check("PS 切换活动文档会唤醒 watch（不等满 25 秒）",
              elapsed is not None and elapsed < 5, "watch 返回耗时 %r 秒" % elapsed)

        # 3) 心跳里重复同一个状态不应该反复唤醒（避免热循环）
        woke2 = {"count": 0}

        def watch2():
            t0 = time.time()
            try:
                bridge.get("/api/jobs/watch?ids=%s&wait=6" % job_a)
            except Exception:
                return
            woke2["count"] = time.time() - t0

        th2 = threading.Thread(target=watch2, daemon=True)
        th2.start()
        time.sleep(0.5)
        for _ in range(3):
            bridge.post("/api/ps/heartbeat", {"activeJobId": job_b, "openJobIds": [job_a, job_b]})
            time.sleep(0.2)
        th2.join(timeout=15)
        check("状态没变的重复心跳不会提前唤醒 watch", woke2["count"] >= 5.5,
              "watch 返回耗时 %.1f 秒（应接近 6）" % woke2["count"])

        # 4) 未知 jobId 会被过滤掉
        bridge.post("/api/ps/heartbeat", {"activeJobId": "deadbeef", "openJobIds": ["deadbeef", job_a]})
        st, health = bridge.get("/api/health")
        ps = health.get("ps") or {}
        check("未知 jobId 被过滤", ps.get("activeJobId") is None and ps.get("openJobIds") == [job_a],
              "ps=%r" % (ps,))

        # 5) 心跳停止 → 离线后不再暴露过期的 activeJobId
        bridge.post("/api/ps/heartbeat", {"activeJobId": job_a, "openJobIds": [job_a]})
        time.sleep(8.5)
        st, health = bridge.get("/api/health")
        ps = health.get("ps") or {}
        check("心跳超时后 ps.online=false 且不暴露 activeJobId",
              ps.get("online") is False and ps.get("activeJobId") is None, "ps=%r" % (ps,))

        # 6) 旧客户端（心跳不带 body）仍然可用
        st, hb = bridge.post("/api/ps/heartbeat", {})
        check("心跳不带状态字段仍返回 200", st == 200 and hb.get("ok") is True)

        # 7) 已有实例在跑时，第二次启动必须直接退出（防止双击两次起两个服务）
        env2 = dict(os.environ)
        env2["PORT"] = str(port)
        env2["PYTHONIOENCODING"] = "utf-8"
        dup = subprocess.run(
            [sys.executable, os.path.join(bridge.workdir, "server.py")],
            cwd=bridge.workdir,
            env=env2,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=15,
        )
        out = (dup.stdout or "") + (dup.stderr or "")
        check(
            "已有实例时拒绝重复启动",
            dup.returncode == 0 and "已经有一个桥接服务在运行" in out,
            "returncode=%s out=%r" % (dup.returncode, out.strip()[:80]),
        )
    finally:
        bridge.stop()

    failed = [r for r in RESULTS if not r[1]]
    print("\n" + "=" * 42)
    print("结果：%d/%d 通过" % (len(RESULTS) - len(failed), len(RESULTS)))
    print("=" * 42)
    if failed:
        for name, _, detail in failed:
            print(" - " + name + ((" （" + detail + "）") if detail else ""))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
