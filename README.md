<p align="center">
  <img src="docs/assets/dsh-memory-logo.png" alt="dsh-memory logo" width="180" />
</p>

<h1 align="center">dsh-memory</h1>

<p align="center">
  为 DeepSeek-Harness 提供长期记忆：本机 Markdown 权威存储、Session 自动整理、可逆遗忘与跨记录治理。
</p>

<p align="center">
  中文 · <a href="README.en.md">English</a>
</p>

<p align="center">
  <img src="https://badgen.net/badge/license/MIT/green" alt="MIT license" />
  <img src="https://badgen.net/badge/format/DSH%20bundle/8257D0" alt="DSH bundle" />
</p>

<div align="center">

[它是什么](#它是什么) · [做了什么](#做了什么) · [功能](#功能) · [如何使用](#如何使用) · [数据与隐私](#数据与隐私) · [文档](#文档)

</div>

## 它是什么

`dsh-memory` 是 DeepSeek-Harness 的一个本地长期记忆插件。

它把 Agent 需要跨会话记住的东西——用户偏好、项目约束、验证过的经验——保存在用户自己机器上的 Markdown 文件里，并在后续对话中按需提供给 Agent。

三个特征决定了它和其他记忆方案的区别：

**权威数据是 Markdown 文件，不是数据库。** 每条记忆都是一个可以直接阅读、编辑、备份的 `.md` 文件。没有向量库，没有独立服务，没有加密容器。你可以用任何编辑器打开它，也可以在文件管理器里直接复制走。

**只把索引放进上下文。** 每次请求注入的是 Global 记忆加当前工作区的**索引**，不是全部正文。Agent 看到条目名，需要细节时再用 DSH 已有的文件工具读取那一份。上下文开销不随记忆总量线性增长。

**状态与正文分离。** 一条记忆是否活跃、多久没被用到、是否和另一条冲突——这些写在独立的治理侧写里。正文永远不动，所以任何整理都可以回退。

它与 DSH 的模型、会话、文件系统服务协同工作，但不替它们做决定。

## 做了什么

插件在四个层面工作。

### 1. 分层存储与按需披露

记忆分两级存放：

| 层级 | 位置 | 内容 |
|---|---|---|
| Global | `$DSH_HOME/memory/GLOBAL.md` | 跨项目生效的偏好与通用规则 |
| Workspace | `$DSH_HOME/memory/workspaces/<key>/` | 只属于当前项目的记录 |

注入时提供 Global 全文与当前工作区的索引。工作区索引是一份自动生成、可随时重建的条目清单，指向真正的记录文件。

### 2. Session 整理

已结束且稳定的对话可以被整理成长期记忆。

流程是：用户手动触发 → 筛选符合条件的 Session → 独立的整理 Agent 阅读证据并提出变更 → Host 校验证据归属与数据版本 → 原子写入并保存结果。

模型只负责**提议**。记忆归属哪个工作区、内容是否与证据一致、版本是否已被别人改过——这些由确定性代码判断，不由模型决定。

### 3. 记忆治理

一条记忆会变旧、会被新事实取代、会和另一条矛盾、会重要到不能忘、也会因为一次网络抖动被误判成坏的。治理层管理这些状态：

- **重要性分档**：critical / durable / working / transient，由可观察信号计算，不由模型打分
- **生命周期**：`active → cooled → archived`，只改「是否出现在提示词里」
- **冲突分类**：硬冲突、时间演进、环境分裂、间歇性问题——四种处理方式不同
- **遗忘复核**：先给出「将会发生什么」的报告，确认后才执行

**遗忘不改 Markdown。** 被「遗忘」的记录仍然完整地躺在磁盘上，只是不再自动出现在提示词里。想让某条回来，改回状态即可。

**没有任何路径产出删除。** 物理删除是一件需要明确开口要求的事，不在任何自动化流程里。

### 4. 跨记录提案（Dream）

Dream 读取已存在的记录，提出如何整理它们：合并重复、标记取代关系、标出矛盾、调整优先级。

八种动作，四种改正文（merge / supersede / extract-sop / promote-global），四种只改元数据（mark-contested / set-priority / cool / archive）。**没有删除。**

默认模式是 `shadow`：能计算、能显示，但不改任何东西。内容变更在任何模式下都需要你逐个动作勾选批准。

## 功能

### 设置页

插件在 DSH Settings 中提供六个标签：

| 标签 | 用途 |
|---|---|
| 全局记忆 | 查看和编辑对所有工作区生效的 `GLOBAL.md` |
| 工作区记忆 | 浏览、创建、修改当前项目的记录 |
| 会话整理 | 浏览可整理的 Session，触发整理，查看最近结果 |
| 遗忘复核 | 查看遗忘策略「将会做什么」，确认后执行 |
| 梦境整理 | 运行 Dream，逐条审阅并批准它提出的变更 |
| 设置 | 选择整理模型、开启 Debug 日志、设置遗忘与 Dream 模式 |

### 接口

插件通过 `/memory` 暴露 18 个 RPC 端点，供设置页调用：

```
status                      global/read              global/replace
workspaces/list             workspace/read           workspace/commit
sessions/list               sessions/consolidate
models/read                 models/select
governance/status           governance/forgetting    governance/initialize
dream/status                dream/run
dream/proposal/read         dream/proposal/approve   dream/proposal/reject
```

Web 管理接口只允许本机访问。

### 扩展点

记忆治理本身不判断外部世界的事实。网络是否通畅、代理是否稳定、某个模型是否可用——这些由外部模块提供，通过两个可选接口接入：

- **verification provider**：报告「这条记录是否仍然成立」
- **trigger provider**：决定「什么时候该跑一轮治理」

两者都可以不装。不装时功能降级为手动操作，而不是报错。契约见 [治理 provider 契约](docs/governance-providers.md)。

### 可观察性

每次整理与每次 Dream 运行都保存一条结果记录。可选 Debug 日志记录各阶段与错误链，但不复制对话正文、记忆正文或凭据。

## 如何使用

### 安装

**npm：**

```sh
dsh plugin --profile web add @hr98w/dsh-memory
```

**补丁分支（DSH ≥ 0.2.1-rc.2）：**

```sh
dsh plugin --profile desktop add "github:xuemingze/dsh-memory-patched#v0.1.5"
```

**从源码：**

```sh
pnpm install
pnpm run build
dsh plugin --profile web add .
```

安装后必须**完全重启** DSH。只刷新页面不会加载新的 Host 代码。

### 第一次使用

在任意工作区对 Agent 说：

> 记住，这个项目的发布检查代号是松果，每次发布前先提醒我检查回滚方案。

确认写入成功后，新建同一工作区的 Session，问：

> 这个项目发布前有什么约定？

如果回答沿用了约定，记忆就在工作。可以在「工作区记忆」里查看对应的 Markdown 文件。

**项目约定不要放进 Global**——那会让它出现在所有不相关的项目里。

### 整理历史对话

1. 在 DSH 的 Models 页面配置并激活至少一个文本模型
2. 打开「设置 → 记忆 → 设置」，选择整理使用的模型
3. 在「会话整理」中选择一个已经结束且稳定的 Session
4. 点击整理，等待完成
5. 检查结果；如需排错，在设置页开启 Debug 后重新触发

整理使用的是独立模型，与日常对话使用的模型无关。

### 审阅遗忘

1. 打开「遗忘复核」
2. 查看报告——它会列出「将会冷却」「将会归档」的条目
3. 逐条核对，确认没有误伤重要记忆
4. 确认后执行

报告为空是正常结果：说明还没有记录达到冷却条件。

### 使用 Dream

1. 打开「梦境整理」
2. 点击「运行一次」——这只会生成提案，不改任何东西
3. 提案出现在「待批准」区域，每条动作带风险标签
4. 勾选认同的动作，或选择理由码全部拒绝
5. 批准后写入；被拒绝的动作下次运行时会标记为「已拒绝」

`metadata-only` 的动作（调整优先级、降低可见度、归档）可以用另一个元数据操作撤回。`content-change` 的动作（合并、取代）无法自动重建，所以两者分开标记。

### 开发

```sh
pnpm run typecheck
pnpm run test
pnpm run build
pnpm run check
```

提交前运行 `pnpm run check`。贡献流程见 [CONTRIBUTING.md](CONTRIBUTING.md)，验证方式见 [docs/development.md](docs/development.md)。

## 数据与隐私

默认数据布局：

```text
$DSH_HOME/memory/
├── GLOBAL.md                            # 跨工作区记忆
├── settings.yml                         # 模型选择与各功能模式
├── consolidator-workspace/              # 内部整理 Session 的专属 cwd
├── debug/<review-id>/attempt-<n>.jsonl  # 仅在开启 Debug 后写入
├── reviews/<review-id>.md               # 每次整理的结果记录
├── dream/                               # Dream 回执与待批准计划
├── governance/workspaces/<key>.json     # 治理侧写：状态、分数、冲突
└── workspaces/<key>/
    ├── MEMORY.md                        # 自动生成的索引，可重建
    └── <name>.md                        # 权威详细记忆
```

- Web 管理接口只允许本机访问
- Web 的记忆写入请求不提交记忆根目录、绝对路径或内部工作区 key
- Debug 默认关闭，不记录对话证据、记忆正文、模型提议正文或 API key
- `MEMORY.md` 是可重建索引；详细 Markdown 才是权威数据
- 治理侧写与 Markdown 分离：改状态不碰正文，所以任何整理都可回退

**并发保护限于同一个 MemoryStore 实例。** 请让一个 DSH 进程负责同一 `$DSH_HOME` 的记忆写入。多个独立进程共享目录并发写入仍可能互相覆盖。

**「本地优先」指权威数据在本机，不是指全部处理离线完成。** 正常对话会把当前可见的记忆上下文发送给该会话使用的模型；手动整理会把筛选后的对话内容发送给设置页选择的模型服务商。请根据服务商的隐私政策决定是否启用。

安全问题请查看 [SECURITY.md](SECURITY.md)。

## 评测

仓库内置与发布代码隔离的 [LoCoMo-10 评测](benchmark/locomo/README.md)，可对比无记忆 baseline、仅在线记忆、在线记忆加 Session 整理三种模式。

![LoCoMo-10 三种模式准确率对比](docs/assets/locomo10-accuracy.svg)

保留的完整结果中，Baseline 为 2.60%，Memory 为 73.05%，Memory + Consolidate 为 77.60%。这是每组一份完整结果，不是多次实验的平均值，也不是与其他记忆系统的横向比较。[实验复盘](docs/locomo-retrospective.md)记录了设置与局限。

## 文档

- [架构](docs/architecture.md)：组件与 Host/Browser 请求流
- [设计](docs/design.md)：产品规则与边界
- [Session 整理设计](docs/session-consolidation.md)：完整流程、状态机与数据契约
- [Dream 契约](docs/dream.md)：动作词表、审批流程与写入边界
- [治理 provider 契约](docs/governance-providers.md)：外部模块如何供给观察
- [路线图](docs/roadmap.md)：已完成里程碑与后续方向
- [开发指南](docs/development.md)：命令、验证矩阵与发布步骤
- [LoCoMo-10 评测](benchmark/locomo/README.md)：隔离运行、Judge、Score 与成本统计
- [决策记录](docs/decisions/implemented/)：非平凡架构、行为与协议选择

## License

[MIT](LICENSE) © 2026 hr98w
