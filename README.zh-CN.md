# MemHub

面向 AI 编码代理的本地记忆卡片服务。[English](README.md)

Agent 通过一次极快的 HTTP 调用把记忆写成一张张**卡片**；任何东西——hook、脚本、shell——都能用 curl 读回；人在浏览器里审阅一切。所有数据留在本机。

## 理念：记忆是卡片，不是会话记录

人的记忆是片面的、压缩的、由线索触发的——你不会回放对话，你只会想起要紧的那件事。MemHub 把同样的模型用在 agent 身上：

- **片面** —— 一次会话产出多张卡片，而不是一份纪要。每张卡是一个独立完整的要点。
- **压缩** —— 卡片存蒸馏后的梗概（一个决策、一个偏好、一个教训），绝不存原始对话。
- **基于线索** —— 每张卡携带检索线索（标题、cues、语义）；回忆靠相似触发，不靠精确匹配。

MemHub 只提供**机制**（存、取、索引、审计）。生命周期策略——相似度去重、强化、衰减——刻意留给未来的用户可配置规则。

## 快速开始

```bash
npm install -g memhub
memhub server          # 启动守护进程（后台，127.0.0.1:7800）
```

从 agent hook 写入一张卡：

```bash
curl -s -X POST http://127.0.0.1:7800/api/cards \
  -H "x-memhub-token: $(cat ~/.memhub/token)" \
  -H "content-type: application/json" \
  -d '{"title":"本仓库使用pnpm","body":"所有命令都用 **npx pnpm** 执行。","type":"preference","cues":["pnpm","构建"],"writer":"claude-hook"}'
# → 202 {"id":1,"indexed":false}  （索引在后台完成）
```

检索——关键词立即可用，本地 embedding 模型加载完成后语义检索自动生效：

```bash
curl -s -X POST http://127.0.0.1:7800/api/search \
  -H "x-memhub-token: $(cat ~/.memhub/token)" \
  -H "content-type: application/json" \
  -d '{"query":"包管理器"}'
```

浏览器打开 **http://127.0.0.1:7800/**：浏览卡片、阅读渲染后的 markdown、查看活动流。

```bash
memhub status          # pid、uptime、卡片统计、队列积压
memhub stop            # 优雅停止（5 秒后强杀）
```

## 工作原理

```
hook (curl) ──► HTTP API ──► SQLite（cards、events、activity log）   ← 单事务，202
                                 │
                                 ▼ 后台 worker
                             embedding ──► LanceDB（可随时重建的派生索引）
```

- **SQLite 是唯一真相源**（`~/.memhub/memhub.db`，WAL 模式）；FTS5 与向量索引都是派生物——`memhub reindex` 可随时重建。
- **事件驱动索引** —— worker 以事务化 offset 消费事件表；失败项记录后跳过，每小时补偿扫描兜底。
- **刚写入的卡永远可搜** —— 关键词检索（FTS5 + cues）覆盖尚未索引的卡，"存在性"从不最终一致。
- **本地与隐私** —— 仅监听 127.0.0.1、token 鉴权、拒绝非本地 `Host` 头、无外部服务。

## 命令与 API

| 命令 | 说明 |
| --- | --- |
| `memhub server [--port] [--foreground]` | 启动守护进程（防重复启动） |
| `memhub status` | 健康状态、统计、队列积压 |
| `memhub stop` | 优雅停止，超时强杀兜底 |
| `memhub reindex` | 从 SQLite 全量重建向量索引 |

| API | 说明 |
| --- | --- |
| `POST /api/cards` | 写卡（`202`，title+body 相同幂等复用） |
| `GET /api/cards`、`GET/PATCH/DELETE /api/cards/:id` | 列表（游标分页）、读取、编辑（自动重建索引）、归档 |
| `POST /api/cards/:id/invalidate` | 标记被取代 |
| `POST /api/search` | `mode: auto\|semantic\|keyword`，始终包含未索引卡 |
| `GET /api/activity` · `GET /api/queue` | 审计日志、队列统计 |
| `GET /healthz` | 公开健康检查 |

卡片类型：`fact | preference | decision | insight | pattern`。完整参考：[docs/user-guide.md](docs/user-guide.md)。

## 配置

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `MEMHUB_HOME` | `~/.memhub` | 数据目录（数据库、token、日志、模型） |

## 开发说明

需要 Node.js >= 24（`node:sqlite`）。

```bash
npx pnpm install
npx pnpm run build        # 仅编译 TypeScript
npx pnpm run build:web    # 构建 Web UI
npx pnpm run quality      # lint + typecheck + format + coverage(≥80%) + build
```

源码布局：`src/cli`（CLI）· `src/daemon` · `src/db`（SQLite）· `src/http`（Hono API）· `src/embedding` + `src/storage`（向量）· `src/worker`（事件 worker）· `web/`（Preact UI）· `test/` 镜像 `src/`。

## 路线图

- [x] v1 —— 守护进程、卡片存储、HTTP API、关键词 + 语义检索、后台索引、只读 Web 页面
- [ ] v1 之后 —— 相似度去重、reinforce/decay 规则、卡片编辑器、merge/unmerge、导出

范围刻意保持最小；后续迭代以真实用户反馈为依据。

## License

MIT
