# 归档分页校对台

本地模拟两处归档服务：一边按**扫描页序**（扫描仪入库顺序），一边按**印刷页码**（纸页上的数字）。
采集器保存原件版本，校对进程维护两套序之间的页对应关系，检索索引要等对应关系确认后才换版。
偶尔会插入一页没有印刷页码的**勘误**，由锚点定位。

只使用 Node.js 内置模块，无第三方依赖，不连接外部服务。

## 启动

```bash
node server.js              # 默认端口 3000
PORT=4310 node server.js    # 指定端口
```

服务只绑定 `127.0.0.1`，页面地址 `http://127.0.0.1:<PORT>/`。
状态默认写入 `data/state.json`（可用 `STATE_PATH` 覆盖），重启后保留。删除该文件或点页面上的“重置本地样例”即可从头开始。

## 页面

页面顶部的「一次运行：采集两套分页 + 插入勘误 + 对照索引」按钮会在**同一次操作**里完成：

1. 采集两套分页（图册：扫描序 `1 3 勘误 2 4` / 印刷序 `1 2 勘误 3 4`；年鉴：重复底片折叠）
2. 确认页对应关系
3. 发布首版索引
4. 建立两条旧引用（图册第 2 页、年鉴第二章第 1 页——与第一章第 1 页同页号）
5. 插入勘误页（原件版本推进）
6. 索引换版被闸门拒绝（`mapping_stale`）
7. 重新确认对应关系（未变页逐页复用 pageId）
8. 换版索引（`IDX-0002`）
9. 对照页码索引：两套序位次差异、重复页、勘误锚点、引用保底核对

业务结果区带 `data-evidence-result` 属性，每次操作都会显示操作前后的状态摘要
（`before.stateDigest → after.stateDigest`）、每一步的结果与拒绝原因，便于核对操作前后内容。

「复用策略」下拉框可切换：

- **逐页复用 pageId**：索引文档标识沿用 pageId，未变化的页 docId 不变。
- **整件重建文档标识**：所有文档按版本重新编号（`pageId~rN`），旧引用靠 pageId 在保留的旧索引版本中解析。

## 关键设计

### 稳定页标识

`pageId = hash(itemId, pageKey, checksum)`，其中 `pageKey = page|section|pageLabel`（勘误为 `errata|signature`）。
因此：

- **两章都印“第 1 页”**：`page|第一章|1` 与 `page|第二章|1` 是两个 pageKey、两个 pageId，不会被误并。
- **同一张底片扫了两次**：校验和相同 ⇒ pageId 相同。扫描 feed 保留每一张底片（`leafIds`），
  印刷 feed 去重，逻辑页只保留一个主本；重复帧记入 `duplicateLeafIds`。旧引用指向 pageId，重复扫描不会改写旧引用。
- **同页号但校验和不同**（不同印次/不同页）：记入 `conflicts`，对应关系**不可确认**，索引拒绝换版，必须人工裁定。

### 索引闸门

`publish-index` 要求每件馆藏当前原件版本都有**已确认且未过期**的对应关系：

- 从未确认 ⇒ `mapping_not_confirmed`
- 插入勘误或重新采集后原件版本推进 ⇒ `mapping_stale`（旧索引继续生效）

被拒绝的操作仍写入操作历史并计数（`indexPublishRejections`），可审计。

### 引用保底

引用绑定 `pageId` + 建立时的校验和；每次索引换版都保留旧版本（不删除、不原地改写）。解析时：

1. 当前索引仍有该 pageId ⇒ 命中当前索引（逐页复用下 docId 不变）。
2. 当前索引不再收录（整件重建换了 docId，或该页改版换了 pageId）⇒ 回落到旧索引版本，旧引用仍可解析。
3. 页内容改版（同 pageKey、不同校验和）：新页获得新 pageId，旧引用不被静默改写为新版正文，
   解析结果标记 `contentChanged: true` 并说明回落到了哪个旧版本。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/state` | 页面快照 |
| POST | `/api/operation` | `{"action": "...", "params": {...}}` |
| GET | `/api/search?q=...&indexVersionId=...` | 检索生效索引，或指定旧版本 |
| GET | `/api/citations` | 引用解析核对 |

`action` 取值：`capture`、`confirm-mapping`、`insert-errata`、`publish-index`、`compare-index`、
`create-citation`、`demo`、`reset`。

## 测试

```bash
node --test
```

用例覆盖：

- 两套分页各自成立、装订错页导致的位次差异
- 重复底片折叠、同页号分属不同章节不误并
- 同页号不同校验和 ⇒ 不可确认、索引拒绝换版
- 对应关系闸门：未确认 / 过期（勘误插入后）拒绝换版，旧索引继续生效
- 逐页复用 vs 整件重建下旧引用的 docId 变化与 pageId 保底
- 页内容改版后旧引用回落到旧索引版本
- 检索在换版前被拒绝、可指定旧版本
- 操作前后摘要、异常输入错误码
- HTTP 契约：静态页含 `data-evidence-result`、demo 前后摘要、非法 JSON、目录穿越、重启后状态保留
