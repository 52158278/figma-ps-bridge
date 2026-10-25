# t11 评审记录：t9（D4 容器降级 + 有限重试、D6 registryReady 超时）

评审对象：`figma-plugin/code.js`（23:04:10）、`figma-plugin/ui.html`（23:04:33）
评审时间：2026-10-23 · 评审者：verifier（独立于 t9 实现者）
结论：**verdict = pass**（无 needs_revision findings）

## 1. 逐条核对

### 1.1 code.js：CONTAINER_TYPES 与 containerFor（D4）
- `code.js:20`：`CONTAINER_TYPES = ['PAGE', 'FRAME', 'GROUP', 'SECTION']` —— 不含 COMPONENT / COMPONENT_SET / INSTANCE / BOOLEAN_OPERATION，符合本次评审口径。
- `code.js:509-520` `containerFor(target)`：
  - 父级类型在允许列表 → 使用父容器；PAGE 原点 `0,0`，其余容器取 `parent.absoluteBoundingBox` 的 x/y 作为容器原点（:511-515）。
  - 父级不在允许列表（COMPONENT_SET / BOOLEAN_OPERATION / INSTANCE / 其他）→ `(target && pageOf(target)) || figma.currentPage`，原点 `0,0`（:516-519），确实降级到 **target 所在 PAGE**。
  - target 为 null（已删除 / 无 targetId）→ `figma.currentPage`（同一分支），无页可归属时这是合理兜底。
- `code.js:449-506` `createFallbackLayer`：先切到 target 所在页面（:451-456），`box = target.absoluteBoundingBox`（:465），降级到 PAGE 后 `rect.x = box.x - 0 + box.width + 40`、`rect.y = box.y`（:487-494），仍然使用页面绝对坐标；box 不存在时才用视口中心（:490-493）。
- 独立 mock（Node vm + fake figma，5/5 通过）验证：
  - PAGE/FRAME/GROUP/SECTION 4 种父级均保留父容器；
  - COMPONENT_SET/COMPONENT/BOOLEAN_OPERATION/INSTANCE 4 种父级均降级到 target 所在 page2、原点 0,0；
  - COMPONENT_SET 场景实际 append 到 PAGE，`rect.x = 30+200+40 = 270`、`rect.y = 40`，并回发 `fallback-created`。

### 1.2 code.js：appendChild 失败路径
- `code.js:467-478`：`container.node.appendChild(rect)` 包在 try/catch；失败先 `rect.remove()`（:472-476，自身包 try/catch），再抛出 `新建图层失败（容器 <type>）：<原因>`（:477）。不会留下已 append 的半成品。
- 错误传播：`applyResult` 内的 `createFallbackLayer` 抛出 → `runApplyResult` 的 catch（`code.js:375-390`）统一 `figma.ui.postMessage({type:'apply-done', ok:false, error})`（:385-389）。错误确实走到 `apply-done ok:false`。
- mock 验证：锁定 FRAME 的 appendChild 抛错时，`rect.remove()` 被调用、错误信息包含 `新建图层失败（容器 FRAME）`、没有回发 `fallback-created`。

### 1.3 ui.html：写回失败上限 3 次（D4）
- 常量：`ui.html:160` `MAX_APPLY_FAILURES = 3`；计数表 `ui.html:173` `applyFailures = {}`。
- 失败计数与熔断：`attemptApply` 在 `reply.ok === false` 时计数（`ui.html:743`）；`>= MAX_APPLY_FAILURES` 时置 `entry.state='failed'`、清 uiStatus、`cancelRetry`、`saveRegistry`、`renderList`、打印明确提示并 return（`ui.html:744-756`）；**return 前不 ack**（ack 只在成功路径 `ui.html:769` 调用，失败路径抛错前也不会到达）。
- 成功清零：`ui.html:764` `delete applyFailures[jobId]`，随后才 ack（:769）。
- 其他清理点：`stopEntry`（:844）、`resumeAll`（:876）、`clearFinished`（:902）都会 `delete applyFailures[...]`；`cancelRetry` 同步清理定时器（:824-826）。
- 无绕过路径（grep 全量核对）：
  - `attemptApply` 只有 2 个调用点：watch 分发（:627）与重试定时器（:813）；进入即校验 `entry.state === 'watching'`（:708），失败后 state=failed，后续 ready 不会再重试。
  - `scheduleRetry` 只有 1 个调用点（:771，attemptApply 的 catch）；第 3 次失败在抛错之前 return，不会排下一次重试。
  - `ackResult` 只有 1 个调用点（:769，成功路径）；`apply-done` 处理器（:978-986）只 resolve promise/日志，不 ack。
  - 只有用户主动「继续等待」（resumeAll）会清计数并恢复 watching，属设计允许的人工重试。
  - 「任务已失效」分支（:735-742）直接置 failed 并停止，同样不重试、不 ack。

### 1.4 ui.html：registryReady 超时（D6）
- `ui.html:161` `REGISTRY_TIMEOUT_MS = 4000`；`waitRegistry()`（:537-553）用 `setTimeout` + `registryReady.then` 实现 4 秒上限，超时 resolve(false)，正常 resolve(true) 并清定时器。
- `handleSendPayloads`（:501-535）：先 `await waitRegistry()`（:507）；false 时 `log('读取任务列表超时，请重开面板')` 并 return（:508-512）；`finally` 始终 `sending=false; renderSendButton(); startCoordinator()`（:530-534），按钮恢复。
- 不误建任务：超时 return 发生在 `ensureBase/uploadOne` 循环（:513-528）之前，不会 POST `/api/jobs` 或 PUT image；`send-payloads` 也只在点击后由主线程回一次，不会在超时后补发任务。

### 1.5 语法复核
- `node --check figma-plugin/code.js` → exit 0。
- 从 `figma-plugin/ui.html` 抽出内联 `<script>`（26941 字符）后 `node --check` → exit 0。

### 1.6 范围检查（是否顺手改 bridge/ / ps-cep/）
- 当前工作区确有 `bridge/server.py`、`ps-cep/js/main.js`、`ps-cep/CSXS/manifest.xml`、`README.md` 的改动，但均可归属到其它任务：
  - `bridge/server.py` 含 `GC_ORPHAN_MIN_AGE_SEC` 与孤儿目录 mtime 检查（t7 的 D1 修复）；
  - `ps-cep/js/main.js` 含 health `data.ok` / `version` 校验与旧桥心跳提示（t8 的 D2/D3）；
  - `ps-cep/CSXS/manifest.xml` 已是 0.2.0（t8 的 D5）；
  - `README.md` 为 t6 文档任务。
- `figma-plugin` 之外的这些改动中没有 D4/D6 相关符号；`applyFailures/MAX_APPLY_FAILURES/REGISTRY_TIMEOUT_MS` 仅出现在 ui.html，容器降级仅出现在 code.js。t9 声明的改动范围与实际一致，未发现顺手修改 bridge/ps-cep 的痕迹（注：工作区未提交，无法按 commit 隔离作者，但所有 bridge/ps-cep hunk 都能对应到 t7/t8 任务记录）。

## 2. 评审结论
t9 对 D4 与 D6 的修复按契约与本次评审口径真实落地：非法容器降级、appendChild 失败清理并回 ok:false、写回失败 3 次熔断且无绕过、registryReady 4 秒超时且不误建任务。**verdict = pass**，无 findings。

### 非阻断观察（不构成本次评审失败项）
1. target 已删除（null）时只能回落 `figma.currentPage`；原页面信息已丢失，属合理兜底。
2. 允许列表含 `GROUP`/`SECTION`，在契约 4.5 字面（仅 PAGE/FRAME）之外，但符合本次评审口径；旋转 GROUP 的 AABB 原点换算仍有理论误差。
3. 若 appendChild 成功之后 `rect.x/y`、selection 等极少数调用抛错，已 append 的图层不会回收（最多 3 次重试内）；appendChild 失败路径本身已按验收要求清理，不影响本次判定。
