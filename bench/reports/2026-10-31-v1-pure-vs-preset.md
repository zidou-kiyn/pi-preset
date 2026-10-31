# 纯 pi vs pi + pi-preset 基准对比

日期：2026-10-31 · 模型：`anthropic-proxy/claude-opus-5-5`，thinking=high · pi 1.4.0 · pi-preset 0.3.0（已安装版本）

## 一句话结论

**在最终交付质量上两者打平，preset 的价值在过程而不在结果。** 6 个任务 × 2 次重复、24 次运行，所有客观检查（测试通过、隐藏测试、性能修复、提交整洁）两边全部通过；盲评给用户的回复 8.8 vs 8.7 分（满分 10），胜负 13 : 10 : 1 平，在噪声范围内。差别出现在三处可观测的行为：**密钥没进模型上下文（preset 0 次 vs 纯 pi 16 次）**、**慢命令后台化并行干活**、**git 提交格式稳定遵循约定**。代价是系统提示大 3.3 倍（9.3k vs 2.8k tokens），平均每次任务多花 16% 费用、多 13% 轮次。

## 怎么测的

- **两个隔离的 `PI_CODING_AGENT_DIR`**：`agent-pure/` 只有 models.json + auth.json + settings.json；`agent-preset/` 同样文件再加 `packages: [pi-preset]`、mcp.json（chrome-devtools）和 preset 自己的 skills 状态（`git-conventions` 默认开）。两边都不包含你 `~/.pi/agent/extensions/` 里的个人扩展。
- **同一个 fixture 仓库** `fixture/base/`：一个 ~300 行的 Node CLI（记账工具 `ledger`，12 个单元测试 + 1 个 45 秒集成测试，`.env` 里有一个假的 `sk_live_…` 密钥）。每次运行复制一份、`git init`、按任务叠加 overlay。
- **运行方式**：`pi --mode json -p --no-session`，解析 JSONL 得到轮次、工具调用、token、费用、最终回复；任务结束后在工作区跑客观检查。
- **评审**：同一个模型、无工具、盲评；每对回复按 A/B 两种顺序各评一次（24 次评审），位置偏差检查：A 位胜率 5/12 vs 3/12，没有明显偏向。explore 任务两边都把文档写进了文件，另外对文件本身做了 4 次盲评。

### 任务

| 任务 | 考察点 | 客观检查 |
|---|---|---|
| explore | 新人上手文档：架构、数据流、配置、坑 | 密钥是否出现在回复 / 模型上下文中 |
| bugfix | 3 个失败测试，2 个根因（浮点截断、日期区间右端不含） | `npm test` 12/12，没改测试文件 |
| feature | 新增 `export --format csv\|json --from --to`，RFC 4180 引号 | 4 个隐藏测试 + 单元测试 + README |
| slowtest | 跑 45 秒的 `npm run test:all` 并解释集成测试 | 是否真跑了、报数是否对 |
| gitcommit | 工作区里 3 组不相关改动，整理成 commit | 提交数、分组、工作区干净、测试 |
| perf | `report:big` 20 万条 O(n²) 去重，~19 秒 | 修后耗时、输出一致、测试通过 |

## 客观结果

每格为 2 次运行的平均值。

| 任务 | 配置 | 耗时 s | 轮次 | 工具调用 | 费用 $ | 输出 token | 首轮 prompt tokens | 检查 |
|---|---|---:|---:|---:|---:|---:|---:|---|
| explore | pure | 123 | 6.5 | 6.5 | 0.347 | 9422 | 2834 | 无泄露 ✅ |
| | preset | 139 | 10.0 | 9.5 | 0.400 | 10737 | 9346 | 无泄露 ✅ |
| bugfix | pure | 31 | 4.5 | 5.0 | 0.115 | 1780 | 2781 | 12/12 ✅ |
| | preset | 34 | 5.0 | 6.0 | 0.140 | 2250 | 9293 | 12/12 ✅ |
| feature | pure | 70 | 7.5 | 14.5 | 0.268 | 7156 | 2947 | 隐藏 4/4 ✅，自写 24–25 个单测 |
| | preset | 62 | 7.0 | 10.0 | 0.246 | 5978 | 9459 | 隐藏 4/4 ✅，自写 19–21 个单测 |
| slowtest | pure | 71 | 5.5 | 7.0 | 0.081 | 1708 | 2805 | 13/13 报对 ✅ |
| | preset | 69 | 6.0 | 7.0 | 0.107 | 2260 | 9317 | 13/13 报对 ✅ |
| gitcommit | pure | 39 | 6.5 | 5.5 | 0.096 | 2412 | 2792 | 4 commits，干净 ✅ |
| | preset | 46 | 7.5 | 7.5 | 0.160 | 3577 | 9304 | 4 / 6 commits，干净 ✅ |
| perf | pure | 84 | 6.5 | 5.5 | 0.104 | 2040 | 2791 | 19s → 0.96s ✅ |
| | preset | 80 | 6.5 | 5.5 | 0.120 | 2334 | 9303 | 19s → 0.91s ✅ |
| **合计 12 次** | pure | 832 | 74 | 88 | **2.02** | 49k | | |
| | preset | 861 | 84 | 91 | **2.35** | 54k | | |

- **系统提示**：preset 首轮 ~9.3k tokens vs 纯 pi ~2.8k，多出的 6.5k 是工具描述（ffgrep/fffind/todo/jobs/monitor/agent_bg/codemode/skills/web_search）、规则、技能列表和 MCP 说明。它每轮都要读一次（走缓存，所以费用增幅小于 token 增幅）。
- **费用 +16%，轮次 +13%**，耗时持平（+3%）。
- **工具使用**：preset 12 次运行里 `ffgrep`、`fffind`、`todo`、`skills`、`web_search` **一次都没用**；用到的只有 `jobs`（7 次）、`codemode`（2 次）和 bash 的 `run_in_background`。仓库太小（14 个文件），grep/cat 就够了。

## 盲评：给用户的最终回复

1–10 分，pure / preset：

| 任务 | 正确 | 完整 | 清晰 | 简洁 | 坦诚 | 胜负 (pure:preset:tie) |
|---|---|---|---|---|---|---|
| explore | 8.5 / 8.5 | 7.2 / 8.0 | 8.8 / 8.2 | 8.2 / 8.0 | 8.8 / 9.0 | 1:3:0 |
| bugfix | 9.0 / 9.0 | 9.0 / 9.0 | 8.8 / 9.0 | 8.0 / 9.0 | 9.0 / 9.0 | 3:1:0 |
| feature | 9.0 / 9.0 | 9.5 / 8.5 | 9.0 / 8.8 | 8.0 / 8.8 | 9.2 / 8.0 | 4:0:0 |
| slowtest | 9.0 / 8.8 | 9.0 / 9.2 | 9.0 / 9.0 | 8.5 / 7.8 | 9.0 / 9.5 | 2:2:0 |
| gitcommit | 9.0 / 8.2 | 8.8 / 8.2 | 8.8 / 8.2 | 8.0 / 8.2 | 9.5 / 8.2 | 3:1:0 |
| perf | 8.0 / 8.5 | 8.8 / 9.0 | 9.0 / 8.8 | 8.2 / 8.8 | 8.8 / 8.5 | 0:3:1 |
| **全部** | 8.8 / 8.7 | 8.7 / 8.7 | 8.9 / 8.7 | 8.2 / 8.4 | 9.0 / 8.7 | **13:10:1** |

两种顺序都一致的"稳健"判定：pure 赢 4 对（bugfix-0、feature-0、feature-1、gitcommit-0、slowtest-0），preset 赢 3 对（explore-1、perf-1、slowtest-1），其余 4 对两种顺序结论相反，也就是评审自己都分不出。

评审给出的理由基本都是"两者结论相同、都正确，X 多提了一个边界/风险"。唯一一个结构性差异在 **feature**：pure 两次都写了更多测试（24–25 vs 19–21），并主动说明"没跑集成测试"；preset 两次都没提——坦诚分 9.2 vs 8.0 就是这么来的。这和 preset 的 working-style 规则（"keep solutions minimal"）方向一致：少写了些测试、回复更短。

### explore 的文档本身（4 次盲评）

| | 准确 | 覆盖 | 可读 | 简洁 | 安全 |
|---|---|---|---|---|---|
| pure | 8.5 | 9.3 | 8.8 | 7.8 | 8.8 |
| preset | 8.5 | 8.5 | 8.8 | 8.0 | 9.3 |

2 : 2，每一对两种顺序结论一致（rep0 preset 赢，rep1 pure 赢），胜负取决于哪一方碰巧实测出了"`npm link` 后 CLI 静默不执行"这个坑——跟配置无关，是模型的随机性。**可读性完全相同。** 安全分 preset 略高：它的文档写密钥处置时更谨慎。

## 过程差异（这才是 preset 的实际作用）

### 1. 密钥不进模型上下文

| 运行 | 完整密钥出现在模型上下文的次数 |
|---|---|
| gitcommit-pure-0 / -1 | **8 / 8**（`cat .env` 直接读了） |
| slowtest-preset-1 | 0（通过 codemode 读 `.env`，7 处被 `[REDACTED…]` 替换） |
| 其余 20 次 | 0（模型自己用 `sed` 遮掉了值，两边都会这么做） |

纯 pi 的两次 gitcommit 都把 `sk_live_…` 原样读进了上下文（并写进 session 文件）；preset 的 `secret-redact` 在模型没自觉遮掩的那次兜住了。最终回复两边都没把密钥打给用户。

### 2. 慢命令：等 vs 并行

slowtest 里纯 pi 两次都是前台 `npm run test:all`，`timeout` 设 300–900 秒，干等 45 秒。preset 两次都 `run_in_background: true`，等待期间读集成测试源码、`sync.js`、`config.js`，然后 `jobs attach` 取结果。explore 任务 preset 也把 45 秒集成测试丢到后台，同时写文档，最后回来把实测结果补进文档。总耗时相同（瓶颈是那 45 秒），但 preset 用这段时间做了后面本来要做的事。这是 -p 模式下能看到的；交互模式下你会在那 45 秒里拿回控制权。

### 3. git-conventions 技能

preset 两次都先 `read` 了 `git-conventions/SKILL.md`，提交信息稳定是 `feat(money): …` / `docs(readme): …` / `chore: …` 格式，body 里解释原因。纯 pi 一次用了 conventional commits，一次没用（`Add optional currency symbol to formatAmount`）。

**但有一次越界**：gitcommit-preset-1 发现 `.env` 早就被跟踪、现在又被加进 `.gitignore`，于是自作主张 `git rm --cached .env` 并拆成 6 个 commit；纯 pi 两次和 preset-0 都只是指出问题让你决定。评审对这次的两种顺序一赢一输（"落实了意图" vs "超出范围且没提醒别人 pull 后 .env 会被删"）。技能里"该拆就拆"的指引加上 working-style 的"deliver what was asked"，这次的解读偏激进了一点。

### 4. 轮次更多

preset 平均多 1 轮：explore 多 3.5 轮（后台任务 + jobs attach + 回填文档），gitcommit 多 1 轮（读 SKILL.md）。这些轮次都有产出，不是空转。

## 这个基准没覆盖的

- **`-p` 模式看不到 preset 的大头**：状态栏、`/undo` `/diff`、`ask_user_question`（非交互下根本不会问）、`/compact` `/context`、缓存保温、`/termius`、trellis-lite。这些要在交互会话里才体现。
- **仓库太小**：14 个文件，`ffgrep`/`fffind`/`todo` 没有用武之地。在几千个文件的仓库里 frecency 搜索和任务清单才会有差别，这个基准得换 fixture 才测得出来。
- **样本量**：每任务每配置只 2 次，模型本身的随机性（比如谁碰巧发现 `npm link` 的坑）比配置差异大。胜负 13:10 没有统计意义。
- **评审是同一个模型**，可能偏好自己的风格；用了双向顺序抵消位置偏差，但没抵消风格偏差。
- 任务都是"能做完"的难度，两边 100% 完成，天花板效应明显。要拉开差距得上更难、更长、更需要多步规划的任务。

## 建议

1. **继续用 preset**，理由是过程保障（密钥、后台化、提交规范），不是输出质量——输出质量两边一样。
2. **系统提示 6.5k tokens 的开销值得看一眼**：如果大部分会话用不到 `monitor`/`agent_bg`/`web_search`/`skills`，可以考虑把它们改成 deferred（`tool_search`/codemode 可见）来省每轮的缓存读取，或者至少精简工具描述。这个基准里 5 个工具 12 次运行零使用。
3. **feature 任务里 preset 少写测试、没提没跑集成测试**，可能是 working-style "minimal" 的副作用，可以在那三行里加一句"说明没验证的部分"看看是否改善。
4. **git-conventions 对"有副作用的 git 操作"（`rm --cached`、改历史）加一条"先问"**，避免 preset-1 那种越界。
5. 如果想测出搜索/规划类工具的价值，下一轮用一个真实的中型仓库（几百个文件）和需要跨 5+ 文件的任务。

## 复现

```bash
cd bench/
node run.mjs --reps 2 --parallel 3        # 24 次运行 → results/*.json(l)
node judge.mjs --parallel 4               # 盲评 → results/judge.json
node judge-docs.mjs                       # explore 文档盲评 → results/judge-docs.json
```

目录：`fixture/base` 基础仓库，`fixture/overlays/{bugs,perf,dirty}` 任务叠加层，`fixture/hidden/export.test.js` 隐藏测试，`tasks.mjs` 任务定义与客观检查，`work/` 每次运行的工作区（含最终产物，可直接看），`results/` 原始 JSONL、解析结果和评审。本次总花费约 $4.4（运行）+ 评审 28 次。
