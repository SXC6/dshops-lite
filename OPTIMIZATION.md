# dshops-lite 优化状态

> 范围：本仓库当前代码（`index.js` / `lib/*.js` / `client.js` / `cordis.patch.yml`）。
> 依据：宿主 `0.2.2-rc.5` 的安装源码与 README（`app.asar` 内），以及 `_selftest.mjs` / `_failtest.mjs` 的实测。
> 结论优先：**A 已修并保持；B1 / B2 / B4 / B6 已办，B3 有意不做，B5 为有意保留；C 档维持并记录理由。**

## A. 已修（保持）

| # | 问题 | 现在 |
| --- | --- | --- |
| A1 | `ops_inspect_local_file` 对任何文件都显示 `(no rows)` | 渲染器显式转发结果值，断言钉住「拿到 items 必须渲染出行」 |
| A2 | 普通命令失败会熔断一个**可用**的 shell | 只有「拿不到退出码 / 被信号杀掉」才算后端故障；非零退出码是正常结果 |
| A3 | `ops_shell` 声明了 `timeoutMs` 却不使用 | 删掉该参数，不留假旋钮 |
| A4 | 只读会话里 `ops_shell` 仍可写文件 | 只读时直接拒绝且不 spawn，错误指向宿主带沙箱的 pwsh 工具 |
| A5 | shell 输出被截断时**静默** | `lossy` 进结果，渲染末尾明写 `truncated` |
| A6 | 配置了错误路径时日志不点名 | 显式打出被配置的路径未通过探活及原因 |
| A7 | 日志只走 `console.warn` | 统一 `note()`：有 logger 用 logger，纯 Node 环境回落 `console.warn` |
| A8 | `ops_shell` 没有命令截止时间，挂起的命令会一直占着回合直到宿主取消 | 插件自己持有 `shell.commandTimeoutMs`（默认 120000，范围 1000–600000；`cordis.patch.yml` 同步）：超时、用户取消分别报错且都不计入 `maxSpawnFailures`，只有 spawn 失败或进程没有退出码才算后端故障 |

## B. 已办与结论

### B1. 启动期探活（已办）

原问题：`probeShell()` 同步 spawn，且按候选串行，最坏情况会阻塞事件循环 `候选数 × probeTimeoutMs`（默认 15 s）。

现在：

- `probeTimeoutMs` 默认 **15000 → 3000**（schema 默认、`resolveShell` 兜底、`cordis.patch.yml` 三处一致）。
- 探活**合并为一次 spawn**：探活命令先打印 token，再打印版本行，从同一份 stdout 解析 version；版本解析失败只丢 version，不影响 ok 判定。
- 仍按候选顺序串行、首个通过即停。候选在 spawn 之前先被 stat 与危险名单过滤，通常只有 1 个候选真的被启动。

**为什么不改成惰性探活**：探活存在的意义就是「工具只在被证明能跑之后出现」。惰性探活要么先发布、首次调用才校验（把「缺席优于坏工具」换成「先用后验」），要么首次调用额外承担探活耗时并可能在此时失败。宁可在激活时付一次亚秒级成本。

### B2. 批量（已办，机制与原文不同）

**更正原文的错误前提**：worker 的 `"batch"` op **只支持 copy / move / remove**，不能承载任意 op；而且它会在工作区建 `.dsh-ops/` 审计库、加排他锁，逐条明细要用 `ops_result` 取——本插件不发布 `ops_result`。所以照搬 worker batch 不可行。（本次裁剪后 worker 已完全没有 `batch` op；这句记录的是当时的取舍。）

实际做法：**JS 侧 `ops_batch`**。一次模型调用里顺序执行多个既有文件操作（`operations` 数组，1–32 条，每条 `{op, args}`），复用各工具的参数归一化与渲染器；每个操作仍单独 spawn 一次 worker。

收益：

- 省掉 N−1 次模型往返（token 与延迟），3 个以上同类操作时最明显；
- 逐条报告成败，默认继续执行（`stopOnError: true` 时停在首个失败，其余操作不再执行，末尾只报告跳过数量）；
- transport / worker 级故障会让整批 `throw`，不把不可信的部分结果报成成功。

代价：

- 不省进程 spawn（仍是 N 次），单批延迟下限不变；
- 不是事务：已成功的操作不会因后续失败回滚；
- 工具面多一个 schema，执行路径多一层 JS 分发。

### B3. 会话事实缓存（不做）

证据：`workingDirectory.ensure()` 每次 1 次 `resolve` + 1 次 `stat`（亚毫秒级）；而每次工具调用本来就要 spawn worker（10–30 ms）。缓存收益 **<2%**，却要处理 `cd` 与权限变更导致的失效；`ops_batch` 内已共用一次会话事实。不值得做。

### B4. 预算进 Config（已办）

| 字段 | 默认 | 范围 |
| --- | --- | --- |
| `maxResultBytes` | 131072 | 1024–131072 |
| `shell.stdoutMaxBytes` | 262144 | 4096–1048576 |
| `shell.stderrMaxBytes` | 65536 | 4096–1048576 |
| `shell.graceMs` | 1000 | 0–10000 |

这些字段（包括 `shell.probeTimeoutMs` 的 3000 与 `shell.maxSpawnFailures` 的 5）都是**普通字段**（不是 volatile）：界面改不到，按宿主设计写在 `cordis.patch.yml`。schema 先约束范围，使用点再 `clamp(value, min, max)` 一次；配置缺失或非法时回落默认，绝不把非法值传给宿主。

`shell.probeTimeoutMs` 要单独说明：它原本只有 `.min(1000)`、没有上限，而探活是同步 spawn，一个 YAML 笔误就能按候选数串行阻塞事件循环；现在 schema 补了 `.max(15000)`，使用点也按 1000–15000 钳制（`probeShell` 自身的下限保留）。

### B5. 仓库卫生（结论）

- `native/target/` 是 LTO 构建缓存，约 **666 MiB**，`.gitignore` 已忽略；**决定保留**以便增量构建。清理：`cd native && cargo clean`（或 `Remove-Item -Recurse -Force native\target`）。
- 自检覆盖：`_selftest.mjs` 用伪宿主跑 `apply()`，并对真实文件跑主要读取/搜索/批量/终端路径；`_failtest.mjs` 钉住反灾难不变量、默认终端切换、渲染诚实性与 `ops_batch`；`_clienttest.mjs` 用存根 React 覆盖浏览器半侧的 slot 注册与表单。**真机页面**（slot 契约、样式、主题 token、插件详情页渲染）仍需人工看，脚本不能代替。

### B6. 原生 worker 去死代码（已办）

`native/` 曾把三条本插件永远够不到的依赖编进 worker：`ops-documents`（`read_table` / `read_docx` / `read_pdf`）、`ops-batch`（worker 自己的 `batch`）、`ops-results`（`result` / 审计存储）。JS 侧从不发送这些工具名——批量由 JS 侧 `ops_batch` 实现，本插件也不发布 `ops_result`——它们只是体积与编译面。

现在 `native/Cargo.toml` 去掉了这三条 path 依赖，`native/src/lib.rs` 去掉了对应分支与 `ops_results::spill::finish`，`native/src/main.rs` 的 `may_mutate` 去掉了文档工具；`execute()` 只保留文件/搜索 op，其余工具名返回 `INVALID_ARGUMENT`。crate 目录与 workspace 成员列表保留。

实测：worker 二进制 **3,574,784 B（3.41 MiB）→ 2,463,744 B（2.35 MiB）**，**−1,111,040 B（−31.1%）**；加 `panic = "abort"` 后 `.pdata + .xdata`（unwind 表）从 **178,108 B** 降到 **71,332 B**。`Cargo.lock` 的包数不变（仍是 149），因为这三个 crate 仍是 `[workspace]` 成员；收益只在链接进二进制的部分。

## C. 结构性权衡（维持）

### C1. `engines.dsh` 钉得很窄（维持）

`>=0.2.2-rc.1 <0.2.3-0`。本插件用到的 `plugins.row.config` slot、`ctx.configForms`、`Config` 的 volatile 投影都是 rc 系列的行为；宿主进 0.2.3 就要重新核对一遍。这不是「改一下版本号」的事，而是需要重读宿主文档的事。

### C2. 浏览器半侧是手写的 lazy-CJS（维持）

好处：零构建，改完刷新页面就生效。
代价：`client.js` 没有类型检查，slot 契约只能靠文档 + 真机验证。已加 `node --check` 守卫；页面再复杂（例如加「探一下这个路径」按钮）就该考虑接宿主的 client build 预设。

### C3. `Config` 依赖 optional peer 的解析路由（维持）

机制：link 安装的包声明 `peerDependencies` → 解析层把裸 `@deepseek-ai/*` 路由到安装里的那份（`desktop-runtime.json` 的 `sharedPackages` 里有 `@deepseek-ai/schemastery@3.19.0`）。
好处：不把 schemastery 打进包里。
代价：这不是 npm 的语义，是 DSH 自己的解析层；换安装方式（真从 registry 装而不是 link）时要重新确认。兜底是「解析不到就没有页面，其余照常」，退化安全，但会**静默少一个页面**（只打一行日志）。

### C4. 提示词常驻（已办）

`shellSection()` 与其中与 `ops_shell` 工具描述重复的终端身份句已删除；system prompt 只保留压缩后的 `ROUTING_SECTION`（一段路由建议：搜索 / 目录 / 读取 / 修改 / 写前取 revision）。终端身份只出现在工具描述里，不再重复付费。

### C5. `ops_grep` 的 `count` / `files_with_matches` 渲染（本已紧凑）

两者现在已经是行文本（`count` 模式 `path: count`，`files_with_matches` 模式只输出 `path`，`content` 模式是 `path:line: text`），无需再改。数据量小，进一步压缩收益可忽略。

## 一句话现状

A 档全部落地并保持；B1 / B2 / B4 / B6 已办、B3 不做、B5 有意保留；C 档全部维持——工具面为 12 个文件工具 + `ops_batch` + 可选 `ops_shell`。
