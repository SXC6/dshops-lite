# dshops-lite

一个精简的 DSH 插件：**只保留 `ops_*` 文件/搜索工具**，外加**一个**可用终端（Git Bash 或 PowerShell，二选一）。不打包任何 bash 载荷，不提供 PTC / 动态工具发现 / 预设 / 文档读取。

## 为什么要有它

dsh-ops 的机制是对的（有界输出、分页、批量、诚实状态），但它把成本默认全开，并且出过一个致命 bug：niubash 调用失败 → 回退 pwsh 也失败 → 模型对着永远不可能成功的工具空转，烧掉整轮 token。

本插件针对这两点：

1. **只保留真正省 token 的部分**，砍掉「每加载一个工具族就多一次模型调用」的渐进披露链路。
2. **工具只有在被证明能跑之后才会注册**。一个起不来的 shell 不会被发布，模型根本看不到它。

## 反灾难设计（核心）

这是本插件唯一不可妥协的部分，写在 `lib/shell.js` 顶部。四条不变量：

| # | 不变量 | 为什么 |
| --- | --- | --- |
| 1 | **可用性靠实测，不靠 `fs.existsSync`** | 文件存在但跑不起来，正是那个 bug 的形态。`probeShell()` 真的执行一次固定命令并校验输出。 |
| 2 | **显式指定的后端绝不静默换到另一个** | `backend: gitbash` 起不来就是「没有 shell 工具」，不是「偷偷用 pwsh」。 |
| 3 | **探不通就一个工具都不发** | 缺席优于坏工具。宿主的 `pwsh` 工具完全不受影响，模型仍有可用终端。 |
| 4 | **运行期连续失败后熔断** | 默认 2 次后该后端在本次会话永久停用，后续调用直接抛终止性错误并明确要求改用宿主 shell，不给出可重试的假象。 |

另外，`probeShell()` 会**拒绝**两类危险候选：

- `git-bash.exe` / `git-cmd.exe`：这是终端启动器（Mintty / 控制台窗口），不是 shell。拿它当工具 shell 会弹出独立窗口并让捕获式调用永久挂起——本身就是在制造「两边都失败」。
- `%SystemRoot%\System32\bash.exe` 与 Store 别名 `%LOCALAPPDATA%\Microsoft\WindowsApps\bash.exe`：这是 WSL 启动器，命令会跑到另一个（Linux）文件系统里。

### Git Bash 怎么被发现

不猜盘符。优先顺序：

1. 配置里显式的 `gitbashPath`（决定性，只试这一个）
2. `%ProgramFiles%\Git\bin\bash.exe` 等标准位置
3. **由 PATH 上的 `git.exe` 反推 Git 根目录** → `<root>\bin\bash.exe`
4. PATH 上的 `bash.exe`
5. scoop / chocolatey / msys64 等常见位置

第 3 条是关键：本机 Git 装在 `D:\Program Files\Git`（非系统盘），`%ProgramFiles%` 指向 C 盘，只靠标准位置会漏掉它；而 `git.exe` 在 PATH 上（`D:\Program Files\Git\cmd\git.exe`），由它反推根目录最可靠。

## 工具面

12 个原生文件工具 + 1 个可选 shell：

| 工具 | 作用 |
| --- | --- |
| `ops_inspect_local_file` | 按行区间读一个文件 |
| `ops_read_files` | 一次读多个文件的区间 |
| `ops_glob` | 按 glob 找文件/目录 |
| `ops_grep` | 正则搜索内容（content / files_with_matches / count） |
| `ops_stat` | 存在性、大小、行数、**revision** |
| `ops_write_file` | 整文件写，带 `expectedRevision` 并发保护 |
| `ops_edit_file` | 精确文本替换，`oldText` 必须唯一匹配 |
| `ops_replace` | 跨文件**字面**替换（不是正则，见下） |
| `ops_diff` | 对比磁盘内容与拟写内容，不落盘 |
| `ops_copy` / `ops_move` / `ops_remove` | 带 revision 守卫的路径操作 |
| `ops_shell` | **仅在探活通过时存在**，后端固定 |

要点：

- **写操作都要 `expectedRevision`**（先 `ops_stat` 拿 revision，或 `"absent"`）。这是防并发覆盖，不是仪式。
- **输出是紧凑行文本**，不是 JSON 大块。分页字段（`nextOffset` / `complete` / `scanComplete` / `pageComplete`）会渲染成一行 `[truncated; continue with offset=N]`，**截断永远不会静默**。
- **失败会 `throw`**，因为本版本宿主（0.2.2-rc.5）的工具契约里 `return` 等于成功、只有 `throw` 才是硬失败。错误消息里带 `Do not retry this call unchanged.`，用来打断重试循环。

## 配置

`cordis.patch.yml` 里的 `dshops-lite` 行：

```yaml
shell:
  backend: pwsh        # 本机默认：PowerShell 7.5.4；可改 gitbash / auto / none
  gitbashPath: ''      # 留空则自动发现
  pwshPath: ''         # 留空则自动发现（PS7 优先，含 Windows PowerShell 5.1 兜底）
  probeTimeoutMs: 15000
  maxSpawnFailures: 2  # 连续失败多少次后熔断
workerPath: ''         # 留空用 runtime/<target>/ 下的 worker
toolTimeoutMs: 30000
denyCredentialReads: true
promptSection: true    # 设为 false 可完全不加系统提示段
```

`backend` 语义：

- `pwsh`（**本机当前默认**）：只试 PowerShell 族。解析顺序与宿主一致——`C:\Program Files\PowerShell\7\pwsh.exe` → PATH 上的 `pwsh.exe` → `System32\WindowsPowerShell\v1.0\powershell.exe`。探不通就**不发布 shell 工具**。
- `gitbash`：只试 Git Bash。可选终端，探不通同样不发工具。
- `auto`：先 Git Bash 再 PowerShell，第一个探活通过的胜出（本机未采用，但行为保留）。
- `none`：不发布 shell 工具。

三种非 `none` 取值都**不会静默换到另一个后端**——这是反灾难不变量第 2 条。

本机实测（`backend` 各取值下探活结果）：

| backend | 解析到 | 版本 |
| --- | --- | --- |
| `pwsh` | `C:\Program Files\PowerShell\7\pwsh.exe` | 7.5.4 (Core) |
| `gitbash` | `D:\Program Files\Git\bin\bash.exe` | GNU bash 5.3.15 |
| `auto` | `D:\Program Files\Git\bin\bash.exe` | GNU bash 5.3.15 |

## 原生 worker

工具本体是 **Rust**（上游 MIT 代码，`native/` 随包保留源码）。

`runtime/win32-x64/dsh-ops-worker.exe` **是本机从 `native/` 源码构建的**，不是上游预编译二进制。`provenance.json` 记录 sha256，插件加载时校验。

```console
# 构建（Windows / x86_64-pc-windows-gnu）
cd native
cargo build --release --locked
# 产物 target/release/dsh-ops-worker.exe
powershell -ExecutionPolicy Bypass -File ..\scripts\stage-worker.ps1
```

`stage-worker.ps1` 会复制产物并重写 `provenance.json` 的 sha256——**必须做**，否则校验会拒绝新二进制。

### 构建环境（本机实测可用的组合）

| 项 | 值 | 说明 |
| --- | --- | --- |
| Rust | **1.99.0** `x86_64-pc-windows-gnu` | 上游 `rust-toolchain.toml` 钉的是 1.97.1；1.99.0 可用 |
| crates 源 | rsproxy 稀疏镜像 | `~/.cargo/config.toml` 里做了 source replacement |
| binutils | MinGW-w64（需含 `as.exe`） | **必需**。rustc 自带的 `dlltool.exe` 生成 import library 时要调用 `as`，而 toolchain 的 `self-contained` 目录里没有 `as.exe`，会报 `dlltool ... CreateProcess` |

构建时把 MinGW 的 `bin` 放到 `PATH` 前面，且**不要**把 toolchain 的 `self-contained` 放进 `PATH`——否则 rustc 会选那个缺 `as` 的 dlltool。

### release profile 的优化

`native/Cargo.toml` 加了：

```toml
[profile.release]
strip = true
lto = "thin"
codegen-units = 1
```

效果：未优化 7.84 MiB → 仅 strip 5.34 MiB → 三项齐上 **3.41 MiB**，比上游发布的 3.91 MiB 还小。

### Smart App Control（历史，已解决）

早期本机开着 SAC（`VerifiedAndReputablePolicyState=1`），它按**文件哈希 + 云信誉**放行可执行文件，导致构建完全无法进行：

- `cargo.exe`（广泛分发）可执行，`rustc.exe` 1.100.0（发布 9 天）被拦，而 1.99.0 可执行——说明是哈希级信誉判定，不是路径或签名（这些二进制全部 `NotSigned`）。
- 即便换到能跑的编译器，**Cargo 编出的每个 build script 也是新哈希、一律被拦**：`could not execute process ...\build-script-build (never executed) / 应用程序控制策略已阻止此文件 (os error 4551)`。
- 而且自编译的 `hello.exe` 同样被拦——**产物本身也跑不起来**。

因此把 `VerifiedAndReputablePolicyState` 置 `0` 并重启后才完成构建。**注意：该开关关闭后无法在不重置系统的情况下重新开启。**

唯一出路是关闭 Smart App Control：需要管理员，且按微软的说明，关闭后**无法在不重置系统的情况下再开启**。这是你的决定，我不替你改。

### 换成别的 worker 二进制

`workerPath` 是显式信任的接缝：设置后跳过 provenance 校验（会打一条 warn），代码路径完全相同，换二进制不用改任何 JS：

```yaml
workerPath: 'D:\builds\dshops-lite\dsh-ops-worker.exe'
```

### 想裁得更狠

`native/src/lib.rs` 的 `execute()` 里，`read_table` / `read_docx` / `read_pdf` 走 `ops_documents`，本插件从不发送这三个 op。若要连带去掉 `ops-documents` 依赖（可省 `zip` / `quick-xml` / `flate2` 一整串），删掉该分支和 `native/Cargo.toml` 里对应的一行即可（默认保留原样，未做该裁剪）。

## 安装（已在本机完成）

宿主：DSH `0.2.2-rc.5`。本包是**无依赖**的 Host-only bundle（纯 ESM，无 JS 构建步骤）。

```console
# 用插件管理器安装本地目录，或 Plugins → Add plugin 选 D:\code\dshops-lite
plugin_manager install_bundle  D:\code\dshops-lite
```

安装结果写入 profile：`dependencies.dshops-lite = "link:D:/code/dshops-lite"`，并加入 `dsh.profile.bundles`，行状态为 `entryId: include:dshops-lite, enabled: true, fiberPhase: active`。

因为是 **link（软链接）**，改源码后需要让宿主重新加载模块才会生效——`plugin_manager set_plugin` 关再开即可（只改 `lib/*.js` 而不重载，跑的还是内存里的旧代码）。

### 装完怎么确认

1. 你/新会话的工具表里出现 12 个 `ops_*` 文件工具 + `ops_shell`。
2. 启动日志里有一行裁决：`dshops-lite: shell backend = Git Bash (MSYS2) (...)` 或 `no shell tool published.`。
3. 宿主的 `pwsh` 工具**仍然存在** —— 本插件从不隐藏它，那正是第 3 条不变量的安全网。

## PowerShell 7 与本机默认终端

本机安装了 **PowerShell 7.5.4** 到 `C:\Program Files\PowerShell\7\`（MSI 静默安装，签名验证为 Microsoft Corporation）。插件与宿主都指向它。

宿主自己的解析顺序（`@deepseek-ai/dsh-pwsh-local` 的 `candidatePwshPaths`，逐条 `lstat` 探活）：

1. `%ProgramFiles%\PowerShell\7\pwsh.exe` ← **绝对路径优先，不看 PATH**
2. PATH 上的每个目录 + `pwsh.exe`（Store 安装走这条）
3. `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`（5.1 兜底）

**装完要让运行中的宿主真正切换，需要重挂载执行器**：解析结果在挂载时算好并缓存，所以新装 PS7 后正在跑的会话仍是 5.1。实测先禁用再启用 `include:pwsh-sandbox` 即可生效，**不需要重启 DSH**：

```
plugin_manager set_plugin include:pwsh-sandbox enabled=false
plugin_manager set_plugin include:pwsh-sandbox enabled=true
```

之后 `$PSVersionTable` 从 `5.1.26100.9818 / Desktop` 变成 `7.5.4 / Core`，镜像路径变成 `pwsh.exe`。（这一步也可用重启 DSH 达到同样效果。）

## 已知行为：`ops_replace` 是字面替换

`ops_replace` 在 Rust 里是 `str::match_indices` + `str::replace`，**不是正则**。`pattern` 和 `replacement` 都按字面处理：写 `TOK.N` 不会匹配 `TOKEN`，写 `\(` 会去找真正的反斜杠，`$1` 也不会展开成捕获组。

需要正则时用 `ops_grep`（它确实是正则，`regex::RegexBuilder`）定位，再用 `ops_replace` 做字面替换。这一点有断言守护：工具描述若被改回"regex"，`_failtest.mjs` 会失败。

## 已知行为：搜索预算

在一个大目录（例如包含工具链或 `node_modules` 的根目录）上直接 `ops_glob`/`ops_grep`，扫描会在到达目标前停下，此时结果必须被读成"没扫完"，而不是"没匹配"：

```
(no matches in the part that was scanned — the search did not finish)
[scan budget reached after 10000 files; no continuation — narrow the path and search again]
```

这类不完整遍历**没有稳定续页**，所以不要按 `offset` 重试，而是给 `path` 收窄范围。`_failtest.mjs` 里有一条断言专门钉住这种行为（不完整的扫描绝不能说成 `(no matches)`）。

## 自检

```console
node _selftest.mjs    # 用伪造宿主服务跑 apply()，再对真实文件执行每个工具；意外抛错即失败
node _failtest.mjs    # 29 条断言：反灾难不变量 + 渲染诚实性 + 工具描述不漂移
```