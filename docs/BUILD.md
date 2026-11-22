# 构建与工程说明

面向要重建原生 worker、替换二进制、或二次裁剪这个包的人。日常使用看 [README.md](../README.md)；取舍与已完成项看 [OPTIMIZATION.md](../OPTIMIZATION.md)。

## Git Bash 的发现顺序

`defaultTerminal: gitbash` 时，`lib/shell.js` 按下面的顺序生成候选，逐个实测探活，**首个通过即停**：

1. 配置里显式的 `shell.gitbashPath` —— 权威，只试这一个；
2. `%ProgramFiles%` / `%ProgramFiles(x86)%` 下的 `Git\bin\bash.exe` 与 `Git\usr\bin\bash.exe`；
3. `%LOCALAPPDATA%\Programs\Git\...` 下的同名位置；
4. **由 PATH 上的 `git.exe` 反推 Git 根目录** → `<root>\bin\bash.exe` / `<root>\usr\bin\bash.exe`；
5. PATH 上的 `bash.exe`；
6. scoop（`%USERPROFILE%\scoop\shims\bash.exe`、`...\scoop\apps\git\current\bin\bash.exe`）、chocolatey（`C:\ProgramData\chocolatey\bin\bash.exe`）、msys64（`C:\msys64\usr\bin\bash.exe`、`C:\tools\msys64\usr\bin\bash.exe`）。

第 4 条是关键：Git 可以装在非系统盘（例如 `D:\Program Files\Git`），而 `%ProgramFiles%` 指向系统盘，只靠标准位置会漏掉它。PATH 上的 `git.exe` 才是真实根目录的证据——它通常位于 `<root>\cmd\git.exe` 或 `<root>\bin\git.exe`，取其父目录即得根目录。不猜盘符。

候选在 spawn 之前就会被过滤：不存在的路径、非可执行文件、`git-bash.exe` / `git-cmd.exe` 这类终端启动器、以及 WSL 的 `bash.exe`（`%SystemRoot%\System32\` 与 `%LOCALAPPDATA%\Microsoft\WindowsApps\`）都不会进入探活。探活本身真的执行一次固定命令并校验输出，不靠文件存在性推断。

## 原生 worker 与 provenance

工具本体是 Rust（上游 MIT 代码，`native/` 随包保留源码）。`runtime/<target>/dsh-ops-worker.exe` 是从 `native/` 源码构建的，不是上游预编译二进制。

`runtime/win32-x64/provenance.json` 记录 `target` / `executable` / `sha256`。`lib/worker.js` 在加载时校验这三项：二进制被改过、或 receipt 指向别的 target，都会直接拒绝运行。没有 receipt 时只提示、不拒绝，但**换了二进制不重写 receipt 会被拒绝**。

## 构建步骤

```console
cd native
cargo build --release --locked
# 产物：native/target/release/dsh-ops-worker.exe

# 复制到 runtime/win32-x64/ 并重写 provenance.json 的 sha256
powershell -ExecutionPolicy Bypass -File ..\scripts\stage-worker.ps1
```

`stage-worker.ps1` 也可以用 `-Source <path>` 指定别处的产物；它把文件复制到 `runtime/win32-x64/dsh-ops-worker.exe`，并以 `package.json` 的 `version` 重写 receipt。**这一步必须做**，否则校验会拒绝新二进制。

## 构建环境

实测可用的组合：

| 项 | 值 | 说明 |
| --- | --- | --- |
| Rust | **1.99.0**，`x86_64-pc-windows-gnu` | `native/rust-toolchain.toml` 固定 1.99.0（满足 crate 的 `rust-version = "1.88"`） |
| crates 源 | rsproxy 稀疏镜像 | `~/.cargo/config.toml` 里做 source replacement |
| binutils | MinGW-w64（需含 `as.exe`） | **必需**，见下 |

binutils 那一行是构建里最容易踩的坑：rustc 自带的 `dlltool.exe` 生成 import library 时要调用 `as`，而 toolchain 的 `self-contained` 目录里没有 `as.exe`，会报 `dlltool ... CreateProcess` 失败。构建时把 MinGW 的 `bin` 放到 `PATH` 前面，且**不要**把 toolchain 的 `self-contained` 放进 `PATH`，否则 rustc 会选那个缺 `as` 的 dlltool。

## release profile

`native/Cargo.toml` 的 release profile：

```toml
[profile.release]
strip = true
lto = "thin"
codegen-units = 1
```

体积变化：未优化 **7.84 MiB** → 仅 strip **5.34 MiB** → 三项齐上 **3.41 MiB**，比上游发布的 3.91 MiB 还小。当前 `runtime/win32-x64/dsh-ops-worker.exe` 即按此配置构建。

## 构建缓存

`native/target/` 是 LTO 构建缓存，约 **666 MiB**（`.gitignore` 已忽略）。有意保留以便增量构建；不需要时可以删除，重构建耗时更长：

```console
cd native && cargo clean            # 或从仓库根：
powershell -Command "Remove-Item -Recurse -Force native\target"
```

## Smart App Control（历史）

构建曾因 Smart App Control（SAC，`VerifiedAndReputablePolicyState=1`）完全无法进行。SAC 按**文件哈希 + 云信誉**放行可执行文件：

- `cargo.exe`（广泛分发）可执行，`rustc.exe` 1.100.0（发布 9 天）被拦，而 1.99.0 可执行——说明是哈希级信誉判定，不是路径或签名（这些二进制全部 `NotSigned`）。
- 即便换到能跑的编译器，**Cargo 编出的每个 build script 也是新哈希、一律被拦**：`could not execute process ...\build-script-build (never executed) / 应用程序控制策略已阻止此文件 (os error 4551)`。
- 自编译的 `hello.exe` 同样被拦——**产物本身也跑不起来**。

因此把 `VerifiedAndReputablePolicyState` 置 `0` 并重启后才完成构建。**注意：该开关关闭后无法在不重置系统的情况下重新开启。** 这也是 `native/rust-toolchain.toml` 固定 1.99.0 的原因之一。

## 用 workerPath 换二进制

`workerPath` 是显式信任的接缝：设置后跳过 provenance 校验（会打一条 warn），代码路径完全相同，换二进制不用改任何 JS：

```yaml
workerPath: 'D:\builds\dshops-lite\dsh-ops-worker.exe'
```

适合临时验证自建二进制。要正式随包发布，仍应走 `stage-worker.ps1` 更新 `runtime/` 与 receipt。

## 进一步裁剪

`native/src/lib.rs` 的 `execute()` 里，`read_table` / `read_docx` / `read_pdf` 走 `ops_documents`，而本插件从不发送这三个 op。若要连带去掉 `ops-documents` 依赖（可省 `zip` / `quick-xml` / `flate2` 一整串），删掉该分支和 `native/Cargo.toml` 里对应的一行即可。默认保留原样，未做该裁剪。

## 安装与重载

本包是无依赖的 Host + Client bundle（纯 ESM，无构建步骤：`client.js` 手写为客户端模块系统的 lazy-CJS factory 格式）。开发对应的宿主是 DSH `0.2.2-rc.5`；`engines.dsh` 声明 `>=0.2.2-rc.1 <0.2.3-0`（窄窗口是有意的，理由见 [OPTIMIZATION.md](OPTIMIZATION.md) 的 C1）。

```console
# 用插件管理器安装本地目录，或 Plugins → Add plugin 选包目录
plugin_manager install_bundle  <repo>
```

安装结果写入 profile：`dependencies.dshops-lite = "link:<repo>"`，并加入 `dsh.profile.bundles`，行状态为 `entryId: include:dshops-lite, enabled: true, fiberPhase: active`。

因为是 **link（软链接）**，改源码后需要让宿主重新加载模块才会生效——`plugin_manager set_plugin` 关再开即可（只改 `lib/*.js` 或 `client.js` 而不重载，跑的还是内存里的旧代码）。浏览器半侧改动后刷新页面即可。

装完可以这样确认：

1. 工具表里出现 12 个原生文件工具与 `ops_batch`；`ops_shell` **只在默认终端为 Git Bash 且探活通过时**出现。
2. 启动日志里有一行裁决：`dshops-lite: shell = Git Bash (MSYS2) (...)` 或 `dshops-lite: no shell tool published. ...`。
3. 宿主的 `pwsh` 工具**仍然存在**——本插件从不隐藏它。
4. 插件行的「配置」里能看到「默认终端」页，保存后立即按新终端工作。

## 自检

```console
node _selftest.mjs      # 伪宿主 + 真实 worker，跑主要读取/搜索/批量/终端路径
node _failtest.mjs      # 反灾难不变量、默认终端切换、渲染诚实性、配置 schema、ops_batch
node _clienttest.mjs    # 浏览器半侧：slot 注册、两个单选项、保存提交
npm test                # 以上三条 + client.js 语法检查
```

`_failtest.mjs` 的配置 schema 段需要部署里的 schemastery：先设置 `DSH_INSTALL_DIR` 再跑；未设置、或普通 `node` 进程读不到 `app.asar` 时会打印 `SKIP` 并跳过这几条。想让它真跑，可用 Electron 运行时：

```console
DSH_INSTALL_DIR="D:/Program Files/deepseek/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh" \
  ELECTRON_RUN_AS_NODE=1 "D:/Program Files/deepseek/DeepSeek Harness.exe" _failtest.mjs
```

**真机页面**（slot 契约、样式、主题 token、插件详情页渲染）仍需在浏览器里人工确认，脚本不能代替。
