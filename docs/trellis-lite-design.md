# trellis-lite 设计（待确认）

> 状态：设计稿，未实现。确认后按「实现顺序」小步提交。
> 基线：Trellis `v0.7.0-beta.4`（`be9e19b`），对照 `v0.6.17`（`833a584`）、`main`（`f089cb3`）、mini-trellis `main`（`74f2dfa`）。
> 许可：pi-preset 保持 MIT。本文和后续实现都是 clean-room：上游只用来确认行为、目录和文件格式，规格用自己的话写在这里，实现照本文写，不对照上游源码翻译。

## 0. 名称

工作名 `trellis-lite`。候选：

| 名称 | 优点 | 缺点 |
|---|---|---|
| **`trellis-lite`**（推荐） | 一看就知道兼容 `.trellis/` 数据；命令 `/trellis-lite`、技能前缀 `trellis-` 都顺 | 名字里带上游项目名，需要在 README 写清「不是 Mindfold 官方产品」 |
| `espalier` | 独立名字（树墙，trellis 的近义词），不会被误认为官方 | 不直观，用户要多记一个词 |

下文一律写 `trellis-lite`。改名只影响命令名、文件名和 env 前缀。

## 1. 调研结论

### 1.1 Trellis 上游

- **beta.4 相对 0.6.17 的真实增量**（`git diff --stat v0.6.17 v0.7.0-beta.4 -- packages/cli/src/templates`：38 个文件，+3131/−134）：
  1. **按路径注入 spec**：`spec_match.py`（frontmatter 解析与 glob）、`spec_inject.py`（决策与预算）、`shared-hooks/inject-spec-context.py`（Claude/Codex 等的 PreToolUse 钩子，844 行）、OpenCode 插件 `inject-spec-context.js`、`config.yaml` 新增 `spec_injection` 段。**pi 扩展没有任何对应实现**，beta 的 pi 扩展只改了 workflow 变体选择和一个 UTF-8 截断 bug。
  2. **workflow 变体**：`.trellis/workflows/<id>.md`，按 task.json → `.developer` 的 `workflow=` → `config.yaml` 的 `default_workflow` → `workflow.md` 四级选择。
  3. 其余是 DSH 平台模板、Codex 钩子、各平台 session-start 的小改动。
- **main 在 0.6.17 之后**只有 1 个模板相关修复（`36292d64`：归档任务时自动提交不再带上已移走的路径），beta 里没有。它修的是「归档后自动 commit」，trellis-lite 不自动 commit，不受影响，记入决策日志即可。
- **beta 的注入模型**：首次命中全文注入；内容不变且在刷新窗口（默认 45 分钟）内保持沉默；窗口过后发一条简短提醒；spec 被修改、或 `/clear`、`/compact` 之后重新全文注入。预算按字符算（每个 spec 9400、每次 9500），超出降级为「路径 + 描述」的索引行。
- **frontmatter / glob 约定**（这是接口，trellis-lite 兼容）：只认第一行恰好是 `---` 的块；识别 `paths`、`name`、`description`；`paths` 可写块列表或 `[a, b]`；glob 相对仓库根、用 `/`；`*` 不跨段、`?` 一个字符、整段 `**` 匹配零到多段、结尾 `/` 等于 `/**`；拒绝空串、开头 `/`、`..` 段、反斜杠、控制字符；macOS/Windows 上不区分大小写；多个 spec 命中时更具体的 glob 排前面。

### 1.2 mini-trellis：你的评价逐条核对

| 你的评价 | 核对结果 |
|---|---|
| 方向正确 | **同意**。只注入路径、不注入正文，只保留记忆层，这两点都对 |
| 仍有大块 Python | **属实**，而且比你说的还多：模板里 Python 共约 388KB（`task_store.py` 76KB、`add_session.py` 57KB、`cli_adapter.py` 33KB、`active_task.py` 32KB……）。另外它没有任务功能，却还带着 `task_store.py` |
| 背四个宿主的 CLI | **属实**：Claude Code、Codex、OpenCode、Pi |
| 删掉了任务规划 | **属实，而且更激进**：`migrate` 会把 `.trellis/tasks/<x>/` 整体搬成 `.trellis/research/<x>/`，`prd.md`、`task.json`、`implement*` 移到 `legacy/` 或删除。**这和你的兼容要求冲突**，trellis-lite 不能照这样做 |
| pi 扩展在加载时用 `process.cwd()` 一次性计算 | **属实**。补充三点：① `/resume` 到别的项目的会话时，算出的是启动目录的内容；② 它在 `before_agent_start` 里返回整段 `systemPrompt`，走的是「整体替换系统提示」这条路。pi 1.1 文档建议改 `systemPromptOptions.sections`，这样 pi 只追加差量；③ 每次 `session_start` 都弹通知 |

mini-trellis 值得借鉴的：注入有上限（≤4000 字符）、不重复注入、研究笔记单独成目录、「什么时候才值得记录」的触发规则写得清楚。

### 1.3 pi 1.1 的能力（决定了几处设计）

- **按项目提供 skill 有现成机制**：`resources_discover` 事件。它在每个会话 `session_start` 之后触发，事件里带会话的 `cwd`，处理函数返回 `skillPaths` / `promptPaths`，pi 把它们并入资源后重建系统提示。所以 trellis-lite 的 skill **不写进 `package.json` 的 `pi.skills`**，只在检测到 `.trellis/` 时由扩展返回。非 Trellis 项目的系统提示里一个字都不会多。不需要 `disable-model-invocation` 再注入索引那套变通办法。
- **系统提示分段**：在 `before_agent_start` 里写 `event.systemPromptOptions.sections["<名字>"]`，pi 把它渲染成 XML 段。只有内容变化时，才在会话里追加一条 system 消息记录差量（会话格式文档：「later changes persist as system messages that patch sections by name」）。每次写入相同字节就不会产生差量，前缀缓存不受影响。
- **工具结果可以追加内容**：`tool_result` 处理函数能返回新的 `content`。由别的工具嵌套调用时（例如 codemode 脚本），事件里带 `parentToolCallId`，结果给的是脚本而不是模型。
- **生命周期事件**：`session_compact`、`session_tree` 可以用来重置或重建「本会话已经注入过哪些 spec」。

### 1.4 weibi-bot 实况（只读核对）

- 哈希表里登记了 155 个文件（`.claude` 52、`.trellis` 51、`.agents` 43、`.pi` 8、`AGENTS.md` 1）。哈希就是文件原始字节的 sha256，可以直接比对。
- 内容和哈希不一致的有 `AGENTS.md`、`.trellis/workflow.md`，外加 19 个 `.pyc`。**更正一点：这些 `.pyc` 也登记在哈希表里**，所以分类时 `.pyc` 和 `__pycache__/` 必须先按「运行时残留」处理，不能只看哈希。
- 没登记、但由 Trellis 写入的文件：`.trellis/.gitignore`、`.developer`、`.version`、`.template-hashes.json`。
- `.pi/settings.json` 登记过且未修改，内容是 `enableSkillCommands: true`（等于 pi 的默认值）、指向 `./extensions/trellis/index.ts` 的扩展条目和 `./prompts`（`.pi/prompts/` 本来就会被自动发现）。
- 旧机制的残留引用：spec 里**没有**（`test_calculate_cost_from_task.py` 是你说的那个误报）。但 `AGENTS.md` **托管块外面**的「weibi-bot 固定流程」里写着 `add_session.py`（「自动提交 `chore: record journal`」），迁移时也要检查。
- spec 共 163KB。按路径注入必须有预算，否则一次命中就是几万 token。

### 1.5 和 pi-preset 现有结构的衔接点

- 工作区干净，`main` 只有一个分支，没有进行中的本地化分支。
- 现有开关机制有两种：① pi 的包资源过滤（`pi config`，或在 `packages[]` 条目里写 `"extensions": ["!extensions/xxx.ts"]`），② 环境变量 `PI_PRESET_<功能>=off`（keepwarm、bash 后台、edit 行数都是这样）。trellis-lite 两种都支持。
- 已有的 `grilling` skill 用 `ask_user_question` 做逐轮追问。这就是 Trellis brainstorm 里「一次问一个决策」的部分，`trellis-plan` 直接复用它，不再写一套。
- `vendor/pi-workspace-history` 是撤销/快照工具，不做跨会话检索，和 `trellis mem` 不重叠。
- 测试用 `node:test`，`npm test` 跑 `test/*.test.ts`；文件头注释沿用 Why / Effect / Runtime / Command 的写法。

## 2. 第 3 节清单的修订

| 能力 | 原判断 | 修订 |
|---|---|---|
| spec 体系 | 保留 | 保留。兼容 `spec/<layer>/index.md`、`spec/<pkg>/<layer>/index.md`、`guides/`，新增可选的顶层 `spec/index.md`（init 时创建） |
| update-spec | 自写短 skill | `trellis-spec`。**break-loop 并进来**，作为其中一节「修完一个会复发的 bug 之后」，省掉一个 skill 描述（约 100 token） |
| brainstorm + prd/design/implement | 可选 `plan-task` | `trellis-plan`：只写文件，追问交给 `grilling` / `ask_user_question`。归档就是 `git mv` 到 `tasks/archive/YYYY-MM/`。旧任务的 `task.json`、jsonl 不读不写 |
| journal、`.developer` | 兼容 | 兼容。写入用一个 TS 小脚本（`node <skill 目录>/../../bin/trellis-lite.ts journal`），负责编号、满 2000 行换文件，还会更新 `workspace/<dev>/index.md` 里已有的自动标记块。不提交，不注册工具（零常驻成本） |
| 按路径注入 spec | 重点评估 | **做**。见第 6 节。和 beta 的区别：每个 spec 每会话只注入一次，不按时间重复提醒；触发工具改为 `read`/`edit`/`write`/`apply_patch` |
| 快照、预算、UTF-8 安全截断 | 借鉴思路 | 做。预算按**字符**算（CJK 不吃亏），按码点截断 |
| `trellis mem` | 倾向不做 | **不做**。journal 就是跨会话记忆；需要找原话时，`trellis-journal` 正文里提一句：会话记录在 `~/.pi/agent/sessions/<cwd-slug>/*.jsonl`，可以直接用 grep 搜 |
| research 目录 | 待评估 | **做成可选**：有 `.trellis/research/` 就在快照里列出（不含 `archive/`、`README.md`，最多 6 项），没有就不提。**不**把 tasks 转成 research |
| spec-bootstrap、session-insight、meta、channel、check、before-dev | 不要 | 不要。before-dev 的作用由「快照里的 spec 索引 + 按路径注入」代替 |

## 3. 行为规格（clean-room 依据）

### 3.1 什么是 Trellis 项目、根目录怎么找

- 从会话的 `cwd`（`resources_discover` 的 `event.cwd`、其余事件的 `ctx.cwd`）开始逐级向上找，**第一个含有 `.trellis/` 目录的祖先**就是项目根。遇到含有 `.git` 的目录时，检查完它就停止，不越过仓库边界；也不越过 `$HOME`。
- `.trellis/` 必须是真目录（不是符号链接），并且至少含有 `spec/`、`workspace/`、`tasks/`、`.developer` 之一，避免把无关的同名目录误认成项目。
- 找不到根就是**非 Trellis 项目**：不返回 skill，不写 section，不处理 `tool_result`，不弹通知。只保留 `/trellis-lite` 命令，因为要靠它 `init`；命令不占模型上下文。
- 任何地方都不用 `process.cwd()`。

### 3.2 旧版共存

项目根下只要有下面任意一项，就认为**旧版 Trellis 或 mini-trellis 的 pi 资产仍然生效**：

- `.pi/extensions/trellis/`、`.pi/extensions/mini-trellis/`
- `.agents/skills/trellis-*`、`.pi/skills/trellis-*`（pi 会自动发现这两个目录）
- `.pi/prompts/trellis-*.md`、`.pi/prompts/mini-trellis-*.md`

这时 trellis-lite **完全不工作**：不加 section，不返回 skill，不注入 spec，只返回迁移用的资源，并在本会话通知一次（warning）：「检测到旧版 Trellis 的 pi 资产，trellis-lite 暂停；运行 `/trellis-lite-migrate` 开始迁移」。理由是两套同时生效时，系统提示里会出现两份互相矛盾的流程说明。

### 3.3 常驻快照（系统提示 section）

- **时机**：会话的第一次 `before_agent_start` 时计算一次，存到内存；之后每轮都写回同一个字符串，所以字节不变。`/reload`、`/new`、`/resume` 时扩展会重新实例化，于是重新计算；如果内容变了，pi 只追加一条差量，不会改写前缀。
- **section 名**：`project-memory`（渲染为 `<project-memory>…</project-memory>`）。
- **内容**：只给路径和计数，每类都有上限，超出时写 `(+N more)`：

| 项 | 规则 | 上限 |
|---|---|---|
| spec 索引 | 依次收集 `spec/index.md`、`spec/*/index.md`、`spec/*/*/index.md` | 10 |
| journal | 当前开发者最新的 `journal-N.md`，附「会话数、当前行数/上限」；没有 `.developer` 时写「未设置开发者，运行 `/trellis-lite init`」 | 1 |
| 进行中任务 | `tasks/` 下除 `archive/` 外的目录，附带存在的 `prd`/`design`/`implement` 文件名 | 5 |
| research | `.trellis/research/` 的一级条目，不含 `archive/` 和 `README.md` | 6 |

- **总长上限 1500 字符**。超出时整项退化为「目录路径 + 数量」，一定保留完整的闭合标签。
- **weibi-bot 的实际样例**（491 字符，约 130 token）：

```
<project-memory>
This project keeps its memory in .trellis/. Read files on demand; never load everything.
- Spec indexes (read the one for the area you change before coding): .trellis/spec/backend/index.md, .trellis/spec/guides/index.md
- Journal: .trellis/workspace/zidou-kiyn/journal-1.md (34 sessions, 1295/2000 lines)
- Open tasks: none (archive: .trellis/tasks/archive/)
Specs whose frontmatter `paths:` match a file you read or edit are attached to that tool result.
</project-memory>
```

（以上是最终文案草稿，由我自己撰写；实现时以测试固定字节。）

### 3.4 skill（只在 Trellis 项目里通过 `resources_discover` 提供）

描述的目标是每个约 60 token 以内。

**`trellis-spec`**
- 描述：「Record a rule that should still hold next week in .trellis/spec/ and link it from the matching index.md. Use after settling a convention, after fixing a bug whose cause could recur, or when the user asks to remember a rule.」
- 正文要点：
  - 先判断值不值得写：下周还成立吗？代码里看不出来吗？只要有一个答案是否定的，就不写。
  - 找到对应层的文件，没有合适的就新建，然后在该层 `index.md` 里加一行链接。
  - 写法：一条具体规则，附「为什么」和一个正例、一个反例。能写成签名、字段、错误行为的契约就写成契约，不要堆原则。
  - 想让它按路径自动出现时，加 frontmatter `paths:`（附格式和 glob 语法速查）。
  - **修完 bug 之后**：根因属于哪一类、前几次修复为什么失败、什么机制能挡住这一类问题（测试、类型、断言、spec），然后把结论写进 spec，而不只是写在回复里。
  - 不提交。
- 依据：Trellis 的 update-spec 和 break-loop，mini-trellis 的 update-spec。

**`trellis-journal`**
- 描述：「Append a session entry to the developer journal in .trellis/workspace/. Use when the user asks to record the session, or after finishing a task.」
- 正文要点：
  - 写什么：做了什么、定了什么、下一步、提交哈希。不写过程流水账。
  - 怎么写：`node <本 skill 目录>/../../bin/trellis-lite.ts journal --title "…" [--commits a,b] [--task <目录>]`，摘要从 stdin 读入。
  - 脚本负责：编号；满行数换新文件；分支取当前 git 分支；提交信息从 `git log` 取；更新 `workspace/<dev>/index.md` 里已有的自动标记块。脚本不提交。
  - 需要找以前会话的原话时，grep `~/.pi/agent/sessions/<cwd-slug>/`。
  - 项目要求「记完 journal 再提交」之类的流程，写在项目自己的 `AGENTS.md` 或 `.pi/prompts/` 里，框架不规定。

**`trellis-plan`**
- 描述：「Plan a multi-step task as files in .trellis/tasks/MM-DD-slug/ (prd.md, optional design.md and implement.md), and archive it when done. Use when the user wants a task planned before coding.」
- 正文要点：
  - 先查证据（代码、spec、journal），再问用户；需要用户拍板的决策交给 `grilling`（每轮最多 4 问，带推荐项）。
  - `prd.md` 写目标、验收标准、不做什么；复杂任务再写 `design.md`（方案和取舍）、`implement.md`（有序步骤、要读的 spec、验证命令）。
  - 规划完先停下来等用户确认，再改代码。
  - 完成后 `git mv` 到 `tasks/archive/YYYY-MM/`，有值得留下的规则就转 `trellis-spec`。
  - 没有状态字段、`task.json`、jsonl，也不往上下文注入正文。

**token 估算**：pi 渲染每个 skill 时会带上 name、description 和绝对路径的 location，实测一条约 400 字符，约 100 token。三个约 300 token。

**常驻合计**：快照约 130 + skill 约 300 = **约 430 token**（weibi-bot、无任务时）。有 3 个任务和 research 时约 520。都在 600 目标内。

### 3.5 命令

`/trellis-lite` 在所有项目里都注册（不占上下文）：

| 子命令 | 作用 |
|---|---|
| `status`（默认） | 根目录、是否旧版共存、快照预览及字符数、本会话已注入的 spec |
| `init` | 建最小骨架（见第 8 节） |
| `migrate` | 旧版迁移的 dry-run 清单（见第 9 节），只看不改 |

`/trellis-lite-migrate` 只在 Trellis 项目里注册，作用是发起 AI 引导的迁移。实现方式是扩展读取包内的 `trellis-lite/prompts/migrate.md`，把其中的脚本占位符替换成绝对路径，再用 `pi.sendUserMessage` 发出去。不用普通 prompt template，是因为模板里写不了 pi-preset 安装位置的绝对路径。

## 4. 开关

| 层级 | 方式 |
|---|---|
| 全局关闭 | `PI_PRESET_TRELLIS=off`，或 `pi config` 取消勾选 `extensions/trellis-lite.ts`，或在 `packages[]` 条目里写 `"extensions": ["!extensions/trellis-lite.ts"]` |
| 只关按路径注入 | `PI_PRESET_TRELLIS_SPECS=off` |
| 单个项目关闭 | 项目 `.pi/settings.json` 用 pi 的包过滤（`autoload: false` 加排除），不另造配置文件 |

## 5. 前缀缓存

- section 字节在会话内不变；按路径注入只追加在工具结果里，不改系统提示。
- 不做每轮注入，不改写工具调用，不注册工具（journal 走脚本）。
- skill 列表在会话开始时就确定（`resources_discover`），会话中不变。

## 6. 按路径注入 spec

**触发**：顶层（无 `parentToolCallId`）、成功（`isError` 为假）的 `read`、`edit`、`write`、`apply_patch` 的 `tool_result`。

- 路径来源：前三者用 `input.path`；`apply_patch` 从 `input.input` 里解析 `*** Add File:`、`*** Update File:`、`*** Move to:` 后面的路径。
- 路径基于 `ctx.cwd` 解析，再转换成相对项目根的 POSIX 路径，做 NFC 归一化。
- 根目录之外和 `.trellis/` 之内的文件不触发。

**匹配**：

- 扫描 `.trellis/spec/**/*.md`，每个文件只读开头（最多 16KB / 200 行）解析 frontmatter，按 mtime+size 缓存。
- 语义与 1.1 节的约定相同。frontmatter 写错时，跳过该文件，并在 `/trellis-lite status` 里列出来，不弹通知。
- 多个 spec 命中时，按「具体程度」排序：完全没有通配符的最前，然后字面段多的、通配符少的在前，最后按路径字母序。

**去重（每会话一次）**：

- 注入的文本用标记包起来：`<spec path="…" sha="<内容哈希前 12 位>">…</spec>`。
- 「当前上下文里已经有哪些 spec」由会话分支推导：从最近一次压缩的保留点往后，扫描工具结果里的标记。
  - `session_start` 和 `session_tree` 时重建。
  - `session_compact` 时清空，因为压缩后正文已不在上下文里，下次命中会重新注入。
- 已注入、且哈希相同的跳过；哈希变了（spec 被改过）就重新注入全文。
- **不做按时间的重复提醒**：beta 默认 45 分钟后会再提醒一次，这等于按时间注入，不符合「每个 spec 每会话最多一次」。

**预算（按字符）**：

| 范围 | 上限 | 超出时 |
|---|---|---|
| 单个 spec | 6000 | 在码点边界截断，追加「已截断，完整内容见 <路径>」 |
| 单次工具结果 | 8000 | 剩余命中的 spec 降级为索引行：`- <路径> — <description>` |
| 单个会话的正文总量 | 40000 | 之后只追加索引行 |

**注入格式**：在原有内容之后追加一段文本：

```
<spec-context reason="matched paths: in frontmatter">
<spec path=".trellis/spec/backend/database-guidelines.md" sha="3f2a9c01be44">
…正文…
</spec>
Also applies (not attached, budget reached): .trellis/spec/backend/logging-guidelines.md — logging event names
</spec-context>
```

**为什么在 read 时就注入**：模型改文件前几乎都会先 read（pi 的 edit 要求逐字匹配原文），在 read 时注入，spec 就能在动手之前进入上下文。直接 `write` 新文件的情况，在写完后注入，下一步仍然能据此修正。

**已知局限**：通过 bash 改文件（如 `sed`、生成器）不会触发。

## 7. 根目录解析与快照策略

- 根目录：每个事件都用该事件的 `cwd` 重新解析，按 cwd 缓存，开销是几次 stat。
- 快照：每个扩展实例（等于每个会话运行时）只算一次。`/new`、`/resume`、`/fork`、`/reload` 会让 pi 重建扩展实例，于是自然重算。
- 会话中途新建的任务、spec 不会进入快照；模型自己建的东西它本来就知道，用户手动建的可以 `/reload`。

## 8. init

`/trellis-lite init`（幂等，只补缺的）：

1. `.trellis/spec/index.md`：说明如何分层、如何写 `paths:` frontmatter，约 15 行，自己撰写。
2. `.trellis/.developer`：`name=<名字>` 加 `initialized_at=<ISO 时间>`。名字通过 `ctx.ui.input` 询问，默认值取 `git config user.name`，清理成可以做目录名的形式。
3. `.trellis/workspace/<dev>/journal-1.md`：只写文件头（兼容现有格式：`# Journal - <dev> (Part 1)`、Started 日期、分隔线）。
4. `.trellis/.gitignore`：确保含有 `.developer`（开发者身份是每台机器自己的，和现有约定一致）。

全部用 `ctx.ui.confirm` 一次确认，不提交，结束时提示 `git status`。

## 9. 从旧版迁移

### 9.1 分工与顺序（已确认：由 AI 执行命令）

你只需运行 `/trellis-lite-migrate`，整个迁移由 AI 在一个会话里推进。**删什么、怎么编辑由脚本决定**（确定、可测试），AI 只负责运行脚本、向你确认、处理需要判断的文件：

1. AI 运行 dry-run 脚本，把清单给你看，用 `ask_user_question` 问你是否执行、`.claude/` 那组删不删。
2. 你同意后，AI 运行 `migrate --apply --yes`。脚本只删除哈希证明是原样的模板、做精确编辑，needs-review 的文件原样保留。
3. AI 再逐个处理 needs-review（第 9.4 节）。

顺序是先 apply、后处理 needs-review。原因：AI 提取自定义内容时要写 `AGENTS.md` 和 `.pi/prompts/`，如果先写，工作区就不干净了，apply 会按规则拒绝执行；而 `AGENTS.md` 正好两边都要改。先 apply 时工作区是干净的，之后所有改动都在 git 里可见、可回退。

脚本自己也把关，不依赖 AI 是否听话：工作区不干净就拒绝执行；不带 `--yes` 时只输出清单。

### 9.2 确定性部分：迁移脚本

入口是 `node <pi-preset>/trellis-lite/bin/trellis-lite.ts migrate [--json] [--apply --yes] [--remove-hosts claude,...]`，由 AI 通过 bash 运行。`/trellis-lite migrate` 命令调用同一套逻辑，只显示清单，方便你自己看。dry-run 直接输出到 stdout，**不往仓库里写计划文件**：写了反而会弄脏工作区。

**前置检查**：
- dry-run 在任何状态下都能运行，工作区不干净时给出警告。
- `--apply` 要求 `git status --porcelain` 为空（被忽略的文件不算），否则拒绝执行。
- 不在 git 仓库里时也拒绝 apply。

**分类规则**（按顺序判定，命中即停）：

| # | 类别 | 判定 | 处理 |
|---|---|---|---|
| 1 | 用户数据 | `.trellis/spec/**`、`.trellis/workspace/**`、`.trellis/tasks/**`、`.trellis/research/**`、`.trellis/.developer` | 不碰 |
| 2 | 运行时残留 | 任意 `__pycache__/`、`*.pyc`；`.trellis/.runtime/`、`.trellis/.backup-*/`、`.trellis/.current-task`、`.trellis/.ralph-state.json`、`.trellis/.version`、`.trellis/.template-hashes.json` | 删除（`.template-hashes.json` 最后删，分类时还要用） |
| 3 | 共享文件 | `AGENTS.md`、`.pi/settings.json`、`.trellis/.gitignore`、根 `.gitignore` | 精确编辑（见 9.3），dry-run 时展示 diff |
| 4 | 其他宿主资产 | 登记在哈希表里、并且位于 `.claude/`、`.codex/`、`.cursor/`、`.opencode/`、`.gemini/` 等非 pi 宿主目录下 | 单独成组，默认保留；apply 时可以一次选择「连同这一组一起删」（只删哈希一致的，不一致的归 needs-review） |
| 5 | 原样模板 | 登记在哈希表里，并且当前哈希一致 | 删除 |
| 6 | 改过的模板 | 登记在哈希表里，但哈希不一致 | **保留**，标 `needs-review` |
| 7 | 未登记的 Trellis 文件 | 不在哈希表里，但位于 Trellis 拥有的目录下：`.trellis/scripts/`、`.trellis/agents/`、`.trellis/workflows/`、`.pi/extensions/trellis/`、`.pi/extensions/mini-trellis/`、名字以 `trellis-` 开头的 skill/agent/prompt 目录或文件 | **保留**，标 `needs-review` |
| — | 其他 | 以上都不是 | 不碰，也不列出 |

- 哈希表缺失或格式不认识（例如 mini-trellis 项目）时：第 5、6 类无法判定，Trellis 拥有目录下的文件**全部**归 needs-review，命令只做第 2、3 类。
- 删除文件后，自下而上删掉变空的目录（只限 Trellis 拥有的目录）。
- **apply 之后**：补齐 init 骨架里缺的部分（不会覆盖已有文件）；打印删了什么、改了什么、保留了哪些 needs-review，以及原来的 Trellis 版本号（`.version` 已被删除，AI 下一步要用它取原版模板）；不提交。
- **幂等**：迁移完的项目再跑一次，输出「无事可做」，有 needs-review 时列出它们。

### 9.3 精确编辑

- **`AGENTS.md`**：删掉 `<!-- TRELLIS:START -->` 到 `<!-- TRELLIS:END -->` 这一段（含标记），以及紧跟其后的一个空行。块外的字节逐字节不变。标记不成对或出现多次时，不编辑，归 needs-review。删完后文件只剩空白时，删掉文件。
- **`.pi/settings.json`**：
  - 从 `extensions` 中删掉路径落在 `extensions/trellis/`、`extensions/mini-trellis/` 下的条目；
  - 从 `prompts` 中删掉 `./prompts`、`prompts`（`.pi/prompts/` 本来就会被自动发现）；
  - 数组空了就删掉这个键；
  - 如果剩下的只有等于 pi 默认值的键（`enableSkillCommands: true`），就删除整个文件；
  - 其余键原样保留，用现有的 `writeJsonObjectAtomic` 写回。
- **`.trellis/.gitignore`**：删掉已知的 Trellis 运行时规则（`.current-task`、`.runtime/`、`.ralph-state.json`、`.agents/`、`.agent-log`、`.session-id`、`.plan-log`、`*.tmp`、`.backup-*`、`*.new`、`**/__pycache__/`、`**/*.pyc`）以及紧挨着它们上方的注释行。保留 `.developer` 和其他不认识的行，规则列表是硬编码的事实清单。
- **根 `.gitignore`**：只删掉匹配上面清单、并且带 `.trellis/` 前缀的行；其他行不动。

### 9.4 AI 引导部分：`/trellis-lite-migrate`

发出的提示词要求 AI 按以下顺序推进，每一步都先展示、经你确认再动手：

1. 运行 `migrate --json`，把清单整理成人话给你看，用 `ask_user_question` 问：执行 / 执行并删除 `.claude/` 等其他宿主资产 / 取消。你同意后运行 `migrate --apply --yes`（按需加 `--remove-hosts`），把脚本输出给你看。如果脚本因为工作区不干净而拒绝，AI 停下来告诉你哪些文件没提交，不自己去提交或还原。
2. 逐个处理 `needs-review`：
   - 用 apply 输出里的原 Trellis 版本号取出 `npm pack @mindfoldhq/trellis@<version>`，和原版模板做 diff，**只提取项目自己加的内容**；
   - 流程类内容 → `.pi/prompts/<name>.md`（例如 weibi-bot 的 Phase 3.6 → `/release`）；
   - 需要常驻的约定 → `AGENTS.md`（先检查是否已经有，避免重复）；
   - 纯属 Trellis 机制的内容（阶段编号、子代理、jsonl、平台列表）→ 丢弃；
   - 每处迁移都给你看，确认后才写入；提取完成、你确认后，再删除这个 needs-review 文件（`git rm`，可恢复）。
3. 扫描 spec **和 `AGENTS.md`**，找仍然引用已删除机制的地方：`task.py`、`add_session.py`、`trellis_subagent`、`workflow-state`、`implement.jsonl`、`check.jsonl`、`trellis-before-dev`、`/trellis:finish-work`、`trellis-check`。
   - 判定要求词边界：前后不能是字母、数字、`_`、`-`，所以 `test_calculate_cost_from_task.py` 不会命中。
   - 这一步由脚本完成：`--json` 里带 `staleReferences` 字段，AI 只负责给出修改建议。
4. 有活跃任务（`tasks/` 下除 archive 外的目录）时，目录保留；对 `task.json`、jsonl 的建议是：留作历史即可（trellis-lite 不读），或在任务完成后随目录一起归档。
5. 建议哪些 spec 适合加 `paths:`。依据是 spec 正文里提到的源码路径（`--json` 的 `pathHints` 列出每个 spec 引用最多的目录），只给建议，不批量修改。
6. 再跑一次 dry-run，确认只剩「无事可做」。
7. 提示你新开会话，实测首轮 token（读取会话 jsonl 里第一条 assistant 消息的 `usage`），和迁移前对比后报告。
8. 给出一条提交信息，等你同意后再提交。

## 10. 文件清单

```
extensions/trellis-lite.ts                 接线：resources_discover、before_agent_start、tool_result、会话事件、命令
src/trellis-lite/root.ts                   根目录解析、旧版检测
src/trellis-lite/snapshot.ts               快照构建、上限与截断
src/trellis-lite/frontmatter.ts            frontmatter 解析
src/trellis-lite/glob.ts                   glob 校验、编译、具体程度排序
src/trellis-lite/spec-inject.ts            匹配、预算、标记、去重状态
src/trellis-lite/text.ts                   按码点截断
src/trellis-lite/journal.ts                追加、编号、换文件、index.md 自动块
src/trellis-lite/init.ts                   骨架
src/trellis-lite/migrate/classify.ts       分类
src/trellis-lite/migrate/edits.ts          AGENTS.md / settings / gitignore 精确编辑
src/trellis-lite/migrate/run.ts            dry-run 报告、apply、残留引用、paths 提示
trellis-lite/bin/trellis-lite.ts           CLI：journal、migrate（dry-run / --json / --apply --yes）
trellis-lite/skills/trellis-spec/SKILL.md
trellis-lite/skills/trellis-journal/SKILL.md
trellis-lite/skills/trellis-plan/SKILL.md
trellis-lite/prompts/migrate.md            /trellis-lite-migrate 的提示词
.pi/prompts/trellis-lite-upstream.md       只在 pi-preset 仓库里可见的维护用提示词
scripts/check-upstream-trellis.mjs         上游跟踪（只读）
docs/trellis-lite-design.md                本文
docs/trellis-lite-upstream.md              基线、关注路径、决策日志
test/trellis-lite-*.test.ts
```

`package.json` 的 `pi.skills` **不新增**条目，skill 只经由扩展提供。`pi.extensions` 已包含 `./extensions`，新文件会被自动加载。

## 11. 测试计划

**单元测试（`node:test`）**：

- 根目录解析：子目录向上查找、在 `.git` 处停止、不越过 `$HOME`、符号链接的 `.trellis` 不认、空 `.trellis/` 不认。
- 非 Trellis 项目零影响：`resources_discover` 返回空、不写 section、`tool_result` 原样返回、不通知。
- 旧版检测：每一种资产都会让 trellis-lite 暂停。
- 快照：样例逐字节固定、各项上限与 `(+N more)`、总长上限、journal 缺失或 `.developer` 缺失时的文案、同一实例多次调用字节完全相同。
- frontmatter：块列表、流式列表、BOM、`description: >` 块标量、横线开头的正文不算 frontmatter、`paths` 写成标量时报错、未闭合时报错。
- glob：1.1 节的每条语义（`*`、`?`、`**` 处于开头/中间/结尾、结尾 `/`、非法 glob）以及具体程度排序。
- 注入：
  - 预算三档（单个 spec 截断、单次降级为索引行、会话总量）；
  - 中文截断不出现乱码；
  - 每会话只注入一次；
  - 哈希变化后重新注入；
  - `session_compact` 后重新注入；
  - 从分支重建已注入集合；
  - `apply_patch` 路径解析；
  - 嵌套调用和出错的结果不处理。
- journal：编号接续、满 2000 行换到 `journal-N+1`、`index.md` 自动块更新（有标记时）和原样保留（无标记时）、提交信息查询、不提交。
- init：幂等、不覆盖已有文件。
- 迁移：
  - 分类覆盖全部 7 类，包括 `.pyc` 噪音、无哈希表的回退；
  - `AGENTS.md` 块外逐字节不变，标记异常时不编辑；
  - `.pi/settings.json` 只删 trellis 条目；
  - `.gitignore` 编辑；
  - 工作区不干净时拒绝 apply；
  - 幂等；
  - 残留引用的词边界（`test_calculate_cost_from_task.py` 不命中）。

**端到端（`/tmp` 副本，weibi-bot 原仓库只读）**：

1. `git clone ~/桌面/weibi-bot /tmp/weibi-e2e`。gitignore 掉的 `.developer`、`.runtime/`、`.backup-*` 另外用 `rsync` 补齐，让副本和真实状态一致。
2. 用隔离安装 `PI_CODING_AGENT_DIR=$(mktemp -d)` 装本地 pi-preset，复制 `models.json`/`auth.json`。
3. 记录迁移前的首轮 token，在副本上运行 `/trellis-lite-migrate`，由 AI 走完全程。
4. 验收：
   - `spec/`、`workspace/`、`tasks/` 前后逐字节一致（`git diff --stat` 为空，再对 gitignore 的部分做 sha256 对比）；
   - 发版流程出现在 `.pi/prompts/release.md`，「不派子代理、直接在 dev 上开发」出现在 `AGENTS.md`，内容完整；
   - 登记过的原样模板全部消失，非 Trellis 文件零改动；
   - 首轮 token 约为 11.1k + 0.45k ≈ **11.6k**（迁移前约 18.2k）；
   - 非 Trellis 目录首轮 token 与基线相同。

## 12. 上游跟踪

- **`docs/trellis-lite-upstream.md`**：
  - 基线表：Trellis `v0.7.0-beta.4`（`be9e19b`，npm `beta`，2026-09-11）、`v0.6.17`（`833a584`，npm `latest`，2026-09-11）、`main`（`f089cb3`，2026-09-29）、mini-trellis `main`（`74f2dfa`，npm 0.2.0，2026-10-04）；
  - 关注路径（按需求第 6 节）；
  - 评估原则；
  - 决策日志（首条：`36292d64` 不适用，原因是不自动提交）。
- **`scripts/check-upstream-trellis.mjs`**：
  - 只读；
  - 用 `--filter=blob:none` 克隆或 fetch 到 `~/.cache/pi-preset/upstream/{trellis,mini-trellis}`，不加 remote；
  - 对 `feat/v0.7-beta`、`main`、mini-trellis `main`，各自列出从基线以来关注路径上的提交和 diff 统计；
  - 显示 npm 的 `latest`/`beta`，列出比基线新的 `feat/v*-beta` 分支和 tag。
  - 和现有 `scripts/upstream.mjs` 分开写：那个工具负责「合并 vendored 代码」，这个只负责「看行为变化」，用途不同。
- **`.pi/prompts/trellis-lite-upstream.md`**：项目内提示词，跑脚本、读 diff、按原则起草建议和决策日志，**基线只有你确认后才更新**。
- 节奏：每月一次，或上游发版后跑一次。不做定时任务，因为每次都需要人来判断，自动跑出来的报告没人看也没用。

## 13. 明确不做

- 多宿主、configurator、`init/update/migrations` 那套版本升级机制；workflow 变体；`workflow.md` 状态机；`task.py` 和 `task.json` 状态；jsonl 清单；review gate。
- 每轮注入：breadcrumb、runtime context、重复的 overview、首次回复提示、`<workflow-state>`。
- 子代理工具和 agent 定义、channel、ablate/restore、bash 改写、`TRELLIS_CONTEXT_ID`、每轮启动 Python。
- 任何 Python。
- `trellis mem`、spec-bootstrap、session-insight、meta。
- 按时间重复提醒 spec。
- 自动提交（journal、归档、迁移都不提交）。
- 把 tasks 转成 research（mini-trellis 的做法）。
- 内置任何具体项目的流程（例如发版）。

## 14. 实现顺序（确认后）

1. `feat(trellis-lite): root detection, snapshot section, project-scoped skills`：根目录、旧版检测、快照、三个 skill、开关。
2. `feat(trellis-lite): path-scoped spec injection`：frontmatter、glob、注入、去重。
3. `feat(trellis-lite): journal script and init`。
4. `feat(trellis-lite): migrate from Trellis`：迁移脚本、`/trellis-lite migrate` 清单、`/trellis-lite-migrate` 提示词。
5. `docs: trellis-lite upstream tracking`：脚本、文档、维护提示词。
6. README（What it ships、Design notes、开关）、隔离安装实测、`/tmp` 端到端、`scan-secrets`。

## 15. 决策记录

| # | 问题 | 结论 |
|---|---|---|
| 1 | 名称 | `trellis-lite`（已确认） |
| 2 | 迁移由谁执行 | 由 AI 运行迁移脚本，执行前用 `ask_user_question` 确认；脚本先 apply，AI 再处理 needs-review（9.1，已确认） |
| 3 | 按路径注入的预算、是否按时间重复提醒 | 单篇 6000、单次 8000、会话 40000 字符；每会话只贴一次，spec 被改或会话压缩后才重贴（已确认） |
| 4 | 文档语言 | 实现时把本文翻译成英文，和 README 一致（已确认） |
| 5 | break-loop 并入 `trellis-spec`；`trellis-plan` 复用 `grilling` | 按本文执行，未提异议 |
| 6 | research 只做「存在就列出」；不做 `mem` | 按本文执行，未提异议 |
