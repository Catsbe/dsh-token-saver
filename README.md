# dsh-lean

适用于 [DeepSeek Harness](https://www.deepseek.com/harness/) 的**省 token / 省步数**插件。只做两件事，且都是**追加式（append-only）**——不改工具集、不改写历史，因此 **KV 缓存前缀保持稳定**，不会像"懒加载工具"那样炸缓存。

> 可与 [`dsh-context`](https://github.com/bowenliang123/dsh-context) 配合：后者用来**看**钱和时间花在哪，`dsh-lean` 用来**省**。两者互补。

## 它解决什么

一轮对话的费用 ≈ `步数 × 每步上下文`，时间 ≈ `步数 × 首token等待 + 生成`。所以最贵的杠杆是**减少步数**和**压住每步里不断累积的工具输出**。dsh-lean 两个模块分别打这两点：

### 模块 A · 步数优化（零缓存风险）
- **A1 批量引导**：注入一段静态系统提示，要求"先规划、把彼此独立的工具调用放进同一条回复并行发出、复用已有结果"。DSH 本就支持并行（`maxParallelToolCalls` 默认 10），模型有时会忽略。
- **A2 软步数预算**：每轮计数模型步数，到阈值（默认第 12、20 步）在工具结果后**追加一条提醒**，让模型合并剩余操作或收尾。**只劝不拦**，与官方 `repeat-tool-reminder` 同一哲学。
- **A3 重复读取提醒**：同一文件、未编辑、又读了一个**已读范围内的子区间**时，轻提醒一次（每文件每轮最多一次），避免"换个 offset 反复读同一文件"。`edit`/`write` 会使该文件的记录失效。

### 模块 B · 保守输出管理（只"外置"，不"丢弃"）
- 对**指定工具**（默认 `pwsh`、`web_fetch`）设更紧的内联预算（默认 **4000 token**）。
- 超预算的文本结果 → **头尾预览 + 全文落盘 + 路径**。全文 100% 可用 `read`/`grep` 读回，模型读取能力不受损，只是按需翻页。
- **绝不碰 `read`/`edit`**；只处理新结果，绝不改写历史。
- 复用官方 `ctx.spillStore` 后端，通知措辞与内置 `spill-policy` 完全一致，模型认得。

## 与内置机制的关系（重要，避免误解）

DSH 的 `dsh-base` 默认已经挂了：
- `spill-policy`（`maxInlineTokens: 12500`）：单条结果超 ~12.5k token 自动头尾预览+落盘。
- `tool-result-pruner`：压缩时剪旧的大结果。
- `repeat-tool-reminder`（3/5/8 次）：**完全相同**的重复调用提醒。

dsh-lean **不重造**这些，而是补空隙：
- A3 抓的是**近似重复**（换 offset 的子集重读），官方只抓完全相同。
- B 把 `pwsh`/`web_fetch` 从官方 12.5k **收紧到 4k**。实现上 dsh-lean 的监听器**追加（不 prepend）**，跑在内置 `spill-policy` 的**内层**，因此拿到的是原始结果、**只落盘一次**，外层内置策略看到已 ≤4k 就直接放行，不会二次落盘。

**一个诚实的细节**：`pwsh` 工具自身会先截断输出并给出完整输出路径，然后才轮到 dsh-lean。所以 dsh-lean 的落盘文件装的是"pwsh 已保留的那份"，而**真正的全量输出路径仍保留在通知里**，没有任何信息丢失。

## 安装

需要 `dsh` CLI（见 [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh)）。把本仓库克隆/下载到本地后，用 `link:` 方式装入你的 profile（live 开发链接，改源码即生效）：

```sh
# 将 <path-to-dsh-lean> 换成本仓库在你机器上的绝对路径
dsh plugin --profile web add "link:<path-to-dsh-lean>"
```

或在 DeepSeek Harness 的 **Add plugin** 向导里选择本地目录安装。安装后 `package.json` 的 `dsh.profile.bundles` 会含 `dsh-lean`，`cordis.patch.yml` 会插入加载行。

> 依赖（`@deepseek-ai/cordis`、`dsh-llm`、`dsh-token-meter`、`schemastery`）由 Harness 运行时提供，无需单独安装。

## 配置

在 profile 的 `cordis.patch.yml` 里按 id 覆盖（或用插件 Configuration 表单）：
```yaml
- id: dsh-lean
  config:
    enabled: true              # 总开关
    batchGuidance: true        # A1 批量引导
    stepThresholds: [12, 20]   # A2 软步数预算阈值；[] 关闭
    redundantReadReminder: true# A3 子集重读提醒
    spillTools: [pwsh, web_fetch]  # B 收紧的工具（可加 bash / grep / glob 等）
    spillMaxTokens: 4000       # B 内联预算（估计 token）
```
- 想更保守：把 `spillMaxTokens` 调大（如 8000），或 `spillTools: []` 关掉 B。
- 想更省：把 `spillMaxTokens` 调小、或把更多工具加进 `spillTools`。
- 只想要 A：`spillTools: []`。只想要 B：`batchGuidance:false, stepThresholds:[], redundantReadReminder:false`。

## 怎么验证效果

用 **dsh-context**，同一任务开/关各跑一遍，对比：
- **步数**（上下文统计）：A 生效应下降。
- **工具调用 token / 工具结果占比**（Token 统计环形图）：B 生效应下降。
- **计费 token、预估费用、活跃时长**：整体应下降。
- **缓存命中**：应保持高位（dsh-lean 不动工具集/历史，不应拉低缓存）。

直接观察 B：跑一条大输出命令（如 `1..2500 | % { "line $_ ..." }`），结果会变成头尾预览 + `(Omitted N bytes. Full formatted result stored at: …)`，用 `read`/`grep` 那个路径可取回全文。

> 注意：时长还取决于模型产出多少内容；插件本身几乎不增加延迟（提醒是几十字、落盘是毫秒级写文件）。

## 测试

隔离测试（mock cordis 上下文，驱动真实事件契约），无需安装依赖、开箱即跑：
```sh
node test/run.mjs
```
覆盖 A1/A2/A3/B、B 与内置 spill-policy 的顺序/不重复落盘、作用域守卫、总开关，共 32 断言。测试所需的 peer 桩由 `run.mjs` 运行时自动生成在 `test/node_modules`（已被 gitignore），**不会**污染生产（包根目录无 node_modules）。

## 设计边界（为什么不做"懒加载工具"）

曾评估"工具/插件/MCP 懒加载"，但：
1. 并非所有路由都支持协议级 `deferLoading`/中途加工具（例如部分 OpenAI 兼容网关）。
2. 工具定义在 prompt 最前，**增删工具会从第一个变化的 schema token 起使缓存失效**；在高缓存命中的会话里，一次中途激活的重算成本可能吃掉数倍节省。

因此本插件专注**零缓存风险**的 A+B，不做懒加载。

## 许可
Apache-2.0
