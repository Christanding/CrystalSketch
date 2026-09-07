# CrystalSketch

CrystalSketch 是一款在浏览器中使用的晶体结构可视化与制图工具。打开 POSCAR、CONTCAR 或 CIF 等结构文件后，即可查看三维结构、调整配色和材质、测量原子间的距离与夹角，并导出用于论文、报告或演示的结构图。

**[直接在线使用 CrystalSketch](https://christanding.github.io/CrystalSketch/)**，无需安装。

- **美观**：内置多套元素配色和材质，支持调节光照，展示原子、化学键、配位多面体与晶轴。
- **易用**：在浏览器中完成结构加载、预览与图片导出，支持多文件切换和双视图对比。
- **可靠**：保留原始结构文件不变；POSCAR / CONTCAR 可在浏览器中解析，其他格式读取与对称性分析由 pymatgen 支持。
- **高效**：针对多原子结构优化显示与交互，实际流畅度取决于结构复杂度和设备配置。
- **灵活**：颜色、半径、材质、透明度、视角和导出参数均可调整，支持 PNG、JPG 和 PDF 图片导出，也可创建模型副本进行编辑并导出 POSCAR。

## 在线使用

打开 [网页版](https://christanding.github.io/CrystalSketch/)，点击“打开”选择结构文件，即可开始使用。

三维显示与图片导出在浏览器中完成。在线版的 CIF 等非 VASP 文件解析，以及对称性分析，会将结构内容发送到云端服务；如需完全在本机处理，请使用下方的本地安装版。

## 本地安装

支持 macOS、Windows 和 Linux，使用支持 WebGL 的现代浏览器。

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

1. 点击“打开”，选择晶体结构文件。
2. 旋转、缩放结构，按需要调整配色、材质、光照和显示内容。
3. 在“导出”中设置图片参数并保存；如需修改结构，先在“建模”中创建模型副本，完成修改后再导出 POSCAR。

使用期间保持启动终端运行。结束后，在该终端按 `Ctrl+C` 停止程序；下次使用只需再次执行启动命令，无需重新安装。

## 卸载

先在运行 CrystalSketch 的终端按 `Ctrl+C` 停止程序，再使用安装时的系统账号在终端执行：

```sh
uv tool uninstall crystalsketch
```

## 常见问题

### Windows 提示无法识别 Crystal

如果已经安装 CrystalSketch，但输入 `Crystal` 时提示“无法识别”或“不是内部或外部命令”，可能是命令目录尚未加入 PATH，或当前终端尚未刷新环境变量。

新版安装器已自动处理持久化 PATH。旧版用户可以下载最新压缩包并重新运行安装器，或在解压后的文件夹中仅修复命令路径，不重新安装程序：

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1 -RepairPath
```

在 **PowerShell** 中完整复制并执行一次以下持久化修复命令：

```powershell
& {
    $ErrorActionPreference = 'Stop'
    $crystalBin = (uv tool dir --bin).Trim()

    if (-not (Test-Path -LiteralPath (Join-Path $crystalBin 'Crystal.exe'))) {
        throw '没有找到 Crystal.exe，请先确认 CrystalSketch 已安装。'
    }

    $userPaths = @(
        [Environment]::GetEnvironmentVariable('Path', 'User') -split ';' |
        Where-Object { $_ }
    )

    if ($userPaths -notcontains $crystalBin) {
        $userPaths = @($crystalBin) + $userPaths
    }

    [Environment]::SetEnvironmentVariable('Path', ($userPaths -join ';'), 'User')
    $env:Path = "$crystalBin;$env:Path"

    Crystal
}
```

这段命令会自动读取本机的命令目录，将其持久保存到当前用户的 PATH，同时刷新当前窗口并启动 CrystalSketch。它会保留已有的用户 PATH 条目，无需管理员权限，也无需手动填写用户名、盘符或安装路径。

修复后，日常直接输入 `Crystal` 即可，不需要每次重新执行修复。如果终端仍沿用旧环境，请完全退出 Windows Terminal 后重新打开，而不只是新建标签页；仍未刷新时，可注销并重新登录 Windows 一次。

此命令用于修复已安装程序的命令路径，不能替代安装。如果 `uv` 也无法识别，或 `uv tool list` 中没有 `crystalsketch`，请先按上面的安装步骤完成安装。

### Windows 提示无法识别 uv

先完全关闭终端程序并重新打开，再输入 `uv --version` 检查。如果尚未安装 uv，可在 PowerShell 中选择以下任意一种方式安装，**不需要两种都执行**。

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

## 许可证

本项目采用 [MIT 许可证](LICENSE)。
