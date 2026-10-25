# 多图并行（多文档）改造规格 v1

> 本文件是三端并行开发的**唯一契约**。三个实现任务都必须逐条对照本文件，任何偏离都要先改本文件再改代码。

## 0. 一句话目标

Figma 一次选中 N 个图层 → 全部送到 PS，PS 里**同时开着 N 个文档**，任意顺序、任意时间编辑、保存 PSD、关闭、隔天重开；每个文档都能自动认回自己的 Figma 原图层，并把改动覆盖回去。

**核心诉求（用户原话）**：多张图可以在 PS 中同时处理，不是必须 A 完了才能 B；处理哪张就处理哪张；保存成 PSD 关掉，待会再打开，依然能回溯 Figma 原图层，并能从 PSD 重新保存覆盖原图层。

## 1. 非目标

- **不做**「一个 PSD 多图层」合成（未来可选，本次不实现）
- 不改图层结构语义：仍只同步位图，不同步文字/矢量/蒙版/新建图层
- 不做公网、多机、多用户
- 不改 Figma `networkAccess.allowedDomains` 的端口范围（仍是 8765-8774）
- 不改部署器的安装流程（只修 Python 检测）

## 2. 术语

| 词 | 含义 |
|---|---|
| Job | 一个 Figma 图层 ↔ 一份 PS 文档 的编辑会话。id 为 8 位小写 hex |
| Session | PS 面板内对一个 job 的本地记录（docId、状态、是否已回传） |
| Registry | Figma 插件存在 `figma.clientStorage` 里的 job 列表 |
| marker | PS 文档 XMP 里的 `doc.info.jobName = "figma-bridge:<jobId>"`，随 PSD 落盘 |
| docId | Photoshop 文档的 `doc.id`（数值），用于精确定位文档 |

## 3. 桥接服务 `bridge/server.py`

版本号统一：`VERSION = "0.2.0"`（`/api/health` 与状态页都引用同一个常量）。

### 3.1 状态机（关键变化：允许多个 job 同时 `editing`）

```
awaiting-image --PUT image--> pending
pending --PS 领取(/api/ps/pending 或 /api/jobs/<id>/claim)--> editing
editing --PUT result--> ready
ready --Figma ack(回写成功后)--> done
任意状态 --fail--> failed
editing 超过 EDIT_TIMEOUT_SEC 无 touch --> pending（释放租约）
```

删除「全局 busy」概念：任意数量 job 可并存于 `editing`。

### 3.2 租约（lease）

- job 增加内部字段 `lastTouch`（毫秒时间戳），领取/claim/touch 时写入
- 后台线程每 15 秒扫描：`status == "editing"` 且 `now - lastTouch > EDIT_TIMEOUT_SEC`（默认 600s，可被环境变量覆盖）→ 置回 `pending`
- `lastTouch` 不需要暴露在 `public_job` 里

### 3.3 接口表

| 方法 | 路径 | 行为 |
|---|---|---|
| GET | `/` | 状态页（所有插入值必须 `escape_html`） |
| GET | `/api/health` | `{ok, version:"0.2.0", jobs:N, port:P, psOnline:bool}`。**不刷新心跳** |
| POST | `/api/ps/heartbeat` | **新增**。刷新 `LAST_PS_SEEN`，返回 `{ok:true, psOnline:true, jobs:N}` |
| GET | `/api/ps/pending` | **语义变更**：领取**下一个** `pending` job（一次一个，置 `editing`）。没有则 `{"job":null}`。**不再返回 `busy` 字段**，不再因别的 job 在 editing 而阻塞 |
| GET | `/api/ps/jobs` | **新增**。`{"jobs":[publicJob...]}`，返回全部 job（客户端自行按 status 过滤） |
| POST | `/api/jobs/<id>/claim` | 置 `editing` + 刷新 `lastTouch`。用于 PS 重开文档后夺回租约 |
| POST | `/api/jobs/<id>/touch` | **新增**。续租：刷新 `lastTouch`，返回 public job |
| POST | `/api/jobs/<id>/ack` | **语义变更**：body 可带 `{"updatedAt":<ms>}`。带了且与当前 `job.updatedAt` 不等 → 返回 `{"ok":false,"stale":true,"job":{...}}` 且**不删文件、不改状态**；相等或无 body → cleanup + `done` |
| GET | `/api/jobs/watch?ids=a,b,c&wait=25` | **新增**。长轮询：直到任一 id 的 `updatedAt` 变化或超时。响应 `{"jobs":[publicJob...]}`（不存在的 id 省略）。`ids` 为空 → 立即返回空数组 |
| GET/POST | `/api/jobs` | 不变 |
| GET | `/api/jobs/<id>` | 不变 |
| GET | `/api/jobs/<id>/status?wait=` | 不变（保留单任务长轮询） |
| PUT | `/api/jobs/<id>/image` | 不变 |
| GET | `/api/jobs/<id>/image` | 不变 |
| PUT | `/api/jobs/<id>/result` | 不变（不校验旧状态，允许 done→ready 再覆盖） |
| GET | `/api/jobs/<id>/result` | 不变 |
| POST | `/api/jobs/<id>/fail` | 不变 |

### 3.4 `/api/jobs/watch` 实现要点

- 进入时对 `ids` 做 `updatedAt` 快照；用现有全局 Condition 等待，任一快照值变化即返回
- 等待上限 `min(wait, 25)` 秒；`ids` 去重、忽略不存在的 id
- 复用 `set_status` 里的 `notify_all()`

### 3.5 GC（新增后台线程，每 10 分钟）

- 删除 `status in (done, failed)` 且 `updatedAt` 超过 `JOB_TTL_SEC`（30 天）的 job 记录**和它的 `.data/<id>/` 目录**
- 删除 `.data/` 下没有对应 job 记录的孤儿目录

### 3.6 健壮性修复

- `jobs.json` 解析失败：重命名为 `jobs.bad.<ts>.json` 备份，从空表启动，并在控制台打印警告
- 记录里 `createdAt/updatedAt` 不是数值时按 `0` 处理，不能让启动崩溃
- 状态页 `imageWidth/imageHeight` 等插入值全部 `escape_html`
- 版本号只保留一个 `VERSION` 常量

## 4. Figma 插件 `figma-plugin/`

### 4.1 多选发送

- `handleSendRequest` 遍历 **`figma.currentPage.selection` 的全部节点**（不再只取 `sel[0]`）
- 每个节点沿用现有逻辑：`findImagePaint` → `getImageByHash().getBytesAsync()`；没有图片填充则 `exportAsync` 回退
- 跳过规则：若 registry 中已存在同 `meta.targetId` 且 state 不是 `done/failed/expired` 的 job → 跳过该节点并 `diag` 提示「已在处理中」
- 单个节点失败不影响其它节点：收集错误，最后汇总提示
- 发出 `send-payloads {items:[{meta, data}]}`

### 4.2 Registry（替代单槽 `pendingJob`）

`figma.clientStorage` key = **`jobs`**：

```json
{
  "version": 2,
  "fileKey": null,
  "jobs": [
    { "jobId": "a1b2c3d4", "meta": {...}, "at": 0, "appliedAt": 0, "state": "watching" }
  ]
}
```

- `state` 取值：`watching | done | failed | expired`
- `fileKey`：`figma.fileKey`（可能为 null），用于恢复时校验是否同一文件
- **迁移**：启动时若只有旧 key `pendingJob`，把它转成单元素 jobs 数组、删掉旧 key
- 主线程：`load-jobs` → 回发 `jobs {value}`；`save-jobs {value}` → 写存储并回发 `jobs {value}`

### 4.3 协调器（ui.html）

只要 registry 里还有 `state === "watching"` 的 job：

1. `GET /api/jobs/watch?ids=<逗号分隔>&wait=25`
2. 对每个返回的 job 分派：
   - `ready` 且 `updatedAt > appliedAt` → `GET /api/jobs/<id>/result` → 发 `apply-result {jobId, meta, data, reveal:true}` → 等主线程 `apply-done {jobId, ok}`
     - `ok:true` → `POST /api/jobs/<id>/ack`，body `{"updatedAt": <刚贴的那个值>}`，然后 `appliedAt = updatedAt`
     - `ok:false` → **不 ack**；错误退避重试（2s→4s→8s→15s→30s 封顶，按 job 独立计时）
   - `done` → state=`done`（若 `updatedAt <= appliedAt` 说明是自己贴的；否则也该刷新 appliedAt）
   - `failed` → state=`failed`，保留记录
   - `404` → state=`expired`，**保留 meta.targetId** 以便「认出原图层」仍可用
3. 没有 watching 的 job → 每 2 秒 `GET /api/health`（沿用现状）
4. 网络错误 → `activeBase=null`，退避 2 秒后重新探测端口

### 4.4 消息协议（code.js ↔ ui.html，两侧必须同时改）

UI → 主线程：

| type | payload | 说明 |
|---|---|---|
| `send-request` | `{}` | 发送当前选中的全部节点 |
| `apply-result` | `{jobId, meta, data, reveal}` | **必须带 jobId** |
| `find-target` | `{targetId}` | 认出原图层 |
| `load-jobs` | `{}` | |
| `save-jobs` | `{value}` | |
| `request-selection` | `{}` | |

主线程 → UI：

| type | payload |
|---|---|
| `boot` | `{page, count, name, total}` |
| `selection` | `{count, name}` |
| `send-payloads` | `{items:[{meta, data}]}` |
| `jobs` | `{value}` |
| `target-found` | `{targetId, name}` |
| `target-missing` | `{targetId, reason}` |
| `fallback-created` | `{jobId, targetId, name}` |
| `apply-done` | `{jobId, ok, error?}` |
| `diag` | `{message}` |

- 删除没有任何调用者的死类型（原 `notify` / `error` 由 UI 侧处理的分支），`diag` 只用于诊断和错误提示
- 主线程 `applyResult` 必须**串行执行**（Promise 队列），完成后发 `apply-done`
- 主线程校验：`jobId` 不在 registry → `apply-done {ok:false, error:"任务已失效"}`

### 4.5 回写规则（保留原三分支 + 修 fallback 定位）

- 尺寸未变（±1px）→ 只替换 `imageHash`，保留 `scaleMode`/`imageTransform`
- 尺寸变了 → `type:'IMAGE'`, `scaleMode:'FILL'`, `imageTransform:[[1,0,0],[0,1,0]]`
- 目标没有可用 IMAGE 填充但能装填充 → 向 fills 末尾 push
- **fallback / 不能装填充 → 新建矩形**：
  1. 先 `await figma.setCurrentPageAsync(pageOf(target))`
  2. 位置用 `target.absoluteBoundingBox`（页面绝对坐标），而不是 `target.x/y`（父级相对坐标）
  3. `appendChild` 到 `target.parent`；若 `target.parent` 不是 PAGE/FRAME 容器则追加到当前页
  4. 回发 `fallback-created {jobId, targetId, name}`，UI 用新 targetId 更新该 job 并保存

### 4.6 UI

- 顶部：`发送选中到 PS`（按钮文本带选中数量，如「发送 3 个到 PS」）、`继续等待`、`清空已完成`
- 任务列表：每个 job 一行 → 节点名、`W×H`、状态文案、`认出原图层`、`停止`
- 「认出原图层」对 `expired` 状态的 job 仍然可用（targetId 保留）
- 点击发送后**立即置 busy**，防止双击产生重复任务

## 5. PS CEP `ps-cep/`

### 5.1 会话模型

```js
sessions: Map<jobId, Session>
Session = { jobId, docId, docName, meta, state: 'opening'|'open'|'sent'|'closed'|'error', lastError }
ignored: Set<jobId>   // 用户主动取消的；持久化到 localStorage
```

### 5.2 主循环（每 2 秒）

1. `POST /api/ps/heartbeat`
2. `GET /api/ps/jobs`
3. 对每个 `status === "pending"` 且不在 `sessions`/`ignored` 的 job → 打开文档（**每轮最多打开 1 个**，避免 PS 连续弹窗卡死）
4. 每 3 秒 `restoreFromDocument()`：宿主 `figmaBridgeListDocs()` → 对每个带 marker 的文档登记或刷新 session（docId、docName）；文档列表里消失的 docId → 对应 session 置 `closed`
5. 对每个 `state === 'open'` 的 session：距上次 touch 超过 20 秒 → `POST /api/jobs/<id>/touch`；若返回 status 不是 `editing` → `POST /api/jobs/<id>/claim` 夺回租约（**不重新打开文档**）

### 5.3 保存并回传（作用于**当前活动文档**）

1. `figmaBridgeActiveDoc()` → `OK:<docId>|<docName>`
2. `figmaBridgeReadMarkerActive()` → `OK:<jobId>` / `OK:`（无标记）/ `ERR:<msg>`
   - `ERR:` → 明确提示失败原因（PS 无响应/开了对话框），**不得伪装成「没有标记」**
   - `OK:` 空 → 报「当前文档不是从 Figma 发来的（没有任务标记），无法回传」
3. 用 jobId 找 session，没有则先 `GET /api/jobs/<id>` 取 meta 现场建
4. 导出到临时路径 → `figmaBridgeSavePng(path, docId)` 按 docId **精确定位**，找不到返回 `ERR:NOT_FOUND`，**禁止回退 activeDocument**
5. `PUT /api/jobs/<id>/result`（`Content-Type: image/png`）
6. 成功/失败都删除导出临时文件
7. session.state = `sent`

### 5.4 全部回传（新按钮）

遍历 `state === 'open'` 且有 docId 的 session，逐个执行 5.3 的第 4-7 步；单个失败不中断，最后汇总「成功 N / 失败 M」。

### 5.5 取消

- 取消某 session：若未 `sent` → `POST /api/jobs/<id>/fail`；`ignored.add(jobId)` 并持久化；**不动 PS 里已打开的文档**
- 已 `ignored` 的 job 即使 PSD 还开着，restore 也不再登记

### 5.6 宿主函数（index.jsx）

所有函数入口 `app.displayDialogs = DialogModes.NO`，`finally` 恢复；返回值一律 `OK:` / `ERR:` 前缀；**手写序列化**（分隔符 `;` 与 `|`），不依赖 JSON 对象。

| 函数 | 参数 | 返回 |
|---|---|---|
| `figmaBridgeOpenImage(path, jobId)` | | `OK:<docId>|<docName>` |
| `figmaBridgeActiveDoc()` | | `OK:<docId>|<docName>` / `ERR:<msg>` |
| `figmaBridgeListDocs()` | | `OK:<docId>|<docName>|<jobId>;...`（无 marker 的 jobId 为空串） |
| `figmaBridgeReadMarkerActive()` | | `OK:<jobId>` / `OK:` / `ERR:<msg>` |
| `figmaBridgeSavePng(path, docId)` | | `OK:<w>x<h>` / `ERR:NOT_FOUND` / `ERR:<msg>` |

### 5.7 清理

- 打开成功后立即删除输入临时 PNG（PS 已把图读进内存）
- 导出临时 PNG 在 `finally` 删除
- 面板启动时清理 `%TEMP%` 下 `figma-*-*.png` 中创建超过 1 天的文件

## 6. 跨端不变量（缺一不可，验证要逐条打勾）

1. 一个 job 同一时刻只对应一份 PS 文档（靠 marker 保证）
2. 任意多个 job 可同时处于 `editing`
3. ack 必须带 `updatedAt`，且只 Figma 回写成功后调用
4. Figma 侧 `appliedAt` 只在 `apply-done ok` 之后前移
5. PS 保存只认**活动文档**，且必须有 marker
6. 文档定位一律用 `docId`；`docId` 不可用时用 marker 精确匹配，**禁止回退 `activeDocument`**
7. 打开的输入临时文件必须删除；导出临时文件必须删除
8. 面板关掉重开：所有带 marker 的文档都会被重新登记
9. PSD 存盘重开：marker 随 XMP 保留（现有机制已成立，不要破坏）
10. 心跳用 `POST /api/ps/heartbeat`，不用 `/api/health`

## 7. 兼容与升级

- 版本 `0.2.0`
- 旧 `.data/jobs.json`：缺 `lastTouch` 的按 `now` 补齐，不影响启动
- 旧 `clientStorage.pendingJob`：迁移为单元素 `jobs`
- 旧 `GET /api/ps/pending` 的 `busy` 字段删除，两端同步改

## 8. 验收条件

- **B1** `py -m py_compile bridge/server.py` 通过
- **B2** `py -m py_compile tools/e2e_multi.py` 通过，且脚本能跑通：
  - 模拟 Figma 建 3 个 job
  - 模拟 PS 连续 claim 3 个 → 3 个 job 同时为 `editing`（验证不变量 2）
  - 3 个 job 各自 touch，`EDIT_TIMEOUT_SEC=2` 时能观察租约被释放回 `pending`
  - 回传 result → `/api/jobs/watch` 能唤起并返回新状态
  - 带正确 `updatedAt` 的 ack → done 且文件删除
  - 带**错误** `updatedAt` 的 stale ack → `ok:false`、状态不变、`result.png` **仍在**（验证不变量 3）
- **F1** `node --check figma-plugin/code.js` 通过
- **F2** 三端消息类型/接口路径逐一交叉核对，无遗漏、无改名残留（验证不变量 3-6）
- **P1** `node --check ps-cep/js/main.js` 通过
- **D1** README 更新：多图用法、多文档并行说明、新接口表、版本号、已知限制

## 9. 开发顺序建议

1. bridge（接口先稳定）
2. figma + ps 并行（各自按本规格实现，互不改对方文件）
3. e2e 验证
4. 文档

---

## 10. v0.3.0 增补：PS 现场状态（只读）

目标：Figma 面板能显示「PS 里开着哪几张、现在正在看哪一张」。**只读感知，不包含任何反向控制。**

- **上报方**：PS 面板，随 `POST /api/ps/heartbeat` 携带 body `{"activeJobId": "<id|null>", "openJobIds": ["<id>", ...]}`
  - `openJobIds`：会话表里有 `docId` 且 `state !== 'closed'` 的任务
  - `activeJobId`：当前活动文档 `docId` 对应的任务；没有对应任务时为 `null`
- **桥接**：保存 `PS_STATE`，未知 id 一律过滤；**只有 `activeJobId` / `openJobIds` 真变化才 `notify_all()`**（心跳 2 秒一次，无条件唤醒会让 watch 变成热循环）
- **透传**：`GET /api/health`、`GET /api/ps/jobs`、`GET /api/jobs/watch` 响应里增加
  ```json
  "ps": {"online": true, "activeJobId": "a1b2c3d4", "openJobIds": ["a1b2c3d4"], "updatedAt": 1792771800000}
  ```
  离线（超过 `PS_ONLINE_WINDOW`）时 `online:false` 且 `activeJobId` 为 `null`，不暴露过期值
- **`/api/jobs/watch` 语义扩展**：PS 现场状态变化也算「变化」，立即返回（不必等满 `wait`）
- **兼容**：心跳不带 body、或旧桥不返回 `ps` 字段时，客户端必须能降级工作
- **不变量补充**：PS 状态只影响展示，**不得**影响任务状态机、租约、ack 等任何流转逻辑
