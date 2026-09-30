# 数字展品使用授权核验应用

供小型展馆在选取数字展品组成展览包时，沿**全部来源链**逐节点核验使用授权（媒介、地区、有效期、撤销状态），并在发布时**原子保存不可变的核验快照与素材清单**。授权随后变更时自动重算资格，仅把“由合格变不合格”的已发布包标记为**需复核**，原快照始终保留。

- 后端：Node.js 20 + Express + better-sqlite3（SQLite，同步事务）
- 前端：原生 HTML/CSS/JS，无构建步骤
- 交付：Dockerfile + docker-compose 一键启动，数据库自动初始化

---

## 一、一键启动（Docker Compose，推荐）

前置：已安装 Docker 与 Docker Compose 插件。

```bash
docker compose up --build -d
```

启动后打开浏览器：

- **Web 地址：http://localhost:3000**

首次启动会自动建表并写入一份演示数据（由 `SEED_DEMO=1` 控制；数据库非空时自动跳过）。
停止 / 查看日志：

```bash
docker compose logs -f
docker compose down            # 停止（数据保留在命名卷 exhibit-data 中）
docker compose down -v         # 停止并删除数据库卷（清空全部数据）
```

## 二、本机直接运行（不用 Docker）

前置：Node.js ≥ 20。better-sqlite3 会优先下载预编译二进制；若本机无编译环境且无法访问 GitHub，可使用 npmmirror 镜像：

```bash
# 安装依赖（两种方式任选）
npm ci || npm install
# 若卡在 better-sqlite3 预编译下载，可指定镜像后重试：
# npm_config_better_sqlite3_binary_host_mirror=https://registry.npmmirror.com/-/binary/better-sqlite3 npm install

# 可选：初始化演示数据
npm run seed

# 启动
npm start
# → http://localhost:3000
```

运行自检（需先启动服务）：

```bash
node test/e2e.js
```

---

## 三、使用流程

界面分两个标签页：

1. **素材与来源**
   - 登记素材（名称、类型、备注）。
   - 维护来源关系：「本素材 使用了 ← 来源素材」。关系按边逐条核验，添加会成环的边将被拒绝并提示完整闭环。
   - 登记授权：媒介、地区、有效期（起止日期）、撤销状态、授权方。媒介或地区填 `*` 表示通配任意值；匹配忽略大小写；有效期按闭区间覆盖整段使用期（`valid_from <= 使用起始` 且 `valid_to >= 使用截止`），已撤销授权一律不计入。
2. **展览包与核验发布**
   - 新建待发布包：填展示媒介、地区、起止日期，勾选入展素材（系统会自动纳入其全部上游来源节点）。
   - 点「核验」：沿每个入展品的**全部**来源路径遍历，逐节点检查是否至少有一份“未撤销 + 媒介命中 + 地区命中 + 覆盖整段使用期”的授权。结果列出：
     - 全局错误（缺媒介/地区、日期不合法、起晚于止等）；
     - 不合格节点及其原因（无授权 / 全部撤销 / 媒介不符 / 地区不符 / 日期不覆盖 / 成环）；
     - 每个不合格节点的全部来源路径（入展品 → … → 问题节点）。
   - 点「按此次核验结果原子发布」：
     - 服务端在事务内**重新读取并重算**，并比对“核验依据版本”。若核验之后授权或来源关系被任何人修改过，返回 `409 STALE_BASIS`，拒绝发布并提示重新核验；
     - 核验不通过（缺授权、日期不合法等）返回 `422`，包保持“待发布”，但本次尝试同样留存为不可变记录；
     - 通过则在**单个 SQLite 事务**内写入不可变核验快照（完整逐节点结果 JSON + 冻结清单 + 依据版本）并置为“已发布”。

### 授权/来源变更前的影响预演与确认（本轮新增）

馆员对**单笔授权**（新增 / 修改 / 撤销 / 删除）或**单条来源关系**（新增 / 删除）可以先做**影响预演**，确认无误后再提交：

- 预演为**只读**操作：输入沿用相应现有编辑接口的字段与校验（媒介/地区/日期校验一致，会成环的关系同样被拒绝并返回闭环路径）；不改动授权、关系、包状态，也不写快照，依据版本不递增。
- 预演只列出因该变更将**由合格转为不合格**的**已发布**展览包、问题节点、原因（无授权/已撤销/媒介不符/地区不符/日期不覆盖/成环）及问题来源路径，并给出**依据版本**与**影响清单指纹**（`basisVersion` + `impactFingerprint`）。
- 确认时提交**同一操作字段**连同预演返回的依据版本与指纹。服务端在**单个 SQLite 事务**内：复查依据版本 → 复查目标有效性与输入合法性（含成环）→ 按当前数据**重算影响并比对指纹**；版本不符返回 `409 STALE_BASIS`、影响清单不符返回 `409 IMPACT_MISMATCH`、目标失效返回 `404`、输入非法返回 `400`，任一失败整体回滚，**不产生部分写入**。
- 成功后按现有规则执行变更（依据版本递增）、把由合格转不合格的已发布包标记为 `needs_review` 并追加不可变 `review` 快照；原发布快照一行不改，**需复核包不会自动恢复**（仍需人工「重新核验」）。
- 既有编辑接口（`POST/PATCH/DELETE /api/...`）的请求与返回**保持兼容**，依旧可以直接调用；前端素材页的撤销/删除/关系删除/授权修改等按钮已统一改为「先预演、面板确认」。

界面：在「① 素材与来源」页，每条授权有「修改/预演」「撤销/预演」「删除/预演」，授权表单与来源表单旁有「预演影响」；预演结果展示在页面顶部面板（受影响包、问题节点、原因、路径、依据版本与过期提示），点「确认提交此变更」完成提交。若预演后数据被他人改过，确认会被拒绝并在面板显示按当前数据重算的最新影响，需重新预演。

### 授权变更后的行为

- 授权增删改（含撤销）或来源关系增删后，系统立即重算所有已发布/需复核包。
- **仅**状态由“合格”变为“不合格”的已发布包会被置为 `needs_review`（需复核），并**追加**一条新的复核快照；原发布快照一行不改、不会删除。
- 需复核包不会自动恢复。补正授权后，在界面点「重新核验（人工复核）」：合格则恢复为已发布，不合格则保持需复核；两种结果都会再追加一条快照。
- 已发布/需复核包的参数与清单不可编辑、不可删除；需要调整时点「复制为待发布包」走新一轮核验与发布。

---

## 四、核验规则要点

| 规则 | 说明 |
| --- | --- |
| 来源方向 | 边 `素材 → 来源素材`；核验自入展品沿边向上游遍历全部路径 |
| 成环 | 新增边前做可达性预判（若来源已能到达本素材则拒绝）；核验时 DFS 再次检测并把环上节点列为不合格 |
| 授权命中 | 未撤销；媒介相等或授权媒介为 `*`；地区相等或授权地区为 `*`（忽略大小写） |
| 日期覆盖 | `授权.valid_from ≤ 使用起始` 且 `授权.valid_to ≥ 使用截止`（闭区间） |
| 节点合格 | 至少一份授权同时满足上述全部条件（单份授权必须独自覆盖整段使用期，不跨授权拼接） |
| 发布闸门 | 无全局错误、无缺失素材、无环、无不合格节点，且依据版本未过期 |

不可变性由数据库强制：`verification_snapshots` 表上配置了 `BEFORE UPDATE` / `BEFORE DELETE` 触发器，任何修改或删除都会被 SQLite 直接拒绝。

## 五、配置项（环境变量）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | HTTP 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `DB_PATH` | 本地 `./data/app.db`（容器内 `/data/app.db`） | SQLite 数据库文件路径，所在目录自动创建 |
| `SEED_DEMO` | `0`（compose 中为 `1`） | 启动时若库为空则写入演示数据 |

修改端口（例如改为 8080）：编辑 `docker-compose.yml` 的 `ports: - "8080:3000"`（宿主机端口:容器端口），或直接运行时 `-e PORT=...` 并同步映射。

## 六、数据持久化与备份

- Compose 使用命名卷 `exhibit-data` 挂载到容器 `/data`，数据库（WAL 模式）在 `docker compose down` 后仍然保留。
- 备份：`docker compose exec exhibit-auth node -e "const db=require('better-sqlite3')(process.env.DB_PATH);db.backup('/data/backup.db').then(()=>process.exit(0))"` 后从卷中取 `/data/backup.db`；或停服后直接复制 `app.db`、`app.db-wal`、`app.db-shm`。

## 七、主要 HTTP API

| 方法 路径 | 作用 |
| --- | --- |
| `GET /api/state` | 依据版本与计数 |
| `GET/POST /api/materials` · `PATCH/DELETE /api/materials/:id` | 素材 CRUD |
| `POST /api/materials/:id/sources` · `DELETE /api/source-links/:id` | 来源关系（成环返回 409 + `cyclePath`/`cycle`） |
| `POST /api/materials/:id/authorizations` · `PATCH /api/authorizations/:id` · `POST /api/authorizations/:id/revoke` · `DELETE` | 授权登记/修改/撤销/删除 |
| `GET/POST /api/packages` · `PATCH/DELETE /api/packages/:id` · `POST /api/packages/:id/copy` | 展览包 |
| `POST /api/verify` | 试核验（body 可传 `packageId` 或完整字段） |
| `POST /api/packages/:id/publish` | 发布，body 需含核验时的 `basisVersion`；过期 409、不合格 422 |
| `POST /api/packages/:id/recheck` | 对需复核包人工重新核验 |
| `POST /api/preview/impact` | **影响预演（只读）**，body 含 `op` 与相应编辑字段 |
| `POST /api/preview/confirm` | **按预演确认提交**，追加 `basisVersion` + `impactFingerprint`；过期 409 `STALE_BASIS`、清单变化 409 `IMPACT_MISMATCH` |
| `GET /api/snapshots/:id` | 读取不可变快照完整内容 |

### 影响预演 / 确认 API 字段与调用示例

`POST /api/preview/impact` 的 `op` 与字段（与现有编辑接口一一对应）：

| `op` | 必填字段 | 对应现有接口 |
| --- | --- | --- |
| `authz_create` | `materialId`、`media`、`region`、`validFrom`、`validTo`（可选 `revoked`、`licensor`、`note`） | `POST /api/materials/:id/authorizations` |
| `authz_update` | `authorizationId`，其余字段缺省沿用现值 | `PATCH /api/authorizations/:id` |
| `authz_revoke` | `authorizationId` | `POST /api/authorizations/:id/revoke` |
| `authz_delete` | `authorizationId` | `DELETE /api/authorizations/:id` |
| `link_create` | `materialId`、`sourceMaterialId`（可选 `relation`），成环返回 409 + `cyclePath`/`cycle` | `POST /api/materials/:id/sources` |
| `link_delete` | `linkId` | `DELETE /api/source-links/:id` |

预演返回（节选）：`{ dryRun, op, operation, basisVersion, affectedCount, affectedPackages:[{ packageId, name, failingNodes:[{ materialId, title, reasons, reasonText, paths }] }], impactFingerprint, message }`。

```bash
# 1) 预演：撤销某授权（不写库）
curl -s -X POST http://localhost:3000/api/preview/impact \
  -H 'Content-Type: application/json' \
  -d '{"op":"authz_revoke","authorizationId":1}'

# 2) 用预演返回的 basisVersion / impactFingerprint 确认同一操作
curl -s -X POST http://localhost:3000/api/preview/confirm \
  -H 'Content-Type: application/json' \
  -d '{"op":"authz_revoke","authorizationId":1,
       "basisVersion":10,
       "impactFingerprint":"a0ce8bf9143f747d570e8486cb8175ad2e294692ce1e5ff34ed0892758a7ee00"}'

# 预演新增/修改授权
curl -s -X POST http://localhost:3000/api/preview/impact -H 'Content-Type: application/json' -d '{
  "op":"authz_update","authorizationId":3,
  "media":"屏幕放映","region":"中国大陆",
  "validFrom":"2025-01-01","validTo":"2027-06-30"}'

# 预演新增来源关系（会成环时与现有接口一样 409 并给闭环）
curl -s -X POST http://localhost:3000/api/preview/impact -H 'Content-Type: application/json' -d '{
  "op":"link_create","materialId":5,"sourceMaterialId":4,"relation":"引用"}'
```

确认失败时的响应：`409 { details.code: "STALE_BASIS", clientBasis, currentBasis, impact, impactFingerprint }` 或 `409 { details.code: "IMPACT_MISMATCH", impact, impactFingerprint }`——两者的 `details` 都带按当前数据重算的最新影响与新指纹，前端据此提示过期并支持重新预演；此时无任何写入。

## 八、目录结构

```
.
├── Dockerfile              # 依赖安装 + 数据库初始化的多阶段镜像
├── docker-compose.yml      # 一键启动（端口 3000，命名卷持久化）
├── docker-entrypoint.sh    # 可选演示数据初始化后启动
├── package.json
├── src
│   ├── db.js               # SQLite 连接、建表、版本号/快照不可变触发器
│   ├── verify.js           # 来源链遍历、成环检测、逐节点授权核验、发布后重算（支持内存 overlay 模拟态）
│   ├── impact.js           # 变更影响预演/确认：同一套校验、影响清单指纹、事务内版本+影响双校验
│   ├── server.js           # Express API（发布事务、依据过期拒绝、预演/确认 API）
│   └── seed.js             # 演示数据
├── public                  # 浏览器前端（无构建，素材页含影响预演面板）
│   ├── index.html
│   ├── styles.css
│   └── app.js
└── test/e2e.js             # 端到端业务规则自检（39 项）
```
