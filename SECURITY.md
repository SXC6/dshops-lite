# 安全策略

## 报告漏洞

请**私下**报告，不要开公开 issue：

- 首选：在本仓库（<https://github.com/SXC6/dshops-lite>）的 Security → Report a vulnerability 提交 GitHub Security Advisory；
- 若不可用：直接联系维护者（GitHub @SXC6）。

报告里请写明：`package.json` 的 `version`、平台、复现步骤、影响（读文件 / 写文件 / 执行命令哪一环），以及是否在宿主沙箱之外验证过。修复发布前请勿公开细节。

## 支持范围

只对最新代码（当前 `0.3.0`）提供安全修复。本包是 `private: true` 的内部包，分发方式是 link 安装（见 `docs/BUILD.md` 的「安装与重载」），不从 npm registry 发布。

## 这个包装了什么、能做什么

**随包发布并执行原生二进制。** `runtime/win32-x64/dsh-ops-worker.exe` 由本仓库从 `native/` 的 Rust 源码构建，插件启动时加载并执行它。`runtime/win32-x64/provenance.json` 记录 `target` / `executable` / `sha256`，用来发现二进制被意外替换或损坏；**它不是签名**，抵不过蓄意的供应链替换——要防这一层，请自行确认来源，只从可信的仓库 / 构建产物安装。

**会 spawn Git Bash。** `defaultTerminal: gitbash` 且探活通过时，`ops_shell` 经宿主的 subprocess seam 启动 `bash.exe`。模型提交的命令以 DSH 进程自身的权限运行，没有降权、没有额外隔离；能拿到什么权限，取决于宿主进程本身。

**不提供自己的沙箱。** 本插件不实现 OS 级隔离，也没有网络服务或遥测。

## worker 的 `root` 不是隔离边界

`root`（会话工作目录）只决定路径怎么解析、结果以什么为基准；**它不是 containment 边界**——不要把「文件工具在 root 下工作」当成对命令或进程的隔离。真正约束工具只能做什么的只有三样：

1. **DSH 宿主的沙箱**（若部署启用了）——这是唯一能隔离任意命令的边界；
2. **只读标志**：只读会话里 `ops_shell` 直接拒绝、不 spawn，文件写操作由 worker 的 `read_only` 拒绝；
3. **凭证文件名围栏**：`denyCredentialReads`（默认开）按**名字**匹配拒绝读取：`id_rsa` / `id_dsa` / `id_ecdsa` / `id_ed25519`、`.env`、`*credentials*.json|yaml|ini`、`service-account*.json`。它防的是误读，不是权限控制；把文件改成不匹配的名字即可绕过。

因此**不要把本插件当作 containment**。需要真正隔离时，用 DSH 宿主的沙箱（或容器 / 低权限账户）运行，并且不要把 `workerPath` 指向来源不明的二进制。

## 部署注意

- 二进制未签名：Windows Smart App Control 可能直接拦截新构建的 `dsh-ops-worker.exe`（见 `docs/BUILD.md` 的「Smart App Control（历史）」）。
- `workerPath` 是显式信任的接缝：设置后跳过 provenance 校验，只应指向你自己构建的产物。
