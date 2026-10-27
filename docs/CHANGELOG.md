# 更新日志

版本口径：桥接服务、Figma 插件、PS 面板按同一项目版本发布；跨端契约见 [multi-doc-spec.md](multi-doc-spec.md)。

## 0.3.4 — PS 单方面发图：Figma 里直接新建图层

**需求**：PS 自己打开一张图（不是从 Figma 发来的，文档里没有任务标记），点「保存并回传」时原来会报错拒绝。现在希望它能把这张图发到 Figma，并在选中图层上方新建一个图层，尺寸与 PS 中一致。

**做法**（三端联动，桥接服务不用改）：

- PS 面板 `saveActive()`：没有任务标记时不再抛错，改走 `sendAsInsert()` —— 按 docId 导出 PNG → `POST /api/jobs {source:'ps', mode:'insert', name, imageWidth, imageHeight}` → `PUT result`
- Figma 插件新增独立发现循环（3 秒一次，不跟 25 秒长轮询挤在一起）：`GET /api/jobs` 里挑 `meta.source==='ps' && status==='ready'` 且注册表没有的任务
- 主线程新增 `insert-result`：`createImage` → 按图片像素尺寸 `resize` → 放到选中图层**正上方**（`parent.insertChild(index+1, ...)`，左上角与选中图层对齐；auto-layout 容器里自动改 `layoutPositioning='ABSOLUTE'`）；没选中就放到视口中心
- 成功后写一条 `state:'done'` 记录到任务列表并 `ack`，PS 端能看到「Figma 已新建图层」
- 只接受 10 分钟内发来的图（`PS_INSERT_MAX_AGE_MS`）：插件重开时不会把很久以前发的图悄悄贴进画布
- 超大图沿用 0.3.3 的自动缩放（Figma 单图单边上限 4096px）

### 验证

- `node --check` 通过（`code.js`、`main.js`）；`ui.html` 内联脚本 `new Function` 校验通过

### 升级

**桥接服务本次没改，不用重启**；Figma 插件重新运行；PS 面板改动已同步到 CEP 目录，重启 Photoshop 生效。

---

## 0.3.3 — 关掉未回传的图，任务不再赖在列表里

**现象**：从 Figma 发一张图到 PS，PS 里什么都没做就把文档关掉，这张图的任务仍然一直留在 Figma 任务列表里。

**根因**：0.3.1 为「点完发送任务别马上消失」加的缓冲条件是无期限的：

```js
if (entry.state === 'watching' && !entry.appliedAt) { out.push(entry); }  // 永远成立
```

所以只要这个任务从没回传过，它就永远显示 —— 哪怕 PS 早就把文档关了。

**修复**：

- 新增 `seenOpen`：PS 一旦上报过「打开着这个任务」，就给注册表条目打上标记
- 显示条件改为：**PS 里开着** → 显示；否则只有「刚发出（60 秒内）且从未被 PS 打开过」才显示；一旦 `seenOpen` 就只认「当前是否开着」
- 缓冲期常量 `SEND_GRACE_MS = 60000`，写死在 UI 里，不再无期限
- PS 面板：自己打开的临时 PNG 被关掉、且一次都没回传过 → 主动 `POST /fail` 结束该任务，并加入 `ignored`（不再自动接收），避免它在桥接里长期挂在 `pending/editing`
- 用户自己的 PSD（从磁盘恢复的会话）关掉时**不**触发这个逻辑 —— 那只是"先放一放"，之后重新打开仍能继续

### 验证

- `tools/t14_done_watch_test.js` 增至 20 条：新增「刚发出、PS 还没接手 → 缓冲期内仍在列表」「PS 关掉未回传的文档 → 列表收起」
- 其余套件（t15 10/10、e2e 8/8）与三端语法检查全部通过

### 升级

**桥接服务本次没改，不用重启**；Figma 插件重新运行；PS 面板改动需重跑部署器 `[1]` 并重启 Photoshop。

---

## 0.3.2 — 打开 PSD 立刻显示 + 老任务补缩略图

### 问题 1：PS 打开 PSD，Figma 不显示对应任务

**现象**：在 PS 里打开一个之前保存的 PSD，Figma 列表里看不到它；点一次「保存并回传」之后才冒出来。

**根因**：上报给 Figma 的 `openJobIds` 是从 PS 的**会话表**算的，而 `applyDocList` 对 `ignored`（被「取消」过的任务）会跳过登记。于是文档明明开着，会话表里没有它 → 上报为空 → Figma 不显示。而「保存并回传」走的是 `ensureSession`，会顺手清掉 `ignored` 并建会话，所以那一刻才出现。

**修复**：

- 新增 `openDocs`：保存「最近一次从宿主读到的文档列表」，`openJobIds` / `activeJobId` **改为以真实打开的文档为准**，会话表只作兜底
- `applyDocList` 检测文档列表指纹变化时**立即发一次心跳**，不再等下一轮 2 秒心跳；配合 3 秒的文档扫描，最迟约 3 秒同步
- 语义澄清：「取消」只表示不再自动登记会话/自动接收，**不表示文档没开着**

### 问题 2：有的任务有缩略图、有的没有

**根因**：缩略图是 0.3.0 才有的功能，之前发送的任务没有记录。

**修复（自动回填）**：

- Figma UI 渲染列表时，对没有缩略图的记录发 `thumb-request {jobId, targetId}`（每次最多 3 个，避免一次性导出太多）
- 主线程 `sendThumbnail`：按 `targetId` 找节点，`exportAsync` 到 68px 以内，回 `thumb-result {jobId, data}`
- UI 收到后存进注册表（`thumb` = `data:image/png;base64,...`），重启后仍在
- 拿不到（原图层已删/不支持导出）→ 记为 `'none'`，显示占位方块且**不再重试**

### 验证

- `tools/t14_done_watch_test.js` 增至 18 条：新增「老任务会请求补缩略图」「收到缩略图后渲染出 img」「拿不到时不再重复请求」
- `tools/t15_ps_state_test.py` 10/10、`tools/e2e_multi.py` 8/8 仍通过；三端语法检查通过

### 升级

**桥接服务本次没改，不用重启**；Figma 插件重新运行即生效；PS 面板改动（`openDocs` 上报逻辑）需重跑部署器 `[1]` 并重启 Photoshop。

---

## 0.3.1 — 单实例保护 + 列表跟随 PS

### 桥接服务 `bridge/server.py`

- **单实例保护**：启动时先探测候选端口上是否已有桥接实例（`/api/health` 返回 `ok:true` 且有 `version`）。发现就打印「已经有一个桥接服务在运行：http://127.0.0.1:<port>，当前有 N 个任务记录。不会重复启动。」并以 0 退出。
  这一步是为了根治一类很难排查的假故障：双击两次「启动桥接」会起两个实例（8765、8766），Figma 连一个、PS 连另一个，用户看到的是「任务明明在，PS 却说任务不存在」，而数据其实完好。
- 版本 `VERSION = "0.3.1"`

### Figma 插件 `figma-plugin/ui.html`

- **任务列表跟随 PS**：默认只渲染「PS 里打开的任务」（`ps.openJobIds`）+「刚发出、PS 还没打开的任务」（`state=watching && !appliedAt`）；其余记录收起但不删除
- 列表标题右侧新增 `只看 PS 中 / 显示全部` 切换，偏好持久化；标题显示 `显示数 / 总数`
- PS 未连接、或 PS 面板是旧版本（没有上报 `ps`）时，自动退回「显示全部」，不会把列表清空
- 空列表时提示改为「PS 里没有打开的任务。点上面的「显示全部」可以看到 N 条历史记录。」

### PS 面板 `ps-cep/js/main.js`

- 404 类错误提示补充：「若你同时开了多个桥接窗口，请只保留一个」（指向本次单实例问题）

### 验证

- `tools/t15_ps_state_test.py` 增至 10 条：新增「已有实例时拒绝重复启动」
- `tools/t14_done_watch_test.js` 增至 15 条：新增「PS 只开着 1 个 → 列表只显示 1 个」「点显示全部 → 两条都回来」
- `tools/e2e_multi.py` 8/8 仍通过；三端语法检查通过

### 升级

**桥接服务必须重启**（关掉黑窗口再双击）；Figma 插件重新运行即生效；PS 面板改动需重跑部署器 `[1]` 并重启 Photoshop。

---

## 0.3.0 — PS 现场感知 + 缩略图 + 折叠

一句话：Figma 面板能实时看到 PS 那边「开着哪几张、正在看哪一张」，任务行带缩略图，顶部信息和日志可折叠腾出空间。

### 桥接服务 `bridge/server.py`

- 新增 `PS_STATE = {activeJobId, openJobIds, updatedAt}`：由 PS 面板心跳上报，**只用于展示，不参与任务流转**
- `POST /api/ps/heartbeat` 接受可选 body `{activeJobId, openJobIds}`；未知 id 会被过滤；不带 body 的旧客户端仍兼容
- `GET /api/health`、`GET /api/ps/jobs`、`GET /api/jobs/watch` 均新增 `ps` 字段：`{online, activeJobId, openJobIds, updatedAt}`；离线时不暴露过期的 `activeJobId`
- **`/api/jobs/watch` 现在也会被 PS 现场状态变化唤醒**（原来只认任务 `updatedAt`，PS 换文档要等满 25 秒才刷新）
- 只有 `activeJobId` / `openJobIds` 真变化才 `notify_all()` —— 心跳 2 秒一次，若无条件唤醒会把长轮询变成热循环
- 版本 `VERSION = "0.3.0"`

### Figma 插件 `figma-plugin/ui.html`

- **PS 现场状态**：顶部一行显示 `PS 正在看：<图层名>` / `PS 里开着 N 张` / `PS 空闲` / `PS 面板未连接`；每行徽标 `◆ PS 正在看` / `PS 已打开`
- **自适应刷新**：面板有焦点 3 秒、后台 15 秒；监听中的任务由长轮询驱动，PS 换文档实测约 0.8 秒可见
- **任务缩略图**：发送时用 `canvas` 生成 68px PNG 存进注册表（`thumb` 字段），重启插件后仍在；旧任务显示占位方块
- **折叠**：右上 `⚙` 收起「说明 + 桥接地址」；「运行日志」点击标题收起/展开；两者状态持久化，默认都收起
- 日志收起时若有错误，标题亮小红点，避免把错误藏起来
- 注册表 `normalizeValue` 增加 `thumb` 字段（向后兼容旧记录）

### PS 面板 `ps-cep/js/main.js`

- 心跳改为携带 `{activeJobId, openJobIds}`：`openJobIds` = 会话表里有文档且未关闭的任务；`activeJobId` = 当前活动文档 `docId` 对应的任务
- `syncJobMeta` 之外的会话/活动文档逻辑未变

### 验证

- 新增 `tools/t15_ps_state_test.py`（9 条）：上报→health 透传、watch 被 PS 状态变化唤醒（0.82 秒）、**重复心跳不唤醒**（6.0 秒照常挂满）、未知 id 过滤、心跳超时后不暴露过期 activeJobId、旧客户端无 body 兼容
- `tools/t14_done_watch_test.js` 13/13 通过；`tools/e2e_multi.py` 8/8 通过；三端语法检查通过

### 升级

**桥接服务有改动，必须重启「启动桥接」黑窗口**；Figma 插件重新运行即可；PS 面板改动需重跑部署器 `[1]` 并重启 Photoshop。

---

## 0.2.2 — 修复「PS 取消任务后再回传不覆盖」

**现象**：在 PS 面板点过「取消任务」，之后关掉 PSD、重新打开、点「保存并回传」，Figma 原图层不动；必须回 Figma 点一次「继续等待」才行。

**根因**：两端对「取消」的理解不一致，形成一个自相矛盾的组合：

1. PS 端「取消」→ 本地把 jobId 记进 `ignored`，同时 `POST /fail` 把桥接任务置 `failed`
2. Figma 端收到 `failed` → 任务标成 `failed` → **退出监听集**（`isListening` 当时排除了 failed）
3. 用户重开 PSD 点「保存并回传」→ PS 的 `ensureSession` **不检查 `ignored`**，照样导出并 `PUT /result`，桥接任务变回 `ready`
4. 但 Figma 已经不看了 → 没人贴回

也就是「PS 允许你传，Figma 却拒收」。而「取消」的语义本来只是停掉 PS 这边的会话，不该等于「这个图层永远不许再被覆盖」。

**修复**：

- `isListening()` 改为「白名单式排除」：只排除 `stopped`（用户在 Figma 里主动点「停止」）和 `expired`（桥接记录已不存在）；`failed` 重新纳入监听
- `dispatchRemote` 收到 `ready` 且版本比已贴的新时：若当前是 `failed` 就自动恢复成 `watching`、清掉失败提示与熔断计数，然后正常回写 —— 所以「写回连续失败 3 次熔断」现在也会在你重新回传后自动再试
- PS 端 `ensureSession`：用户明确对某份文档点「保存并回传」时，清掉该 jobId 的 `ignored` 记录，避免面板一边允许回传、一边拒绝重新登记
- PS 端「取消」的日志补充提示：之后重新回传即可恢复
- **「停止」语义收敛为唯一的硬停止**：原来「还没回写过」的分支把状态设成 `failed`，而 0.2.2 起 `failed` 仍会监听，等于点了停止也停不住（PS 后续回传仍会被自动贴回）。现在两条分支统一落到 `stopped`，只是未回写过时额外 `POST /fail` 通知服务端释放任务
- CEP 清单版本 → 0.2.2

**回归测试**：`tools/t14_done_watch_test.js` 扩到 9 条，新增「failed 仍监听」「PS 取消后新回传自动 apply」「主动停止不自动恢复」；把 `isListening` 还原成旧逻辑后其中 2 条失败（`failed` 的 id 不在 watch 列表里、apply 次数为 0），稳定复现该现象。

**升级**：Figma 侧 `插件 → 开发 → 重新运行插件`；PS 面板改动（清 `ignored`、取消提示）需重跑部署器 `[1]` 并重启 PS —— 只升级 Figma 插件也能恢复正常覆盖。

---

## 0.2.1 — 修复「PSD 重开再回传不覆盖原图」

**现象**：PS 里把图存成 PSD、关掉、隔天重开、改完点「保存并回传」，桥接端任务一直停在 `ready`，Figma 原图层不动；但点「认出原图层」又能正确定位到节点。

**根因**：Figma 插件回写成功并 ack 后把任务置为 `done`，而协调器只监听 `state === 'watching'` 的任务（`figma-plugin/ui.html` 的 `coordinatorStep` 过滤，`attemptApply` 里还有第二道同样的守卫）。于是第一次成功后任务就退出了监听集，PSD 重开后再回传的新结果**没有任何一方去取**，服务端只能永远停在 `ready`。（`resumeAll()` 的注释说明设计意图本是想支持这个场景，但做成了必须手动点「继续等待」。）

**修复**：

- 新增 `isListening()`：`watching` 与 `done` 都算在监听；`done` 语义从「已完成」改为「已回写 · 仍在监听」
- 主动「停止」改用独立状态 `stopped`，不再与 `done` 混用；`attemptApply` / `scheduleRetry` / `markExpired` / 停止按钮 / 「清空已完成」全部改用 `isListening`
- `watch` 的 ids 按最近活跃排序并截断到 40 个，避免长期使用后 URL 无限增长
- 有监听任务时也会继续定期刷新 PS 在线指示灯（原来只认 `watching`，任务全 done 后指示灯就不刷新了）
- PS 面板：回传后在后台轮询任务状态最多 14 秒 —— 贴回成功记「Figma 已贴回原图层」，没贴回明确提示「请确认 Figma 面板开着」。原来不管贴没贴回都只显示「已回传」，问题因此很难被发现
- CEP 清单版本 → 0.2.1

**回归测试**：`tools/t14_done_watch_test.js` —— 在 Node 里加载真实的 `ui.html` 内联脚本（最小 DOM / 宿主桩）驱动真实逻辑，断言 watch ids 与 apply-result 行为，6/6 通过；把 `isListening` 还原成旧逻辑后其中 3 条失败，稳定复现用户遇到的现象。

**升级**：Figma 侧只需 `插件 → 开发 → 重新运行插件`；PS 面板改动需要重跑一次部署器 `[1]` 并重启 Photoshop。

---

## 0.2.0 — 多图并行（多文档）

一句话：Figma 一次送 N 张图，PS 里 N 个文档同时开着，任意顺序编辑；存 PSD、关掉、隔天重开仍能认回各自的 Figma 原图层并覆盖回去。

### 桥接服务 `bridge/server.py`

- **删除全局 `busy`**：`GET /api/ps/pending` 改为「领取下一个 `pending` 任务（一次一个）」，响应只有 `{job, sourceUrl}`；任意数量任务可同时处于 `editing`
- **租约**：任务内部记录 `lastTouch`（不对外暴露）；`POST /api/jobs/<id>/touch` 续租且不 bump `updatedAt`（避免空唤醒 watch）；后台每 15 秒扫描，`editing` 超过 `EDIT_TIMEOUT_SEC`（默认 600 秒，可用环境变量覆盖）无续租自动释放回 `pending`
- **条件 ack**：`POST /api/jobs/<id>/ack` 可带 `{"updatedAt": <ms>}`；与当前值不等 → `{ok:false, stale:true, job}`，不删文件、不改状态；相等或无 body 才清理文件并置 `done`
- **批量长轮询** `GET /api/jobs/watch?ids=a,b,c&wait=25`：任一 id 的 `updatedAt` 变化（或记录被删）即返回；空 ids 立即返回；不存在 id 省略；单次上限 25 秒
- **心跳**：新增 `POST /api/ps/heartbeat`（`{ok, psOnline:true, jobs}`）；`/api/health` 改为只读（保留 `psOnline`），兼容期 `/api/ps/pending` 仍刷新心跳
- **任务列表**：新增 `GET /api/ps/jobs`（全部任务），与 `GET /api/jobs` 并存
- **GC**：每 10 分钟清理 `done/failed` 且超过 30 天的任务记录与 `.data/<id>/` 目录，以及无记录的 8 位 hex 孤儿目录
- **健壮性**：`jobs.json` 解析失败备份为 `jobs.bad.<ts>.json` 并从空表启动；时间戳非数值/NaN 按 0；非法 id/元数据丢弃规整；状态页插入值全部转义；版本号收敛为单一 `VERSION = "0.2.0"`
- **HTTP keep-alive 修复**：POST/PUT 统一预读请求体并缓存，避免残留 `{}` 污染同一连接上的下一个请求（413 时主动断开）
- 重启时：`editing` 任务恢复为 `pending`；旧数据缺 `lastTouch` 按当前时间补齐

### Figma 插件 `figma-plugin/`

- **多选发送**：`send-request` 遍历整个 `figma.currentPage.selection`，逐个取原图；单个失败不影响其它节点；已在监听中的同一 `targetId` 自动跳过；按钮显示「发送 N 个到 PS」并在点击后立即置忙
- **多任务注册表**：`figma.clientStorage` key = `jobs`（`{version:2, fileKey, jobs:[...]}`），替代单槽 `pendingJob`；启动时自动迁移旧 key（新 key 写成功后才删旧 key）；`state ∈ watching|done|failed|expired`
- **批量监听**：所有 `watching` 任务合并成一次 `/api/jobs/watch?ids=...&wait=25`；无监听任务时每 2 秒 `/api/health`；网络错误重新探测端口，并对异常快速返回做 300ms 限速
- **回写链路**：`apply-result` 必须带 `jobId`，主线程校验注册表并串行执行，完成后 `apply-done {jobId, ok, error?}`；只有 `ok:true` 才带 `updatedAt` 调 ack 并前移 `appliedAt`；失败不 ack，按 2s→4s→8s→15s→30s 独立退避，连续失败 3 次则标记 `failed` 并停止重试（点「继续等待」清零）；stale ack 只记日志等下一轮
- **fallback 定位修复**：新建矩形前先切到目标所在页面，位置用 `absoluteBoundingBox` 的页面绝对坐标换算到父容器坐标；父级不能容纳时落到当前页；新 `targetId` 通过 `fallback-created` 回传并写入注册表
- **导出倍率修正**：由 `min(4, max(2, ceil(4096/最长边)))` 改为 `min(4, max(1, 4096/最长边))` 并向下取整到 2 位小数（3000px 画框 6000px → 4080px；5000px 画框 10000px → 5000px）
- **UI**：任务列表（名称、尺寸、状态、认出原图层、停止）；「继续等待」可恢复 `done/failed/expired`（`done` 用于 PSD 隔天重开再覆盖）；「清空已完成」只移除记录；`expired` 保留 `targetId`，仍可认出原图层
- 清理无调用方的死消息类型（`notify`/`error`/`send-payload`/`pending-job`/`load-pending`/`save-pending`），消息协议按契约 4.4 收敛

### PS CEP 面板 `ps-cep/`

- **多文档会话**：`sessions: Map<jobId, Session>`（`opening|open|sent|closed|error`）；2 秒主循环 `POST /api/ps/heartbeat` → `GET /api/ps/jobs` → 每轮最多打开 1 个 `pending` 任务；3 秒扫描已打开文档，按 `docId` + marker 登记/刷新，文档消失置 `closed`
- **租约续约**：`open`（待编辑）会话每 20 秒 `/touch`；返回非 `editing` 时 `/claim` 夺回，不重开文档
- **保存并回传只认活动文档**：`figmaBridgeActiveDoc` → `figmaBridgeReadMarkerActive` → 按 `jobId` 找/建会话 → 临时导出 → `figmaBridgeSavePng(path, docId)` 按 `docId` 精确定位（找不到返回 `ERR:NOT_FOUND`，**绝不回退 `activeDocument`**）→ `PUT result` → 删除临时文件 → `sent`
- **修 P0**：marker 读取的 `ERR:`（PS 无响应/对话框/超时）与 `OK:`（确实没有标记）彻底区分，不再把异常伪装成「没有标记」
- **全部回传（N 个）**：遍历 `open` 且有 `docId` 的会话逐个回传，单个失败不中断，汇总成功/失败；每个会话也可以单独「回传」或「取消」
- **取消**：未回传的发 `fail`；`ignored` 持久化到 `localStorage`；不关闭已打开的文档
- **清理**：输入临时 PNG 打开成功后立即删；导出临时文件 `finally` 删；启动清理 `%TEMP%` 下 `figma-*-*.png` 中超过 1 天的文件
- **宿主函数（`host/index.jsx`）**：`figmaBridgeOpenImage` 返回 `OK:<docId>|<docName>`；新增 `figmaBridgeActiveDoc` / `figmaBridgeListDocs` / `figmaBridgeReadMarkerActive`；`figmaBridgeSavePng(path, docId)` 返回 `OK:<w>x<h>` / `ERR:NOT_FOUND`；全部入口 `displayDialogs=NO` 并 `finally` 恢复；手写 `;`/`|` 序列化并清洗名字分隔符

### 部署与 Python 检测

- `deploy.ps1`：新增 `Get-PythonInvocation`，按 `python` → `py -3` → `py` 依次探测并校验主版本 ≥ 3；`Test-Python` 显示实际命令与版本（本机实测识别为 `py -3`，Python 3.10.6）
- `bridge/启动桥接.bat`：优先 `python`（先 `python --version` 探测，避开 WindowsApps 商店假 python），失败回退 `py -3`，再回退 `py`；启动时打印实际 launcher
- `部署器.bat -Auto`：跳过菜单直接执行一键部署（供脚本/重装使用）

### 兼容与升级

- 旧 `.data/jobs.json`：缺 `lastTouch` 按当前时间补齐；`editing` 重启后回 `pending`，可直接升级
- 旧 `figma.clientStorage.pendingJob`：自动迁移为单元素 `jobs` 数组
- 旧 PS 面板：0.2.0 保留了它能用的 `GET /api/ps/pending`、`claim`、`ack` 等接口，但多文档/心跳/租约要用新面板；旧面板仍是单任务行为
- 旧桥接 + 新面板：新面板会识别到旧接口并在状态栏提示升级（旧桥没有 `/api/ps/jobs`、`/api/ps/heartbeat`、`touch`、`watch`），PS 在线状态可能不准

### 验证

- `py -m py_compile bridge/server.py`、`node --check figma-plugin/code.js`、`node --check ps-cep/js/main.js` 通过
- `python tools/e2e_multi.py`：8/8 通过（3 任务并行领取、无 `busy`、touch 续租与超时释放、watch 唤醒、条件 ack 正确/过期、心跳上下线）
- 三端契约交叉核对与补充探针 13/13 通过（t5 验证快照；回归验证以 `tools/e2e_multi.py` 为准）

### 已知限制

见 [README「已知限制」](../README.md#已知限制)，要点：不做单 PSD 多图层；多文档并行依赖 XMP marker；Figma 回写完成后需「继续等待」才能再覆盖；任务保留 30 天。

## 0.1.0 — 初始版本

- 单任务：Figma 选一个图层 → 桥接服务 → PS 打开原图 → 保存回传 → 覆盖原图层
- 全局 `busy`，PS 面板一次只能处理一个任务
- 任务标记写入 PSD XMP（`doc.info.jobName = figma-bridge:<jobId>`），支持 PSD 存盘后重开续接
- Windows 部署器（CEP 扩展、PlayerDebugMode、桌面快捷方式）
