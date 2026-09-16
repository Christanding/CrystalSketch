param([switch]$RepairPath)

$ErrorActionPreference = 'Stop'

function Set-CrystalCommandPath {
    param([string]$UvExecutable)

    $crystalBinOutput = & $UvExecutable --color never tool dir --bin
    if ($LASTEXITCODE -ne 0 -or -not $crystalBinOutput) {
        throw 'Could not locate the installed command directory.'
    }
    $crystalBin = $crystalBinOutput.Trim()
    $crystalExe = Join-Path $crystalBin 'Crystal.exe'
    if (-not (Test-Path -LiteralPath $crystalExe -PathType Leaf)) {
        throw 'Crystal.exe was not installed. Check the installation output above.'
    }

    # Never persist the process PATH: it also contains machine and session-only entries.
    $userPaths = @(
        [Environment]::GetEnvironmentVariable('Path', 'User') -split ';' |
        Where-Object { $_ }
    )
    if ($userPaths -notcontains $crystalBin) {
        $userPaths = @($crystalBin) + $userPaths
    }
    # The User overload also notifies Windows of the environment change.
    [Environment]::SetEnvironmentVariable('Path', ($userPaths -join ';'), 'User')
    if (([Environment]::GetEnvironmentVariable('Path', 'User') -split ';') -notcontains $crystalBin) {
        throw 'The command directory could not be saved to your user PATH.'
    }
    if (($env:Path -split ';') -notcontains $crystalBin) {
        $env:Path = "$crystalBin;$env:Path"
    }

    # A new shell must find Crystal from persisted PATH, without this installer's additions.
    $previousExpectedCommand = $env:CRYSTALSKETCH_EXPECTED_COMMAND
    $env:CRYSTALSKETCH_EXPECTED_COMMAND = $crystalExe
    try {
        $probe = @'
$ErrorActionPreference = 'Stop'
$env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
$command = Get-Command Crystal -CommandType Application -ErrorAction Stop
if ($command.Source -ne $env:CRYSTALSKETCH_EXPECTED_COMMAND) { throw 'Crystal resolves to a different installation.' }
& $command.Source --version
exit $LASTEXITCODE
'@
        & (Get-Process -Id $PID).Path -NoLogo -NoProfile -NonInteractive -Command $probe
        if ($LASTEXITCODE -ne 0) { throw 'Crystal could not start using the saved user PATH.' }
    } finally {
        $env:CRYSTALSKETCH_EXPECTED_COMMAND = $previousExpectedCommand
    }
    Write-Host 'User PATH saved and verified in a new PowerShell process.'
    Write-Host 'Completely exit Windows Terminal (not just this tab), then reopen it and type Crystal.'
}

$crystalWheels = @(Get-ChildItem -LiteralPath $PSScriptRoot -Filter 'crystalsketch-*.whl' -File | Sort-Object LastWriteTime -Descending)
$crystalRoot = Split-Path -Parent $PSScriptRoot
if (-not $RepairPath -and $crystalWheels.Count -eq 0 -and -not (Test-Path (Join-Path $crystalRoot 'pyproject.toml'))) {
    throw 'Extract the complete installer or run this script from the CrystalSketch repository.'
}

$crystalUvCommand = Get-Command uv -CommandType Application -ErrorAction SilentlyContinue
if ($crystalUvCommand) {
    $crystalUv = $crystalUvCommand.Source
} else {
    $crystalUvDir = if ($env:UV_INSTALL_DIR) { $env:UV_INSTALL_DIR }
        elseif ($env:UV_UNMANAGED_INSTALL) { $env:UV_UNMANAGED_INSTALL }
        else { Join-Path $env:USERPROFILE '.local\bin' }
    $crystalUv = Join-Path $crystalUvDir 'uv.exe'
    if (-not (Test-Path -LiteralPath $crystalUv -PathType Leaf)) {
        Write-Host 'Preparing the installer...'
        # Official standalone installer; does not require an existing Python.
        Invoke-RestMethod https://astral.sh/uv/install.ps1 | Invoke-Expression
        $crystalUvCommand = Get-Command uv -CommandType Application -ErrorAction SilentlyContinue
        if ($crystalUvCommand) { $crystalUv = $crystalUvCommand.Source }
        if (-not (Test-Path -LiteralPath $crystalUv -PathType Leaf)) {
            throw 'uv installation failed. Check the installer output above.'
        }
    }
}

$env:PATH = "$(Split-Path -Parent $crystalUv);$env:PATH"
if ($RepairPath) {
    Set-CrystalCommandPath -UvExecutable $crystalUv
    return
}
if ($crystalWheels.Count -eq 0) {
    Write-Host 'Installing CrystalSketch from source...'
    if (-not (Get-Command bun -CommandType Application -ErrorAction SilentlyContinue)) {
        $crystalBunRoot = if ($env:BUN_INSTALL) { $env:BUN_INSTALL } else { Join-Path $env:USERPROFILE '.bun' }
        $crystalBunDir = Join-Path $crystalBunRoot 'bin'
        $crystalBun = Join-Path $crystalBunDir 'bun.exe'
        if (-not (Test-Path -LiteralPath $crystalBun -PathType Leaf)) {
            & ([scriptblock]::Create((Invoke-RestMethod https://bun.com/install.ps1))) -Version '1.3.13' -NoPathUpdate
        }
        if (-not (Test-Path -LiteralPath $crystalBun -PathType Leaf)) { throw 'Bun installation failed. Check the installer output above.' }
        $env:PATH = "$crystalBunDir;$env:PATH"
    }
    Push-Location $crystalRoot
    try {
        & $crystalUv run --python 3.12 --locked python scripts/build_release.py
        if ($LASTEXITCODE -ne 0) { throw 'CrystalSketch build failed.' }
    } finally { Pop-Location }
    $crystalWheels = @(Get-ChildItem -LiteralPath (Join-Path $crystalRoot 'dist') -Filter 'crystalsketch-*.whl' -File | Sort-Object LastWriteTime -Descending)
}
if ($crystalWheels.Count -eq 0) { throw 'The build did not produce an installation file.' }

& $crystalUv tool install --python 3.12 --reinstall-package crystalsketch $crystalWheels[0].FullName
if ($LASTEXITCODE -ne 0) { throw 'CrystalSketch installation failed.' }
Set-CrystalCommandPath -UvExecutable $crystalUv
