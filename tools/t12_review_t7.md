# t12 评审记录：t7（D1 GC 孤儿清理与 create_job 竞态）

评审对象：`bridge/server.py`（23:04:23，893 行；D1 改动由 t7 完成）
评审时间：2026-10-23 · 评审者：verifier（独立于 t7 实现者）
结论：**verdict = pass**（无 findings）

## 1. 逐条核对

### 1.1 孤儿目录清理在 JOBS_LOCK 内复查（评审点 1）
- `server.py:427-445`：先 `os.listdir(DATA_DIR)` 拿目录名，逐个校验 8hex、目录、mtime；然后 `with JOBS_LOCK:`（:440）内部 `if name in JOBS: continue`（:442），确认仍无记录才 `shutil.rmtree`（:444）。
- 不再使用扫描时的 `known` 快照：`grep -n '\bknown\b' bridge/server.py` 无任何命中。
- TTL 删除也改为在同一把锁内摘记录 + 删目录（`server.py:407-420`），避免「记录已摘、目录未删」窗口被同 id 复用。
- 实证：新增复现脚本 `tools/t12_d1_concurrency.py` 在 GC 的 `os.listdir` 返回后、进入 `JOBS_LOCK` 前注入「登记一个 11 分钟旧目录的 job」（:219-245 的 hooked listdir），修复后的代码保留目录与记录；移除记录后再次 `gc_once()` 才删除。若仍是旧 `known` 快照逻辑，该目录会被删——本次实测 PASS。

### 1.2 mtime 10 分钟保护（评审点 2）
- `server.py:65`：`GC_ORPHAN_MIN_AGE_SEC = 10 * 60`。
- `server.py:435-437`：`if time.time() - os.path.getmtime(path) <= GC_ORPHAN_MIN_AGE_SEC: continue`，且 `getmtime` 异常走 `except OSError: continue`（:438-439）。
- 实证：脚本阶段 2 创建两个无主目录——11 分钟前的被删除、刚创建的保留；有 job 记录的旧目录因锁内复查而保留。

### 1.3 create_job 的登记/建目录顺序（评审点 3）
- `server.py:375-385`：进入 `JOBS_LOCK` 后先 `JOBS[job_id] = job`（:378），再 `os.makedirs(job_dir(...), exist_ok=True)`（:380）；建目录失败 `JOBS.pop` 后重抛（:381-383），最后 `save_jobs_locked()`（:384）。「目录已建、表未登记」窗口已消除。
- 即使发生极端交错，GC 侧仍有双重保护：先 mtime（<10 分钟不碰），再锁内 `name in JOBS` 复查；两者串行于同一把锁，因此新目录不会被当作孤儿删除。

### 1.4 并发复现（评审点 4）
新增脚本：`figma-ps-bridge/tools/t12_d1_concurrency.py`（纯标准库；把 server.py 复制到临时目录后导入并起真实 `BridgeServer`/`Handler`，不写仓库 `.data`）。

- 用法：`py tools/t12_d1_concurrency.py`（默认 `../bridge/server.py`，4 线程 ×30 job，2 个 GC 线程每 1ms 扫描）。
- 实测（figma-ps-bridge 目录与 repo 根各跑一次，均 exit 0）：
  - **并发阶段**：`120 job / 120 source.png / 0 错误 / 0 丢目录`；期间 2 个 GC 线程每 1ms 调 `gc_once()`，无任何 `PUT image 500`。
  - mtime 保护 + 有记录旧目录保留：PASS。
  - `listdir` 之后才登记 job 的精确交错：PASS（目录保留，移除记录后删除）。
  - GC TTL 与 jobs.json（version=2）持久化：PASS。
  - 结果：`==== D1 并发复现：4/4 通过 ====`。

### 1.5 其他验收命令
- `py -m py_compile bridge/server.py` → exit 0。
- `py figma-ps-bridge/tools/e2e_multi.py --port 18765` → **8/8 PASS，exit 0**（多文档并行全流程无回归）。

### 1.6 改动范围（评审点 5）
- D1 专属符号/逻辑（`GC_ORPHAN_MIN_AGE_SEC`、`gc_once`、孤儿扫描）只在 `bridge/server.py`（grep 结果仅该文件命中）。
- 当前工作区还有 `README.md`（t6）、`figma-plugin/*`（t2+t9）、`ps-cep/*`（t3+t8）等改动，均可对应其它任务记录，与 D1 无关；本次未发现 t7 顺手改其它文件的痕迹。
- 说明：工作区未提交，无法按 commit 隔离单任务作者；以上基于任务记录 + 符号/文件交叉核对。

## 2. 评审结论
t7 对 D1 的修复按验收要求落实：锁内二次复查、10 分钟 mtime 保护、create_job「先登记后建目录」同锁执行；新增脚本在持续创建 job + 高频 GC 下 0 次 PUT image 500、0 目录丢失，并精确覆盖「扫描后才登记」的交错。**verdict = pass**，无 findings。

### 非阻断观察（不影响判定）
1. `server.py:63` 的注释仍写「create_job 是『登记 + 建目录』两步」，但修复后两步已在同一把锁内串行；建议后续改注释为「历史窗口已消除，mtime 保护用于兜底」。纯文档问题。
2. `gc_once` 的孤儿 `rmtree` 在 `JOBS_LOCK` 内执行（为保证复查原子性），若孤儿目录很大可能短暂阻塞其它请求；孤儿目录通常只有少量图片，可接受，必要时可改为锁内标记 + 锁外删除（需额外状态，当前不必要）。
3. `orphans += 1` 在 `rmtree(ignore_errors=True)` 之后无条件累加，删除失败时日志计数可能偏大；仅日志语义，不影响安全。
