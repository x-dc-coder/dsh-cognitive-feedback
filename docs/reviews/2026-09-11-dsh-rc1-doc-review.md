# 文档审查报告 — DSH Cognitive Feedback

> 审查对象：`x-dc-coder/dsh-cognitive-feedback` 全部 10 份文档
> 审查基准：**本机实际安装的 DSH `0.1.5-rc.1`**（非文档声称的 `v0.1.5-alpha.1`）
> 证据来源：`/home/dc/.nvm/versions/node/v24.16.0/lib/node_modules/@deepseek-ai/dsh/` 真实源码与类型声明
> 审查日期：2026-09-11

---

## 0. 结论摘要

文档的**产品理念、认知模型、范围控制是一流的**，可以直接进入实现阶段。
但**技术集成章节（`docs/dsh-integration.md`、`IMPLEMENTATION.md` Phase 0/2）已与真实 DSH 接口脱节**，必须按 rc.1 重写，否则 Phase 1 会建立在错误 API 假设上。

| 维度 | 评级 | 说明 |
|---|---|---|
| 愿景与认知模型 | A | `COGNITIVE_MODEL.md` 概念清晰、边界诚实，无需大改 |
| 范围控制（V0.1 四能力） | A | 反膨胀纪律明确，non-goals 列得干净 |
| 事件模式 | B+ | 结构合理，但事件类型命名与 DSH 原生词汇未对齐 |
| 架构分层 | B | 组件划分正确，但适配层接口是基于错误假设设计的 |
| **DSH 技术集成** | **D（硬伤）** | **基线版本、prompt 注入、gate 机制、inbox 形态全部与 rc.1 不符** |
| 可执行性 | C | Phase 0 是正确的"先验证"姿态，但验证结论未回填 |

---

## 1. 硬伤：5 条必须纠正的技术错误

### 错误 1（最严重）— 目标基线版本已过期

- **文档声称**：`V0.1 targets DSH v0.1.5-alpha.1`（见 README、`docs/dsh-integration.md`、`AGENTS.md` §2）
- **真实情况**：本机安装的是 **`0.1.5-rc.1`**
  ```
  $ dsh --version
  0.1.5-rc.1
  ```
- **影响**：alpha.1 → rc.1 之间插件 API 发生过破坏性变更。文档在 alpha.1 语境下描述的三项变更——
  "dynamic system-prompt updates without invalidating KV cache"、"Session V3"、"Agent plugin API change"——
  其中 prompt 更新机制在 rc.1 已经是**结构化 section 注册表**，与文档描述的"字符串拼接动态更新"完全不是一回事。
- **修正**：基线改为 `0.1.5-rc.1`，并在兼容性章节改为引用**类型声明文件**而非发布说明。

### 错误 2（最影响实现）— 系统提示词注入机制描述错误

- **文档假设**（`ARCHITECTURE.md` §2 Prompt Builder、`docs/dsh-integration.md` "Dynamic prompt strategy"）：
  > 拼装 `base DSH system prompt + cognitive feedback section`，用 `[COGNITIVE FEEDBACK]...[/COGNITIVE FEEDBACK]` 文本包裹，状态变化时"重新生成"认知段。

- **rc.1 真实机制**（`@deepseek-ai/dsh-system-prompt`）：
  ```ts
  ctx.systemPrompt.section({ name, order, text })   // text 可为 (ctx) => string，每次 assemble 求值
  ctx.systemPrompt.variable(name, resolver)         // section 文本中用 {{name}} 引用
  ```
  - section 是**注册项**，不是字符串拼接；DSH 在每次组装时按 `order` 升序拼接。
  - `text` 支持**函数形式**（`(context: AssembleContext) => string`），**这本身就是"动态"**——无需手动"重新生成"。
  - 通过 `agent.ctx` 注册的 section 是 **agent 作用域**的，自动 shadow 同名全局，**天然满足"不污染其他 agent"**。
  - 有官方 `SECTION_ORDERS` 常量表；**`TEAM_POLICY: 600`**、`TOOL_*: 1000+` 等位置已占，插件应取一个未占用的 order。

- **修正建议**：Prompt Builder 改为
  ```ts
  ctx.systemPrompt.section({
    name: 'cognitive-feedback',
    order: 700,                       // 未占用区间，宜在 TEAM_POLICY(600) 与 TOOL_BASH(1000) 之间
    text: (ctx) => state.active ? renderCognitiveSection(state) : '',
  })
  ```
  并删除文档中手动"重新生成完整 prompt"的描述——那是错误的实现方向，会破坏 DSH 的 section 排序与 KV-cache 语义。

### 错误 3 — Reasoning Gate 的实现路径判断过时

- **文档假设**（`IMPLEMENTATION.md` Phase 2 末句）：
  > "If the DSH API cannot elegantly pause/resume an agent turn, implement the first version as a prompt-level gate rather than inventing a second event loop."

- **rc.1 真实能力**：存在官方 `ask_user_question` 工具（`@deepseek-ai/dsh-tool-ask-user`），
  基于 `ctx.userQuestions` seam，**在 agent turn 内阻塞等待用户回答**：
  > "The call waits until an answer is accepted or the turn is cancelled."

  这正是 reasoning gate 需要的"优雅暂停/恢复"，**不必退化为 prompt-level gate**。
- **修正**：Phase 2 明确采用 `ask_user_question` 作为 gate 的执行载体；同时保留降级路径（无 answerer 时报错而非挂起）。

### 错误 4 — Inbox 形态描述不准确

- **文档声称**（`docs/dsh-integration.md`）：
  > "Inbox changed to a type interface, with pending messages accessed through `agent.inbox`."

- **rc.1 真实形态**（`dsh-agent/lib/types/types.d.ts`）：
  ```ts
  type InboxTarget = 'next-turn' | 'next-step'
  interface InboxState { 'next-turn': UserMessage[]; 'next-step': UserMessage[] }
  // 变更以事件暴露：
  'agent/inbox/spliced': { target, start, removedCount?, inserted, outcome? }
  // 并通过 session projection 暴露为 'inbox'
  ```
  inbox 是**两个有序待处理列表**，通过 `agent/inbox/spliced` 事件 + session projection 读取，
  而不是单一 `agent.inbox` 属性。
- **修正**：更新为 `agent/inbox/spliced` + `SessionProjectionStateMap.inbox`。

### 错误 5 — 缺少驱动 Agent 的真实 API

- **文档**：完全没有提到如何向 agent 注入反馈/驱动其行为，只有抽象描述。
- **rc.1 真实 API**（`AgentHandle.agent`）：
  ```ts
  agent.followup({ content, source })   // 排入下一轮并唤醒
  agent.steer({ content, source })      // 提交下一步输入并唤醒
  agent.inject({ content, source })     // 注入 model-facing 上下文，不唤醒
  agent.cancel(cause)
  await agent.whenIdle()
  ```
  以及 `ctx.agents.create()/resume()` 与 `setup(agentCtx, agent)` 组合钩子。
- **修正**：新增"DSH Adapter 接口契约"小节，列出这些真实签名。

---

## 2. 中等改进项（不阻塞实现，但建议 V0.1 就做对）

1. **事件类型命名与 DSH 原生词汇未对齐**
   现用 `session.started` / `session.ended`，DSH 原生是 `session/created` / `session/disposed`。
   建议保留自有 schema（`EVENT_SCHEMA.md` 是自洽的），但在文档中明确**映射表**，降低适配层认知成本。

2. **状态机字段与实际所需信号缺口**
   `CognitiveState` 有 `recentDecisionOutsourcing` 等计数，但未定义**由哪些真实事件驱动递增**。
   建议补一张"信号 → 状态字段"的判定表，否则 policy 无法测试（违反 `AGENTS.md` §7"policy 可独立测试"）。

3. **干预预算缺时间基准**
   "per day: max 5" 但 `CognitiveState` 是 ephemeral，重启即丢失。
   需明确预算持久化位置（JSONL 重放 or 独立小文件），否则跨会话预算不成立。

4. **JSONL 路径与 DSH 约定**
   `~/.dsh/cognitive-feedback/events.jsonl` 方向正确。但 DSH 有 `DSH_HOME` 环境变量约定
   （见 `dsh-agent-instructions` 的 `$DSH_HOME/AGENTS.md`），建议改为 `$DSH_HOME/cognitive-feedback/`，
   不要硬编码 `~/.dsh`。

5. **插件分发形态未定**
   rc.1 的插件加载是 **profile bundle** 机制：
   `dsh plugin --profile <name> add <package>`，profile 由 `cordis.patch.yml` 的 `insert` 列表组合。
   文档说"follow the simplest repository/community-plugin form"过于含糊，应明确产物形态。

6. **"dynamic prompt 不破坏 KV cache"的说法需要证据**
   文档两处提及 KV cache 收益，但这是 alpha.1 发布说明的转述，未在 rc.1 源码中找到对应契约。
   建议删除或降级为"待验证假设"，符合本项目自己的"evidence before claim"原则。

---

## 3. 做得好的地方（建议保留）

- **Fail open 原则**（`ARCHITECTURE.md` §5）与 DSH 插件生态惯例一致，逐条列出了降级路径。
- **适配层边界**（§3）方向完全正确——rc.1 的 Cordis `ctx` 服务模型恰好支持这种隔离。
- **`CognitiveEventSink` 抽象**（§4）干净，为 Soul-Spark 留了正确形状的缝。
- **反骚扰规则**（`COGNITIVE_MODEL.md` §7）与**低干预预算**（`ARCHITECTURE.md` §6）体现了产品克制。
- **`docs/examples.md` 的 6 个场景**是优秀的验收测试素材，可直接转化为集成测试用例。
- **`AGENTS.md` 的"理解先于实现"**与 Phase 0"先验证 DSH 表面"的纪律，正是本审查能落地的前提。
- **明确不采集 hidden chain-of-thought**（`AGENTS.md` §6）——红线清晰。

---

## 4. 建议的修正优先级

| 优先级 | 动作 | 涉及文档 |
|---|---|---|
| P0 | 基线版本改为 `0.1.5-rc.1` | README, dsh-integration.md, AGENTS.md |
| P0 | 重写 prompt 注入为 `ctx.systemPrompt.section` | dsh-integration.md, ARCHITECTURE.md |
| P0 | Reasoning Gate 改用 `ask_user_question` | IMPLEMENTATION.md Phase 2 |
| P1 | 补 DSH Adapter 真实接口契约表 | dsh-integration.md |
| P1 | 修正 inbox 形态描述 | dsh-integration.md |
| P1 | 明确插件分发形态（profile bundle） | dsh-integration.md |
| P2 | 信号→状态映射表 | ARCHITECTURE.md |
| P2 | 预算持久化方案 | ARCHITECTURE.md |
| P2 | `$DSH_HOME` 路径约定 | IMPLEMENTATION.md Phase 4 |
| P3 | 删除/降级 KV cache 无证据表述 | dsh-integration.md, README |

---

## 5. 下一步建议

文档经上述修正后即可进入 Phase 1 垂直切片。**不建议跳过修正直接编码**——
错误 2 和错误 3 会直接导致适配层设计返工。

建议的第一个可交付切片（与文档 Phase 1 一致，但按 rc.1 落地）：

```
ctx.systemPrompt.section({ name:'cognitive-feedback', order:700, text: fn })   ← 注入
ctx.on('session/event', ...) 或 ctx.on('agent/...', ...)                        ← 观测
→ state.update(signal)
→ policy.evaluate(state)
→ JsonlSink.append(event)
→ section text provider 返回干预文本（下一轮 assemble 自动生效）
```
