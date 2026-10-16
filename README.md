# CrystalSketch

CrystalSketch 是一款在浏览器中使用的晶体结构可视化与制图工具。打开 POSCAR、CONTCAR 或 CIF 等结构文件后，即可查看三维结构、调整配色和材质、测量原子间的距离与夹角，并导出用于论文、报告或演示的结构图。

**[直接在线使用 CrystalSketch](https://christanding.github.io/CrystalSketch/)**，无需安装。

- **美观**：内置多套元素配色和材质，支持调节光照，展示原子、化学键、配位多面体与晶轴。
- **易用**：在浏览器中完成结构加载、预览与图片导出，支持多文件切换和双视图对比。
- **可靠**：保留原始结构文件不变；POSCAR / CONTCAR 可在浏览器中解析，其他格式读取与对称性分析由 pymatgen 支持。
- **高效**：针对多原子结构优化显示与交互，实际流畅度取决于结构复杂度和设备配置。
- **灵活**：颜色、半径、材质、透明度、视角和导出参数均可调整，支持 PNG、JPG 和 PDF 图片导出，也可创建模型副本进行编辑并导出 POSCAR。

如需完全在本机处理，请使用下方的本地安装版。

## 本地安装

支持 macOS、Windows 和 Linux，使用支持 WebGL 的现代浏览器。

### 联网一键安装

无需预装 Python、uv、Git 或 Bun。引导脚本会下载官方预构建安装包，检查后调用原安装器；缺少的 uv、Python 3.12 和程序依赖会自动准备。安装位置和后面的 `Crystal` 启动方式不变，不需要管理员权限。

macOS / Linux，在终端粘贴一行：

```sh
bash -o pipefail -c 'curl -fsSL https://raw.githubusercontent.com/Christanding/CrystalSketch/main/scripts/bootstrap.sh | bash'
```

Windows，在系统自带的 PowerShell 中粘贴一行：

```powershell
& ([scriptblock]::Create((Invoke-RestMethod 'https://raw.githubusercontent.com/Christanding/CrystalSketch/main/scripts/bootstrap.ps1')))
```

安装完成后重新打开终端，输入 `Crystal`。


### 下载压缩包

前往 [GitHub Releases](https://github.com/Christanding/CrystalSketch/releases/latest)，在 **Assets** 中下载 **CrystalSketch.zip**，或[直接下载最新安装包](https://github.com/Christanding/CrystalSketch/releases/latest/download/CrystalSketch.zip)。不要将 GitHub 自动生成的 `Source code (zip)` 当作安装包。

解压后，在 `CrystalSketch` 文件夹中打开终端，按系统执行一条安装命令。

macOS / Linux：

```sh
bash install.sh
```

Windows（PowerShell）：

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

首次安装需要联网，安装程序会自动准备 Python 和所需依赖，无需手动安装开发工具或编译项目。安装完成后重新打开终端即可使用，不需要保留源码文件夹。

Windows 安装器会自动将 `Crystal` 的命令目录保存到用户 PATH，并在新 PowerShell 进程中验证。安装后请完全退出 Windows Terminal 再重新打开一次；之后直接输入 `Crystal` 即可，不需要反复修复。

### 从 GitHub 仓库安装（推荐）

Windows 如果尚未安装 Git，先执行：

```powershell
winget install --id Git.Git -e --source winget
```

安装完成后重新打开终端，再执行下面的安装命令。

已安装 Git 时，也可以用一条命令拉取仓库并安装。

macOS / Linux：

```sh
git clone https://github.com/Christanding/CrystalSketch.git && cd CrystalSketch && bash scripts/install.sh
```

Windows（PowerShell）：

```powershell
git clone https://github.com/Christanding/CrystalSketch.git; if ($LASTEXITCODE -eq 0) { Set-Location CrystalSketch; powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1 }
```

脚本会自动准备所需工具、构建并安装当前仓库版本，不需要分别运行网页与后台服务。安装完成后重新打开终端即可。

## 启动与使用

直接打开终端，输入以下命令即可，无需进入项目文件夹：

```sh
Crystal
```

浏览器会自动打开 CrystalSketch。如果没有自动打开，点击终端显示的本地网址即可，无需指定端口或另开服务。

同一系统用户的正式安装只运行一个服务。重复执行 `Crystal` 会打开已有服务并退出本次启动，不再另起端口；显式指定其他端口也不会建立第二个正式实例。异常退出后再次运行可自动恢复。首次从旧版升级时，如果旧终端仍在运行，请先在旧终端按 `Ctrl+C` 退出一次。

1. 点击“打开”，选择晶体结构文件。
2. 旋转、缩放结构，按需要调整配色、材质、光照和显示内容。
3. 在“导出”中设置图片参数并保存；如需修改结构，先在“建模”中创建模型副本，完成修改后再导出 POSCAR。

使用期间保持启动终端运行。结束后，在该终端按 `Ctrl+C` 停止程序；下次使用只需再次执行启动命令，无需重新安装。

## 检查与安装更新

本地版在“设置”中点击一次“检查更新”即可查询官方发布。对于通过安装器管理的 `uv tool` 安装，发现新版本后会自动保存当前工作区、下载并校验官方安装包、备份现有工具环境，然后覆盖安装并在原端口重启，无需再次确认。保存和安装期间暂时锁定编辑；保存失败不会开始安装。只有新服务通过健康和版本检查后才刷新页面；安装或启动失败时尝试恢复上一份安装。

更新只修改当前 CrystalSketch 工具环境与入口，不修改原始结构文件或其他工具。更新过程中请等待状态提示，不要关闭计算机。源码开发、非受控服务、旧版多实例占用和在线版不支持页面内覆盖安装；在线版由站点发布更新，源码版按开发流程更新。开发服务不参与正式安装的单实例管理，回退备份、源码目录和下载的安装包也不会被当作多余版本删除。

## 卸载

先导出需要保留的结构和图片，等待正在进行的更新结束，再在运行 CrystalSketch 的终端按 `Ctrl+C` 停止程序并关闭它的浏览器标签页。使用安装时的系统账号执行下面一种卸载方式；**不要在更新过程中卸载**。

### 只卸载程序，保留使用记录

```sh
uv tool uninstall crystalsketch
```

该命令移除 CrystalSketch 专属工具目录（包含其私有依赖副本）及 `Crystal` 启动命令，保留程序缓存和浏览器工作区。

### 完整卸载本地程序与缓存

下面每个代码块都是一条可整段粘贴执行的命令：先卸载程序，成功后再将 CrystalSketch 自身的更新下载、日志、回退备份和运行状态目录移入回收站／废纸篓。缓存不存在时跳过；卸载失败时不清理缓存。

Windows，在 PowerShell 中执行（使用系统[回收站接口](https://learn.microsoft.com/en-us/dotnet/api/microsoft.visualbasic.fileio.filesystem.deletedirectory)）：

```powershell
& {
    $ErrorActionPreference = 'Stop'
    if (-not $env:LOCALAPPDATA -or -not [IO.Path]::IsPathRooted($env:LOCALAPPDATA)) { throw 'LOCALAPPDATA must be an absolute path.' }
    $crystalCache = Join-Path $env:LOCALAPPDATA 'CrystalSketch'
    if ((Test-Path -LiteralPath $crystalCache) -and ((Get-Item -LiteralPath $crystalCache -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Cache is a link; inspect it before removing it.' }
    uv tool uninstall crystalsketch
    if ($LASTEXITCODE -ne 0) { throw 'Uninstall failed; cache was not removed.' }
    if (Test-Path -LiteralPath $crystalCache) {
        Add-Type -AssemblyName Microsoft.VisualBasic
        [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($crystalCache, 'OnlyErrorDialogs', 'SendToRecycleBin')
    }
}
```

macOS，在终端执行：

```sh
bash -c 'set -e; uv tool uninstall crystalsketch; crystal_cache="${HOME:?}/Library/Caches/CrystalSketch"; if [ -e "$crystal_cache" ] || [ -L "$crystal_cache" ]; then crystal_trash="$(mktemp -d "${HOME:?}/.Trash/CrystalSketch-cache.XXXXXXXX")"; mv "$crystal_cache" "$crystal_trash/CrystalSketch"; fi'
```

Linux 桌面环境提供 `gio` 时，在终端执行：

```sh
bash -c 'set -e; command -v gio >/dev/null || { printf "%s\n" "gio is required to move the cache to Trash; no changes made." >&2; exit 1; }; crystal_cache="${XDG_CACHE_HOME:-${HOME:?}/.cache}/CrystalSketch"; case "$crystal_cache" in /*) ;; *) printf "%s\n" "XDG_CACHE_HOME must be an absolute path." >&2; exit 1;; esac; uv tool uninstall crystalsketch; if [ -e "$crystal_cache" ] || [ -L "$crystal_cache" ]; then gio trash "$crystal_cache"; fi'
```


## 常见问题

### Windows 提示无法识别 Crystal

新版安装器会自动保存并验证 `Crystal` 的用户 PATH。安装完成后，只需完全退出 Windows Terminal 再重新打开一次；不需要每次手动修复，也不需要管理员权限。

如果旧版安装仍提示“无法识别”或“不是内部或外部命令”，下载最新的 **CrystalSketch.zip** 并完整解压。在解压后的文件夹中运行以下命令，只修复已有安装的命令路径，不重新安装：

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1 -RepairPath
```

修复后完全退出终端程序再重开，而不只是新建标签页。如果提示没有找到 `Crystal.exe`，说明尚未完成安装，请按上面的两种安装方式之一安装；`-RepairPath` 不能代替安装。

### Windows 提示无法识别 uv

正常安装 CrystalSketch 时无需先手动安装 uv：两种安装方式都会自动准备它。安装器也能识别通过 `UV_INSTALL_DIR` 或 `UV_UNMANAGED_INSTALL` 指定的目录，无需自行拼接用户名和路径。

如果是在单独运行 `uv`（例如卸载时）提示无法识别，先完全关闭终端程序并重新打开，再输入 `uv --version` 检查。确实尚未安装 uv 时，可在 PowerShell 中选择以下任意一种方式安装，**不需要两种都执行**。

方式一：使用 WinGet：

```powershell
winget install --id astral-sh.uv -e --source winget
```

方式二：如果无法识别 `winget`，使用官方安装脚本：

```powershell
powershell -ExecutionPolicy Bypass -Command "irm https://astral.sh/uv/install.ps1 | iex"
```

安装完成后，完全关闭终端程序并重新打开，再执行：

```powershell
uv --version
```

显示版本号即表示安装成功。

### 覆盖解压新安装包后仍装到旧版

从 v0.2.2 起，Windows 与 macOS/Linux 安装器都会按修改时间选择目录中最新的 wheel，避免解压目录残留旧包时误选。升级时使用新压缩包内的安装脚本和 wheel，不要混用旧脚本；在新文件夹中完整解压也可避免混淆。

### Windows 从源码安装时，准备 Bun 后提示找不到 uv

新版安装器让 Bun 引导过程保留当前进程的 PATH，再添加 Bun 所在目录，避免覆盖原来的 Python、uv 和系统工具路径。若使用旧脚本遇到此问题，更新仓库或重新下载完整安装包后，仍按原来的安装命令执行，无需手工改系统 PATH。

## 许可证

本项目采用 [MIT 许可证](LICENSE)。
