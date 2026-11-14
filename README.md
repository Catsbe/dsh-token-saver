# dsh-token-saver

适用于 [DeepSeek Harness](https://www.deepseek.com/harness/) 的**省 token / 省步数**插件。v0.3.x 在保留“append-only、不改工具集、不改写历史”的前提下，提供三组核心能力：

- **count-first 输出模式（借鉴 dsh-ops）**：`grep` / `glob` 的大结果先给计数、文件列表和目录/扩展名分布，全文仍在 spill 文件里，一条 `read` 随时取回。
- **结构化压缩 + never-worse 门槛（借鉴 dsh-plugin-save-token）**：JSON / JSONL → TOON 表，表格 → 带行号的 stride 采样，日志 → 保留错误行的折叠，其他文本 → 头尾窗口；只有“字节 ≤ 原 72% 且 token 严格下降且至少省 500B”才采纳，否则原样放行。
- **shadow 验证 + 跨轮去重（借鉴 dsh-sieve / dsh-plugin-save-token）**：`shadow: true` 只记录“本来会怎么压”，不改变任何结果，适合先跑一段时间验证收益；同一会话内 byte-identical 的大结果在 TTL 内折叠成短 stub，指向之前的 spill 文件。

> 可与 [`dsh-context`](https://github.com/bowenliang123/dsh-context) 配合：后者用来看钱和时间花在哪，`dsh-token-saver` 用来省。两者互补。

## 它解决什么

一轮对话的费用 ≈ `步数 × 每步上下文`，时间 ≈ `步数 × 首 token 等待 + 生成`。所以最贵的杠杆是**减少步数**和**压住每步里不断累积的工具输出**。

dsh-token-saver 不重造 DSH 内置的 `spill-policy`、`tool-result-pruner`、`repeat-tool-reminder`，而是补它们的空隙：

- 内置 `spill-policy` 的默认内联预算约 12.5k token；本插件按工具收紧到 4k（可配），并先做结构化压缩。
- 内置 `repeat-tool-reminder` 只抓完全相同的重复调用；本插件的跨轮去重抓 byte-identical 的**结果**，直接折叠成 stub。
- 内置 `tool-result-pruner` 只在压缩时剪旧结果；本插件在结果进入上下文前就处理，历史保持稳定。

## 模块 A · 步数优化（零缓存风险）

- **A1 批量引导**：注入一段静态系统提示，要求“先规划、把彼此独立的工具调用放进同一条回复并行发出、复用已有结果”。
- **A2 软步数预算**：每轮计数模型步数，到阈值（默认第 12、20 步）在工具结果后追加一条提醒，让模型合并剩余操作或收尾。**只劝不拦**。
- **A3 重复读取提醒**：同一文件、未编辑、又读了一个已读范围内的子区间时，轻提醒一次（每文件每轮最多一次）；`edit` / `write` 会使记录失效。

## 模块 B · 结果整形（只“外置”，不“丢弃”）

### B1 count-first：grep / glob

- `grep` 输出超过预算时，优先输出：
  - 总匹配数、匹配文件数；
  - 按匹配数排序的 Top 文件；
  - 前几个文件的样例匹配（带行号）；
  - spill 文件路径，完整结果可用 `read` / `grep` 取回。
- `glob` 输出超过预算时，优先输出：
  - 文件总数；
  - 按扩展名、目录的分布；
  - 前 10 个路径；
  - spill 文件路径。

这对应 dsh-ops 的 `output_mode=count` / `files_with_matches` 思路，但**不需要替换工具**，对官方 `grep`/`glob` 同样生效；也兼容 `ops_grep` / `ops_glob`。

### B2 结构化压缩

按工具 profile 自动选择：

| profile | 适用工具（默认） | 策略 |
|---|---|---|
| `matches` | `grep` / `ops_grep` | count-first 摘要 |
| `paths` | `glob` / `ops_glob` | 扩展名/目录分布摘要 |
| `log` | `pwsh` / `bash` / `ops_bash` | 保留 error/fatal/traceback/timeout/FAIL 行 ±1 行、测试 summary 与首尾；中间 passing 行折叠为 `[... N lines omitted (Lx-Ly) ...]` |
| `table` | 可显式配置 | 头 60 行 + 中间按步长采样（带原始行号）+ 尾 40 行 |
| `json` | 可显式配置 | 均匀 JSON 数组 → TOON 表（keys 只写一次，零信息损失）；JSONL 同样处理 |
| `article` | `web_fetch` | 去掉重复导航行、压缩空行后做头尾窗口 |
| `auto` | 其他 | 依次尝试 JSON / JSONL / grep / glob / log / table，最后头尾窗口 |

### B3 never-worse 门槛

每个候选结果必须同时满足：

- 压缩后字节数 ≤ 原始的 `keepRatioMax`（默认 **0.72**）；
- 绝对节省 ≥ `minSavingBytes`（默认 **500B**）；
- 估计 token 严格下降。

任一不满足，结果**原样放行**，不落盘、不改写。这避免“为了省 token 反而多一次 read/重试”的情况。

### B4 跨轮去重

- 以 `tool name + arguments + full result` 计算 SHA-256；
- 同一 agent 会话内，TTL（默认 **10 分钟**）内再次出现 byte-identical 大结果时，替换为：
  `(Duplicate output: byte-identical to a result from step N. Full text stored at: … )`
- 第一次结果已经落盘，因此 stub 永远指向可读回的全文；不会丢信息。
- 每个 agent 最多保留 200 条去重索引，自动淘汰最旧条目。

### B5 shadow 模式

```yaml
- id: dsh-token-saver
  config:
    shadow: true
```

- 只计算“本来会压缩/去重多少”，**不写 spill 文件、不改结果**。
- 适合先跑 3–7 天，确认没有误判、任务成功率不受影响，再切回 `shadow: false`。
- 每个 agent 的统计可通过 `/token-saver stats` 查看；`/token-saver reset` 清零。

## 配置

在 profile 的 `cordis.patch.yml` 里按 id 覆盖（或用插件 Configuration 表单）：

```yaml
- id: dsh-token-saver
  config:
    enabled: true
    batchGuidance: true
    stepThresholds: [12, 20]
    redundantReadReminder: true

    # B：参与结果整形的工具（支持 `ops_*` 家族匹配）
    spillTools:
      - pwsh
      - bash
      - ops_bash
      - web_fetch
      - grep
      - ops_grep
      - glob
      - ops_glob
    spillMaxTokens: 4000

    # 每个工具的 profile 与独立预算；maxTokens: 0 表示用 spillMaxTokens
    toolProfiles:
      - { tool: grep,      profile: matches, maxTokens: 1500 }
      - { tool: ops_grep,  profile: matches, maxTokens: 1500 }
      - { tool: glob,      profile: paths,   maxTokens: 1000 }
      - { tool: ops_glob,  profile: paths,   maxTokens: 1000 }
      - { tool: pwsh,      profile: log,     maxTokens: 4000 }
      - { tool: bash,      profile: log,     maxTokens: 4000 }
      - { tool: ops_bash,  profile: log,     maxTokens: 4000 }
      - { tool: web_fetch, profile: article, maxTokens: 6000 }

    shadow: false
    keepRatioMax: 0.72
    minSavingBytes: 500
    dedupe: true
    dedupeTtlMs: 600000
    includeSubagents: true
    stats: true
```

- 想更保守：`shadow: true` 先观察；或把 `spillMaxTokens` 调大（如 8000），或减少 `spillTools`。
- 想更省：把 `spillMaxTokens` 调小、把更多工具加进 `spillTools`、或把 `keepRatioMax` 调到 0.6。
- 只想要 A：`spillTools: []`。只想要 B：`batchGuidance: false, stepThresholds: [], redundantReadReminder: false`。

**默认排除**：`read`、`edit`、`write`、`ops_inspect_local_file`、`ops_read_files`、`ops_edit_file`、`ops_write_file`、`ops_stat`，以及 billion-context 注入的 `compress` / `decompress` / `search_context` / `acp_status`。这些工具的结果永不压缩。

## 怎么验证效果

1. **先 shadow**：`shadow: true` 跑 3–7 天，用 `/token-saver stats` 看 `shadowWouldCompress` / `shadowWouldDedupe` 与估算节省。
2. **再 A/B**：同一组任务（建议 10–20 个）开/关各跑一遍，用 [dsh-context](https://github.com/bowenliang123/dsh-context) 对比：
   - 计费 token、缓存命中率、预估费用；
   - 步数、工具调用次数、总时长；
   - **spill 回读率**：如果模型经常把 spill 文件又完整读回来，说明阈值过低，应调大；
   - 任务成功率：不能下降。
3. **直接观察 B**：跑一条大输出命令（如 `1..2500 | % { "line $_ ..." }`），结果会变成摘要/预览 + `(Omitted N bytes. Full formatted result stored at: …)`；用 `read`/`grep` 那个路径可取回全文。

建议验收线：**成本下降 ≥15%、成功率不降、cache hit 不低于基线 2 个百分点、额外 step ≤5%**。

## 安装

需要 `dsh` CLI（见 [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh)）。把本仓库克隆/下载到本地后，用 `link:` 方式装入 profile（live 开发链接，改源码即生效）：

```sh
# 将 <path-to-dsh-token-saver> 换成本仓库在你机器上的绝对路径
dsh plugin --profile web add "link:<path-to-dsh-token-saver>"
```

或在 DeepSeek Harness 的 **Add plugin** 向导里选择本地目录安装。安装后 `package.json` 的 `dsh.profile.bundles` 会含 `dsh-token-saver`，`cordis.patch.yml` 会插入加载行。

> 依赖（`@deepseek-ai/cordis`、`dsh-llm`、`dsh-token-meter`、`schemastery`）由 Harness 运行时提供，无需单独安装。

## 测试

隔离测试（mock cordis 上下文，驱动真实事件契约），无需安装依赖、开箱即跑：

```sh
node test/run.mjs
```

覆盖 A1/A2/A3、B 的全 profile、never-worse 门槛、跨轮去重、shadow、`ops_*` 工具名、子代理作用域与总开关，共 **74 条断言**。测试所需的 peer 桩由 `run.mjs` 运行时自动生成在 `test/node_modules`（已被 gitignore），**不会**污染生产（包根目录无 node_modules）。

## 设计边界（为什么不做“懒加载工具”）

曾评估“工具/插件/MCP 懒加载”，但：

1. 并非所有路由都支持协议级 `deferLoading` / 中途加工具（例如部分 OpenAI 兼容网关）。
2. 工具定义在 prompt 最前，**增删工具会从第一个变化的 schema token 起使缓存失效**；在高缓存命中的会话里，一次中途激活的重算成本可能吃掉数倍节省。

因此本插件专注**零缓存风险**的 A + B，不做懒加载、不替换工具、不改写历史。

## 版本记录

- **0.3.1**：
  - **结构化压缩预算硬上限**（`fitStructuredBudget`）：`jsonToToon` / `jsonlToToon` / `tableToStride` / `logToElision` / `grepToCountFirst` / `globToPaths` 输出统一校验 `profile.maxTokens` 预算，超限时自动收口，避免触发外层内置 `spill-policy` 的二次 spill。
  - **工具名与文件操作追踪补全**：`matchesTool()` 新增前缀匹配以兼容 `pwsh_persistent` / `bash_persistent` 等持久终端工具；`observeRead()` 同步跟踪 `ops_edit_file`、`ops_write_file` 与 `str_replace_editor` 的文件修改失效。
- **0.3.0**：新增 `grep`/`glob` count-first 摘要、结构化压缩（TOON / stride / 日志错误行保留）、never-worse 门槛、跨轮去重、shadow 模式与 `/token-saver stats`。

## 许可

Apache-2.0
