# CrystalSketch

CrystalSketch 用来查看晶体结构、调整结构图，并导出用于论文、报告或演示的图片。支持打开 POSCAR、CONTCAR 和 CIF，导出 PNG、JPG 和 PDF。

[在线试用，无需安装](https://christanding.github.io/CrystalSketch/)。如果希望文件在自己的电脑上处理，可以按下面的步骤安装本地版。本地版也在浏览器中操作。

## 安装到电脑

推荐使用一键安装，按自己的系统选择一条命令即可。首次安装需要联网，**不用提前安装 Python、uv、Git 或 Bun，也不需要管理员权限**。

### Windows

打开 PowerShell，复制下面整行命令，粘贴后按回车：

```powershell
& ([scriptblock]::Create((Invoke-RestMethod 'https://raw.githubusercontent.com/Christanding/CrystalSketch/main/scripts/bootstrap.ps1')))
```

### macOS / Linux

打开终端，复制下面整行命令，粘贴后按回车：

```sh
bash -o pipefail -c 'curl -fsSL https://raw.githubusercontent.com/Christanding/CrystalSketch/main/scripts/bootstrap.sh | bash'
```

安装命令会下载已发布的安装包，并自动准备 Python 3.12 等运行组件。等待安装结束后，继续下面的启动步骤。下载需要能访问 GitHub 和依赖下载站点。

## 启动并开始画图

安装完成后，**完全关闭终端，再重新打开**。Windows Terminal 也要关闭整个程序，不能只新建标签页。

输入：

```sh
Crystal
```

浏览器会自动打开 CrystalSketch；如果没有打开，点击终端里显示的本地网址即可。以后每次使用都输入 `Crystal`，不需要重新安装，也不需要进入安装目录。

1. 点击“打开”，选择晶体结构文件。
2. 旋转、缩放结构，调整原子颜色、材质、光照、透明度和显示内容。
3. 如需测量，添加原子间的距离或夹角标注。
4. 在“导出”中选择图片格式和参数，保存图片。

使用期间保持启动终端打开。结束后，在该终端按 `Ctrl+C` 停止程序。

### 还可以做什么

- 调整原子半径、键和线条的显示，查看配位多面体与晶轴。
- 使用内置配色、材质和光照，调整图片效果。
- 同时打开多个文件，在文件之间切换，或用双视图对比。
- 在“建模”中创建副本、编辑结构，再导出 POSCAR；原始文件保持不变。

界面需要支持 WebGL 的现代浏览器。程序针对多原子结构做了显示优化，实际流畅度仍取决于结构大小和电脑配置。

## 更新

在本地版的“设置”中点击一次“检查更新”。发现新版本后，程序会保存当前工作区，下载并覆盖安装新版，然后自动重启、刷新页面，不需要再执行安装命令。

如果提示另一个旧版程序仍在运行，请先在旧终端按 `Ctrl+C` 退出，再重试。更新前的备份、下载的安装包和源码目录不会被自动删除。

## 卸载

先导出需要保留的结构和图片，在启动终端按 `Ctrl+C` 停止程序，再关闭它的浏览器标签页。使用安装时的系统账号卸载，**不要在更新过程中卸载**。

通常只需在终端执行这一条命令：

```sh
uv tool uninstall crystalsketch
```

它会移除 CrystalSketch 和 `Crystal` 启动命令，保留程序缓存。Python、uv、Git、Bun、其他项目的环境，以及你的结构文件和导出图片都不会因此被删除。

<details>
<summary>完整卸载本地程序，同时清理缓存和更新备份</summary>

按自己的系统复制下面整块命令，一次粘贴执行。卸载成功后，命令会把程序的更新下载、日志、回退备份和运行记录移入回收站或废纸篓；卸载失败时不会清理这些文件。

Windows（PowerShell，使用系统[回收站接口](https://learn.microsoft.com/en-us/dotnet/api/microsoft.visualbasic.fileio.filesystem.deletedirectory)）：

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

macOS：

```sh
bash -c 'set -e; uv tool uninstall crystalsketch; crystal_cache="${HOME:?}/Library/Caches/CrystalSketch"; if [ -e "$crystal_cache" ] || [ -L "$crystal_cache" ]; then crystal_trash="$(mktemp -d "${HOME:?}/.Trash/CrystalSketch-cache.XXXXXXXX")"; mv "$crystal_cache" "$crystal_trash/CrystalSketch"; fi'
```

Linux（桌面环境需要提供 `gio` 命令）：

```sh
bash -c 'set -e; command -v gio >/dev/null || { printf "%s\n" "gio is required to move the cache to Trash; no changes made." >&2; exit 1; }; crystal_cache="${XDG_CACHE_HOME:-${HOME:?}/.cache}/CrystalSketch"; case "$crystal_cache" in /*) ;; *) printf "%s\n" "XDG_CACHE_HOME must be an absolute path." >&2; exit 1;; esac; uv tool uninstall crystalsketch; if [ -e "$crystal_cache" ] || [ -L "$crystal_cache" ]; then gio trash "$crystal_cache"; fi'
```

缓存不存在时会跳过清理。如果提示回收站权限不足，程序可能已经卸载，但缓存还在原处，请按错误提示处理。Linux 没有 `gio` 时，仍可执行上面的普通卸载命令。

</details>

这两种卸载都不会清除浏览器里保存的工作区和设置。如需清理浏览器数据，请先导出尚未保存到磁盘的内容。

## 其他安装方式

一键安装之外，也可以下载安装包，或从仓库源码安装。选一种即可。

<details>
<summary>下载安装包，再运行安装命令</summary>

前往 [GitHub Releases](https://github.com/Christanding/CrystalSketch/releases/latest)，在 **Assets** 中下载 **CrystalSketch.zip**，或[直接下载最新安装包](https://github.com/Christanding/CrystalSketch/releases/latest/download/CrystalSketch.zip)。不要下载旁边的 `Source code (zip)`，它不是安装包。

先完整解压，再在解压得到的 `CrystalSketch` 文件夹中打开终端，按系统执行：

macOS / Linux：

```sh
bash install.sh
```

Windows（PowerShell）：

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

安装时仍需联网。脚本会准备 Python 和所需组件，你不需要手动编译。完成后关闭并重新打开终端，输入 `Crystal`。

</details>

<details>
<summary>从源码安装：需要 Git，适合安装仓库中的代码</summary>

这种方式会下载并构建仓库中的代码。只想使用已发布版本时，选择前面的一键安装即可。

Windows 如果还没有 Git，先执行：

```powershell
winget install --id Git.Git -e --source winget
```

装好 Git 后，关闭并重新打开终端。已有 Git 的电脑可以直接执行下面的安装命令。

macOS / Linux：

```sh
git clone https://github.com/Christanding/CrystalSketch.git && cd CrystalSketch && bash scripts/install.sh
```

Windows（PowerShell）：

```powershell
git clone https://github.com/Christanding/CrystalSketch.git; if ($LASTEXITCODE -eq 0) { Set-Location CrystalSketch; powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1 }
```

脚本会准备构建工具并安装程序，不需要你分别启动网页和后台。安装完成后输入 `Crystal` 即可，运行程序不再依赖源码文件夹。

</details>

## 常见问题

<details>
<summary>Windows 提示找不到 Crystal</summary>

先完全退出 Windows Terminal，再重新打开；只关一个标签页可能不够。安装器会保存并验证命令路径，正常安装后不需要反复修复。

如果仍找不到命令，下载并完整解压最新的 `CrystalSketch.zip`，在解压后的文件夹中运行下面的命令。它只修复已有安装的启动路径，不会重新安装程序，也不需要管理员权限：

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1 -RepairPath
```

修复后再完全退出并重开终端。如果提示 `Crystal.exe` 没有安装，请回到前面的一键安装步骤；修复路径不能代替安装。

</details>

<details>
<summary>卸载时提示找不到 uv</summary>

`uv` 是安装器自动准备的工具，也用于卸载 CrystalSketch。先关闭并重新打开终端，再输入 `uv --version` 检查。

如果确认没有安装 uv，在 Windows PowerShell 里选择下面任意一种方式安装，不要两种都执行。

有 WinGet 时：

```powershell
winget install --id astral-sh.uv -e --source winget
```

如果连 `winget` 也找不到，使用 uv 官方安装脚本：

```powershell
powershell -ExecutionPolicy Bypass -Command "irm https://astral.sh/uv/install.ps1 | iex"
```

完成后重开终端，执行：

```powershell
uv --version
```

看到版本号后，再执行卸载命令。如果你设置过自定义安装目录，安装器支持 `UV_INSTALL_DIR` 和 `UV_UNMANAGED_INSTALL`，无需手动拼接用户名。

</details>

<details>
<summary>多次输入 Crystal，会打开多个程序吗？</summary>

同一系统账号的正常安装只运行一个程序。再次输入 `Crystal` 会打开已有程序的页面，不会另起一个后台；手动指定其他端口也不会多开。异常退出后，可以重新运行 `Crystal`。

从旧版本升级后，如果提示旧程序仍在运行，先在原来的终端按 `Ctrl+C` 退出一次。直接运行源码进行开发调试的服务不受上述限制。

</details>

<details>
<summary>解压新安装包后，装上的还是旧版</summary>

把新安装包完整解压到一个新文件夹，再运行其中的安装脚本，不要把新旧文件混用。

从 v0.2.2 起，安装器会按修改时间选择最新的 `.whl` 安装文件。保留旧脚本、只替换部分文件，仍可能导致装错版本。

</details>

<details>
<summary>Windows 从源码安装，准备 Bun 后提示找不到 uv</summary>

旧安装脚本可能在准备 Bun 时覆盖命令搜索路径，导致已经安装的 uv 暂时找不到。当前脚本会保留原有路径，再加入 Bun 的目录。

更新仓库，或下载并完整解压新的安装包，然后按原命令安装即可，不需要手动修改系统 PATH。

</details>

## 许可证

本项目采用 [MIT 许可证](LICENSE)。
