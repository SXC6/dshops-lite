# 变更记录

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。版本号以 `package.json` 为准（当前 `0.3.1`）。

## [0.3.1] - 2026-11-22

### 接口

- `ops_shell` 的输出 schema 不再只是 `{ type: 'object' }`，而是声明真实字段：`exitCode`（integer）、`stdout` / `stderr`（string）、`truncated`（array，元素只能是 `stdout` / `stderr`），四者均为 required。代码模式的消费方（如 `run_code`）可以按契约直接取值，不必猜形状——此前把 `stdout` 当成 `{ text }` 读取会静默拿到 `undefined`。模型侧渲染文本不变。
- `runtime/win32-x64/provenance.json` 的 `version` 与 `package.json` 对齐（`0.3.1`）。该字段此前长期停在 `0.1.0`，且运行时只校验 target / executable / sha256，不校验版本，所以漂移是静默的。

### 行为变更

- 搜索分页：`truncatedBy: row-limit` 且结果带有限的 `nextOffset` 时，提示改为真实的 `continue with offset=N`——此前该分支按 `pageComplete` 判断，而行数截断的 `pageComplete` 是 `true`，于是模型被误导去重搜。其余没有稳定续页的截断原因（如扫描预算 `scan-budget`）仍提示「缩小 path 再搜」。
- `ops_batch` 的可链操作由 12 个收窄为 8 个：`stat` / `write_file` / `edit_file` / `replace` / `diff` / `copy` / `move` / `remove`。读类操作（`inspect_local_file` / `read_files` / `glob` / `grep`）的输出无法进入批量的单行摘要，继续链式调用会静默丢内容；现在这些操作会被拒绝并提示允许的集合。
- `ops_shell` 新增命令截止时间 `shell.commandTimeoutMs`（默认 120000，范围 1000–600000 毫秒；包内 `cordis.patch.yml` 同步给出默认值）。宿主的 subprocess seam 没有 timeout 字段，截止时间由插件自己持有，超时与因果分类都归调用方。超时和调用方取消现在分别报错，且**都不再**计入 `maxSpawnFailures` 的熔断预算；普通非零退出码仍是正常结果。
- `shell.probeTimeoutMs` 补上上限：schema 由只有 `.min(1000)` 改为 `.min(1000).max(15000)`，使用点再钳制一次；YAML 笔误不再能让启动探活按候选串行阻塞事件循环。

### 性能

- worker 启动不再无条件读取并 SHA-256 整个二进制：默认 `runtime/<target>/` 下没有 `provenance.json` receipt 时直接跳过哈希，有 receipt 才计算摘要用于比对（显式 `workerPath` 的接缝行为不变）。
- 原生 worker 去掉三条运行期不可达的依赖（`ops-documents` / `ops-batch` / `ops-results`），并启用 `panic = "abort"`：二进制 3,574,784 B（3.41 MiB）→ 2,463,744 B（2.35 MiB），−31.1%；unwind 表（`.pdata + .xdata`）178,108 B → 71,332 B。`Cargo.lock` 包数不变（仍是 149）。

### 修复

- 插件页文案回退改为按当前界面语言：宿主字典 → 本包对应语言 → 英文 → key。中文界面在宿主缺词时不再回落成英文，未知语言（如 `de`）安全降级为英文。

### 打包与文档

- 保持 `private: true`：分发方式仍是 link 安装（见 `docs/BUILD.md`「安装与重载」），不发布到 npm registry。
- 新增 `LICENSE`（MIT）；`files` 不再包含 `_selftest.mjs` / `_failtest.mjs` / `_clienttest.mjs` / `OPTIMIZATION.md`（脚本仍留在仓库里）。
- `exports` 增加 `./cordis.patch.yml`，使 `dsh.bundle.patch` 指向的补丁文件可以被解析。
- 补全 `engines.node`（`>=18`）、`repository`、`author`、`keywords`。
- 新增 `.gitattributes` / `.editorconfig`：文本 LF、PowerShell CRLF、`*.exe` 按二进制处理。
- 新增 `SECURITY.md`；`docs/BUILD.md` 更正为「Rust 源码在仓库、不在发布的 tarball 里」，并说明构建与默认的 `stage-worker.ps1` 只在仓库检出里可用。
