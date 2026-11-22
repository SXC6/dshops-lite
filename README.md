# dshops-lite

一个精简的 DSH 插件：只保留 `ops_*` 原生文件/搜索工具，外加**可选**的 Git Bash 终端。不打包任何 bash 载荷，也不做代码沙箱、按需加载工具或预设。

## 前提

- **Node ≥ 18**：入口使用顶层 await 与 `crypto.randomUUID`，`engines.node` 声明为 `>=18`。
- **Windows**：随包提供的是 `runtime/win32-x64/` 下的原生 worker；其他平台需要自建 worker，并用 `workerPath` 指定。worker 加载不了时不会发布任何文件工具。
- **要用 Git Bash 终端**：需要已安装 Git for Windows。探活不通过时不会发布 `ops_shell`，宿主的 `pwsh` 工具不受影响。

## 两种默认终端，只多一个工具

宿主自带 `pwsh` 工具，所以本插件只在能提供宿主没有的东西时才发布 shell：

| 默认终端 | 插件做什么 | 模型看到的终端 |
| --- | --- | --- |
| `pwsh`（默认） | 不发布任何 shell 工具，也不探测 | 宿主的 `pwsh` 工具，与未开启本插件时一致 |
| `gitbash` | 探活 Git Bash，通过则发布 `ops_shell` | `ops_shell`（Git Bash）为默认终端，宿主 `pwsh` 仍可用 |

切换方式：侧边栏「插件」→ `dshops-lite` →「配置」。设置里的「内置插件」只是只读清单，改不了这里。`defaultTerminal` 保存后立即生效，**不需要**重载插件或重启 DSH。

## 工具面

12 个文件工具：

| 工具 | 作用 |
| --- | --- |
| `ops_inspect_local_file` | 按行区间读一个文件 |
| `ops_read_files` | 一次读多个文件的区间 |
| `ops_glob` / `ops_grep` | 按 glob 找路径 / 按正则搜内容 |
| `ops_stat` | 存在性、大小、行数、**revision** |
| `ops_write_file` / `ops_edit_file` / `ops_replace` | 整文件写 / 精确文本替换 / 跨文件**字面**替换 |
| `ops_diff` | 对比磁盘与拟写内容，不落盘 |
| `ops_copy` / `ops_move` / `ops_remove` | 带 revision 守卫的路径操作 |

- `ops_batch`：一次调用顺序执行多个文件操作（1–32 条），逐条报告成败；每个操作仍单独跑一次 worker，适合 3 个以上**无法合并成一次调用**的操作。只接受结果能进一行摘要的 8 个操作（`stat` / `write_file` / `edit_file` / `replace` / `diff` / `copy` / `move` / `remove`）；读类操作不进批量，多次读取用 `ops_read_files`。
- `ops_shell`：**仅当** `defaultTerminal: gitbash` 且 Git Bash 探活通过时存在；发布期间后端固定。把默认终端改成 `pwsh` 会撤回它，改回 `gitbash` 则按新配置重新解析并发布——任何情况下都不会静默换成别的 shell。

要点：

- **写、改、复制、删除、移动必须带 `expectedRevision`**：`ops_stat` 取到的 64-hex revision；只有 `ops_write_file` 新建文件时可以传 `"absent"`。`ops_replace` 没有 revision 参数，不要给它传。
- 列表类结果是紧凑行文本，写/改/复制/删除/移动返回紧凑 JSON；分页与截断状态会渲染成一行提示，**截断永远不会静默**。
- 不可重试的错误会带 `Do not retry this call unchanged.`，用来打断重试循环。

## 配置

界面只提供 `defaultTerminal`；其余参数在你的 profile 的 `cordis.patch.yml` 里覆写。下面是 `dshops-lite` 那一行的 `config` 片段（完整的 patch 文档形状见包内 `cordis.patch.yml` 的 `- insert:` / `- id: dshops-lite` / `config:`）：

```yaml
defaultTerminal: pwsh
shell:
  gitbashPath: ''          # 留空则自动发现
  probeTimeoutMs: 3000     # 每个候选的探活上限（毫秒），范围 1000–15000
  commandTimeoutMs: 120000 # 单条命令的截止时间（毫秒），范围 1000–600000
  maxSpawnFailures: 5      # 连续失败多少次后本会话停用 ops_shell
  stdoutMaxBytes: 262144   # stdout 采集上限
  stderrMaxBytes: 65536    # stderr 采集上限
  graceMs: 1000            # 进程退出宽限（毫秒）
maxResultBytes: 131072     # worker 结果上限
```

包内 `cordis.patch.yml` 的 `shell:` 块给出的就是这些默认值（含 `commandTimeoutMs: 120000`），可直接对照；其余字段（`workerPath`、`toolTimeoutMs`、`denyCredentialReads`、`promptSection`）见该文件的注释。

## 反灾难设计

- **可用性靠实测**：探活真的执行一次固定命令并校验输出，不看 `fs.existsSync`。
- **配置的路径绝不静默换成别的 shell**：起不来就是「没有 shell 工具」。
- **探不通就一个 shell 工具都不发**：缺席优于坏工具；宿主的 `pwsh` 工具完全不受影响。
- **运行期熔断**：连续 `maxSpawnFailures`（默认 5）次失败后，本会话停用 `ops_shell`，并明确提示改用宿主 `pwsh`。

`git-bash.exe` / `git-cmd.exe` 这类终端启动器，以及 WSL 的 `bash.exe`（`System32` / `WindowsApps`）一律拒绝。

## 已知行为

- `ops_replace` 是**字面**替换，不是正则；需要正则时先用 `ops_grep` 定位。
- 搜索预算耗尽时，结果必须读成「没扫完」而不是「没匹配」；这类扫描没有稳定续页，应缩小 `path` 再搜。行数截断（`row-limit`）不同：只要结果带有限的 `nextOffset`，提示就给出真实的续查 `offset`。
- `ops_shell` 输出被采集上限截断时会明写 `truncated`。

## 开发

构建、替换 worker、自检与取舍记录见 `docs/BUILD.md`。

本包声明 `private: true`，分发方式是 link 安装（`dependencies.dshops-lite = "link:<repo>"`），不发布到 npm registry。变更记录见 [CHANGELOG.md](CHANGELOG.md)，安全问题报告方式见 [SECURITY.md](SECURITY.md)。