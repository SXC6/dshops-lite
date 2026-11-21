# dsh-ops 项目分析

> 分析对象：`D:\code\dsh-ops`（upstream `main` @ `bfdfdf6`，版本 0.5.6，MIT）
> 目的：为 dshops-lite 的取舍提供依据
> 说明：本篇只读不跑。所有数字来自仓库自带文档/源码，已在文中标注出处。

## 0. 一句话结论

dsh-ops 的**机制**是对的（有界输出 / 分页 / 批量 / 诚实状态码 / 渐进披露），但它是把**全部成本默认打开**的重型实现。所以"增加 token 消耗和模型调用次数"的批评**在短任务上成立**，在长任务（多文件、搜索密集）上不成立——问题不在机制，在默认值。

## 1. 规模与工程约束

| 项 | 数值 |
| --- | --- |
| 插件版本 | 0.5.6，MIT，npm 包 `dsh-ops` |
| TypeScript 源码 | 266 文件 / ~23.8k 行 → `tsc` 编译到 `lib/` |
| Rust worker | 183 文件 / ~45.6k 行，10 个 crate |
| 测试 | 309 个 suite / ~48k 行 |
| bench | 64 文件 / ~14.8k 行（仓库内，不随包发布） |
| 文档 | 137 篇 / ~12.6k 行，中英双语成对 |

工程约束很硬，值得借鉴：单文件 ≤1000 行（`npm run check:size` CI 门禁）、每个 PR ≤~1000 行实现、工具失败必须是返回值而不是异常、不接受 AI 署名、新增行为必须有不反转就失败的断言。

## 2. 架构

分层：`integration/`（公开入口）→ `consumer/`（预设装配）→ `capabilities/`（工具契约）→ `publication/`（作用域发布）→ `execution/`（worker 桥）。

两个核心设计：

1. **一个 Rust kernel，两个 projection。** Native 输出给模型读的紧凑文本；PTC 输出给沙箱代码读的强类型数据。共享执行层，投影刻意分开（`docs/内部架构.md`）。
2. **Native/PTC 共享调用预算。** 同会话 FIFO，最多 2 并发、8 排队，溢出返回 `CALL_LIMIT` 且无副作用（`src/kernel/call-budget.ts`）。

14 个 component 目录 + 5 个内置预设（`minimal` / `standard` / `ptc` / `ops-ptc` / `cordis`）。单行配置：一个 `dsh-ops` 行挂全部功能，旧 `mode-*` / `shell` / `file` / `ptc` 等保留为兼容导出。

## 3. 省在哪 —— 6 个真正值得抄的机制

1. **有界输出 + spill。** 模型面文本 ≤64 KiB，传输 ≤128 KiB，超限落盘成 `ref://` 句柄，用 `ops_result` 分页取（`docs/结果预算.md`）。这是省 token 的主力。
2. **分页语义完整。** `nextOffset` / `complete` / `scanComplete` / `pageComplete` / `displayComplete` 分开报告，并明确"只有 `displayComplete=true` 才能跟 `nextOffset`"。避免"结果被截断但我不知道"→ 避免重试。
3. **失败是值。** `status` / `error.code` / `effectState`，从不 throw；也不把部分或提前停止的结果报成 complete。
4. **批量。** `ops_batch` 一次调用做 N 个文件操作；PTC 侧用 `run_code` + `Promise.all`。
5. **隐藏官方工具。** 默认 `hideOfficialTools: true`，避免新旧两套工具并存——并存才是最贵的 schema 税。
6. **稳定字节。** 同配置下 system/history 逐字节可复现（测试钉死 sha），缓存友好。

## 4. 费在哪 —— 成本实测

来自仓库自己的 `docs/成本分账.md`（插件 0.5.5 / host 0.2.2-rc.1 / `ops-ptc` 预设 / linux-x64）：

| 账目 | 首次请求（仅常驻） | 加载 SDK 后 |
| --- | --- | --- |
| system（渲染提示） | 12,782 B | 37,892 B |
| └ 其中 `tools:sdk` | 11,739 B | 36,849 B |
| wire（外层工具 schema） | 2,500 B | 2,500 B |
| history（插件引导） | teaching 7,538 B | + plan notice 200 B |

四个真实成本来源：

1. **PTC SDK 段巨大。** 加载 `glob`/`grep`/`read_files` 让 system 涨 **+25,110 B**（≈6k token）。同一文档给出的官方对照：`read` 438 B、`glob` 750 B、`grep` 702 B。
2. **教学消息进历史。** 7,538 B 的用户角色消息（`prompts/batching-guidance.md`，8,170 B 源文件）。一旦进入会话历史，**每次后续请求都要重发**。README 也自承常驻高级工具"大约增加约1000token的系统提示词"。
3. **纠偏 notice 无上限。** `src/ptc/batching-guidance.ts` 原文写了 `There is deliberately no per-turn cap`；3 类（`bypass` / `plan` / `shape`）各自上膛，合规后**重新上膛**。模型不照做就反复注入，每条 200–350 B，且永久留在历史里。
4. **加载式发现有 round-trip 税。** `ops_load_sdk` / `ops_discover_tools` 选中的 API **下一个 model step 才可见**（`docs/动态工具目录.md` 专门强调"不要在同一个 `run_code` 里调用刚加载的 API"）。每引入一个新工具族 = +1 次模型调用。Standard/Cordis 初始只常驻 `inspect_local_file` / `glob` / `grep`，`read_files` 与 `result` 都要加载。

次要成本：Rust worker 每次调用 spawn 一个进程（延迟/CPU，不占 token）；Windows 可选 niubash 载荷约 100 MB（对比 git bash 300 MB、WSL 1 GB，见 README）。

## 5. "反作用"批评怎么判

按任务形态分档：

| 场景 | 固定成本 | 变动收益 | 净 |
| --- | --- | --- | --- |
| 改一行 / 问一句 | 教学 7.5 KB + SDK 段 11.7 KB + notice | 几乎没有 | **明显亏** |
| 多文件重构 / 大仓搜索 | 同上，但一次性摊薄 | 分页 + 批处理省下的 output 与 round trip 远超固定成本 | **明显赚** |

批评成立的部分不是"机制错"，而是**默认值激进**：`bash` / `hidePwsh` / `hideOfficialTools` / `dynamicTools` 全默认 `true`，`ops-ptc` 的 `batchingGuidance` 也默认 `true`（`cordis.patch.yml`）。等于让每个用户在任何任务上先付全额固定成本，所以"装了更费"是真实体感。

值得注意的是它自己并不声称稳赚：`docs/schema-measurement.md` 明写 "Actual request count, cache pricing, tool output and repeated history can outweigh fixed schema savings; no percentage here predicts task-total provider tokens."

## 6. dshops-lite 的建议取舍

**抄**：有界输出 + spill 句柄、分页四态、失败即值、批量合并、稳定字节缓存友好。

**不抄，或改成默认关**：

| 项 | 理由 |
| --- | --- |
| PTC 式渐进加载 | 除非 API 面真的 >15 个，否则 round-trip 税 > schema 税 |
| 一次性教学消息 | 收益靠提示词，成本按历史长度复利 |
| 不限次纠偏 notice | 改成每轮最多 1 条，或干脆不做 |
| 默认隐藏官方工具 | 默认并存更安全；或只隐藏真正 1:1 替代的那几个 |
| 5 个预设 + 14 个 component | lite 版 1 个模式足够 |
| 自建 Rust worker | 首版用宿主现成工具面 + 轻量 JS 后处理，避开进程 spawn 与 183 文件的维护量 |
| 100 MB bash 载荷 | Windows 直接用宿主 pwsh |

**骨架建议**：单 component、单模式，只做三件事——(a) 输出压缩与 spill，(b) `grep`/`glob`/`read` 的分页与诚实状态，(c) 一个 `ops_batch` 合并入口。目标 1–2k 行 TS，零 Rust。

## 7. 待确认 / 风险

- **宿主版本窗口极窄。** `peerDependencies` 写死 `@deepseek-ai/dsh >=0.2.2-rc.1 <0.2.3-0`，`engines.dsh` 相同。宿主一旦进 0.3，这个插件直接装不上/不激活。lite 版必须按实际宿主版本对齐（本机 profile 未安装 dsh-ops，`DSH_INSTALL_DIR` 指向 asar 内部，宿主版本未能直接读出）。
- **文档有漂移。** `docs/内部架构.md` 称"内置配置使用 `hideOfficialTools: false`"，但 `cordis.patch.yml` 与 `src/settings/merged.ts` 的默认值都是 `true`。以代码为准。
- **复杂度是主要维护风险。** 23.8k TS + 45.6k Rust，测试量是源码的 1.4 倍；lite 版若照搬分层会立刻失去"轻"的意义。

## 附：本地状态

- 源码树取自 codeload 归档（github.com 的 git pack 传输在本机网络下会卡在 `index-pack`），已 `git init` 并提交为快照 commit `adad2df`，`origin` 指向 upstream。需要真实历史时执行 `git fetch --depth 1 origin main` 后 `git reset --hard FETCH_HEAD`。