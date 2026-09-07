$ErrorActionPreference = 'Stop'
$crystalWheels = @(Get-ChildItem -LiteralPath $PSScriptRoot -Filter 'crystalsketch-*.whl' -File)
$crystalRoot = Split-Path -Parent $PSScriptRoot
if ($crystalWheels.Count -eq 0 -and -not (Test-Path (Join-Path $crystalRoot 'pyproject.toml'))) {
    throw 'Extract the complete installer or run this script from the CrystalSketch repository.'
}

$crystalUvCommand = Get-Command uv -ErrorAction SilentlyContinue
if ($crystalUvCommand) {
    $crystalUv = $crystalUvCommand.Source
} else {
    $crystalUv = Join-Path $env:USERPROFILE '.local\bin\uv.exe'
    if (-not (Test-Path -LiteralPath $crystalUv)) {
        Write-Host 'Preparing the installer...'
        # Official standalone installer; does not require an existing Python.
        Invoke-RestMethod https://astral.sh/uv/install.ps1 | Invoke-Expression
        $crystalUvCommand = Get-Command uv -ErrorAction SilentlyContinue
        if ($crystalUvCommand) { $crystalUv = $crystalUvCommand.Source }
        if (-not (Test-Path -LiteralPath $crystalUv)) {
            throw 'uv installation failed. Check the installer output above.'
        }
    }
}

$env:PATH = "$(Split-Path -Parent $crystalUv);$env:PATH"
if ($crystalWheels.Count -eq 0) {
    Write-Host 'Installing CrystalSketch from source...'
    if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
        $crystalBunRoot = if ($env:BUN_INSTALL) { $env:BUN_INSTALL } else { Join-Path $env:USERPROFILE '.bun' }
        $crystalBunDir = Join-Path $crystalBunRoot 'bin'
        if (-not (Test-Path (Join-Path $crystalBunDir 'bun.exe'))) {
            & ([scriptblock]::Create((Invoke-RestMethod https://bun.com/install.ps1))) -Version '1.3.13'
        }
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
& $crystalUv tool update-shell
if ($LASTEXITCODE -ne 0) { throw 'Could not configure the command search path.' }
Write-Host 'Installed. Open a new terminal and type Crystal to launch the app in your browser.'
