# v3：第二评审 + 交互模式

接 [v2](2026-10-31-v2-preset-0.4.md)。同一批 88 次运行的最终回复，换 `openai-proxy/gpt-6-astra`（thinking high）盲评一遍；另外用 pi 的 RPC 模式跑了两个交互任务。

## 第二评审（GPT-6 Astra，132 次，两种顺序）

| 配对 | Opus 评审 | GPT 评审 | GPT：正确 / 完整 / 清晰 / 简洁 / 坦诚 |
|---|---|---|---|
| old vs **new** | 16 : 23 : 5 | **8 : 22 : 14** | 9.2/9.4 · 9.7/9.5 · 9.2/9.4 · 8.7/8.7 · 9.3/**9.7** |
| pure vs **new** | 20 : 23 : 1 | **11 : 16 : 17** | 9.2/9.5 · 9.5/9.6 · 9.4/9.2 · 8.6/8.7 · 9.3/**9.7** |
| **new** vs nostyle | 16 : 25 : 3 | **13 : 15 : 16** | **9.6**/9.3 · 9.6/9.5 · 9.2/9.3 · **8.8**/8.4 · **9.6**/9.3 |

GPT 的分数整体偏高、平局多（它把"两边都对"记为平），但方向和 Opus 一致：new 优于 old 和 pure，坦诚分两位评审都是 new 最高。唯一的分歧在 new vs nostyle：Opus 偏好更长更"完整"的 nostyle 回复（25 : 16），GPT 判成平手（15 : 13），并且正确、简洁、坦诚三项都是 new 高。两位评审都在 jinja-feature 上给 new 4 : 0（docstring 示例），cleanup 上 GPT 给 new 对 old 4 : 0。

结论不变：留 working-style。Opus 评审的那组劣势是评审口味，不是回复质量。

## 交互模式（RPC，脚本化用户）

`bench/interactive.mjs`：真实的 `pi --mode rpc` 会话，脚本回答 `ask_user_question` 的对话框和纯文本提问，也能发斜杠命令。

**ambiguous**：提示只有一句"金额显示太难看了，改一下。"，脚本用户的答案是"加 ¥，放在负号后面，千分位保留，只改这一处"。

| 配置 | 用 ask_user_question | 文本追问 | 直接猜 | 结果带 ¥ 且负号在前 | 费用 |
|---|---|---|---|---|---|
| pure ×2 | 0 | 1 | **1**（改了列对齐，没加符号） | 1/2 | $0.18 |
| old ×2 | 2 | 0 | 0 | 2/2 | $0.24 |
| new ×2 | 2 | 0 | 0 | 2/2 | $0.18 |

preset 两个版本 4/4 先用结构化选项问（3–4 个备选，附示例和推荐），答一次即完成；纯 pi 一次用散文问、一次猜错方向白做一轮。old-0 问了两轮（第二轮问币种），new 都是一轮。

**undo**（仅 new）：让它用 `Intl.NumberFormat` 重写 `formatAmount` 并跑测试，结束后发 `/undo`，RPC 弹出 select（"Conversation and workspace"），脚本选第一项，工作区恢复干净，测试 12/12。

## 其它

- `todo` 的 schema 去掉 `blockedBy` / `addBlockedBy` / `removeBlockedBy` / `includeDeleted`（声明 1 786 → 1 215 字符）；reducer 和回放仍接受，老会话不受影响。
- "Use read instead of cat"：88 次运行里每个配置 `cat`/`sed` 都是 `read` 的 2–7 倍，模型把多个文件塞进一次 bash 调用，是效率选择。上游已有同样的数据（Rianico/pi-better-edit#28：904 次试验，19% 从未调用 read），pi 维护者的立场是工具选择属于模型行为（#4430）。preset 无事可做。
- 基准搬进仓库 `bench/`：`setup.mjs` 从 `~/.pi/agent` 生成隔离的 agent 目录、按固定 commit 拉 Jinja；`agents/`、`.cache/`、`work/`、`results/` 不进 git。
