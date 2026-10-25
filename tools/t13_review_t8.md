# t13 评审记录：t8（D2 端口探测校验、D3 旧桥心跳提示、D5 CEP 清单版本）

评审对象：`ps-cep/js/main.js`（23:06:08）、`ps-cep/CSXS/manifest.xml`（23:04:31）
评审时间：2026-10-23 · 评审者：verifier（独立于 t8 实现者）
结论：**verdict = pass**（无 findings）

## 1. 逐条核对

### 1.1 D2：端口探测只采纳 data.ok === true 的 health 响应
- `main.js:1188-1228` `detectServer()`：依次试 `serverUrl` + 8765-8774；拿到 `/api/health` 后：
  - `main.js:1208-1210` `if (!health || health.ok !== true) throw ...`；
  - `main.js:1211-1213` `if (typeof health.version !== 'string' || !health.version) throw ...`；
  - `main.js:1214-1218` 采纳并写入 `el.server.value`，日志带版本号。
  - 失败时 `main.js:1220-1222` 恢复 `serverUrl` 并继续下一个端口。
- `main.js:420-424` `sendHeartbeat` 也对 200 响应校验 `data.ok === true`，避免代理返回 200 被误当心跳成功。
- **独立仿真**（临时 harness：假 DOM + 假 fs/path/http，真实加载 `main.js`，未改产品代码）：
  - 场景 A：8765 `/api/health` 返回 HTML（非桥接），8766 返回 `{ok:true,version:"0.2.0"}` → 8765 被跳过，最终采纳 `http://127.0.0.1:8766`，状态栏「已连接」，日志带「版本 0.2.0」。
  - 场景 B：所有候选均非法（`{ok:false,version:"0.2.0"}`、`{ok:true}` 缺 version、HTML、`{ok:true,version:123}`、`{}`、网络错误）→ `detectServer()` 返回 false，服务地址保持原值，未被任何非桥接响应误导。
  - 场景 C：`POST /api/ps/heartbeat` 返回 200 `{ok:false}` → 抛「心跳响应不是 Figma 桥接服务」，不会误判在线。
  - 结果：D2 相关 3 项断言全部 PASS。

### 1.2 D3：heartbeat 404 明确提示，不再静默回退 `/api/health`
- `main.js:418-444` `sendHeartbeat()`：POST 404 时：
  - `main.js:435-436` `legacyBridge = true`、`statusPrefix = '桥接服务版本过旧，请重新运行部署器或用新版启动'`；
  - `main.js:437-440` 仅在首次记录一次升级日志（legacyWarned）；
  - `main.js:441-442` 明确注释「故意不调用 /api/health 兜底」，并 `setStatus('旧桥缺少心跳接口，PS 在线状态可能显示为离线')`；
  - 不再有任何 `/api/health` 回退调用（`grep` 确认 `/api/health` 仅出现在 `detectServer`，`main.js:1205`）。
- 状态栏前缀：`main.js:171-174` `setStatus()` 在有 `statusPrefix` 时拼成「前缀｜消息」。
- 恢复：`main.js:425-431` 心跳恢复 0.2.0 后清 `legacyBridge`/`statusPrefix`、重置 `legacyWarned`、记录「已恢复」日志并设「已连接 · 心跳恢复正常」。
- 换地址：`main.js:1277-1283` 重置旧桥提示。
- **独立仿真**：
  - 旧桥（health `version:"0.1.0"`，heartbeat 404）：状态栏为「桥接服务版本过旧，请重新运行部署器或用新版启动｜旧桥缺少心跳接口，PS 在线状态可能显示为离线」，日志有升级说明；同期请求记录 **POST /api/ps/heartbeat 1 次、GET /api/health 0 次**（心跳路径无回退）。
  - 恢复 heartbeat 200 `{ok:true}`：状态栏变为「已连接 · 心跳恢复正常」，旧桥前缀消失，日志有恢复记录。
  - 结果：D3 相关 3 项断言全部 PASS。

### 1.3 D5：CEP 清单版本
- `ps-cep/CSXS/manifest.xml:4` `ExtensionBundleVersion="0.2.0"`；`:8` `Extension Id="com.figma.ps.bridge.panel" Version="0.2.0"`。
- Python `xml.etree.ElementTree.parse` 成功：bundle=0.2.0、ext=0.2.0；PowerShell `[xml]` 解析同样读出 0.2.0，XML 合法。

### 1.4 语法与范围
- `node --check ps-cep/js/main.js` → exit 0。
- D2/D3 专属符号（`legacyBridge`、`statusPrefix`、health `ok`/`version` 校验）仅出现在 `ps-cep/js/main.js`；manifest 只改版本行。
- 当前工作区其它改动（`bridge/server.py`、`figma-plugin/*`、`README.md`）可分别对应 t7/t9/t6 等任务；未发现 t8 触碰 bridge/ 或 figma-plugin/ 的痕迹。说明：工作区未提交，无法按 commit 隔离作者，按任务记录 + 符号/文件交叉核对。

## 2. 评审结论
t8 对 D2/D3/D5 的修复真实落地：非桥接 8765 占用者（HTML / `{ok:false}` / 缺 version / 非字符串 version）不会被采纳；旧桥 heartbeat 404 有明确「版本过旧」提示且不再回退不刷心跳的 `/api/health`；CEP 清单两处版本均 0.2.0 且 XML 合法。**verdict = pass**，无 findings。

### 非阻断观察（不影响判定）
1. `detectServer` 对 `version` 只要求「非空字符串」，不校验是否为 `0.2.0`：这是为兼容旧桥/过渡期有意为之；若某本地服务恰好同时返回 `{ok:true,version:"x"}` 仍可能被采纳，属极低概率，且后续接口失败会重探。可接受。
2. `sendHeartbeat` 对非 404 的错误（如 500/网络）继续抛出，由主循环 `handleConnectionError` 触发重新探测，语义合理。
3. 旧桥 404 的日志只提示一次（`legacyWarned`），状态栏前缀会一直保留到心跳恢复或换地址——符合「明确提示」目标。
