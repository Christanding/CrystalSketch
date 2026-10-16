param([string]$BootstrapPath = (Join-Path (Split-Path -Parent $PSScriptRoot) 'scripts/bootstrap.ps1'))

# Run with Windows PowerShell 5.1; no downloads, dependencies, or user PATH writes.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
$source = [IO.File]::ReadAllText($BootstrapPath)
$tokens = $null
$parseErrors = $null
$syntax = [Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -ne 0) { throw ($parseErrors | Out-String) }

# Replace only network I/O. All archive checks, extraction, child-process invocation,
# error handling, and cleanup below run the production code as a remote scriptblock.
$downloadFunction = @($syntax.FindAll({
    param($node)
    $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-CrystalReleaseArchive'
}, $true))
if ($downloadFunction.Count -ne 1) { throw 'Could not identify the download seam.' }
$downloadMock = @'
function Get-CrystalReleaseArchive {
    param([string]$Destination, [long]$MaximumBytes)
    $caseState.TemporaryDirectory = Split-Path -Parent $Destination
    if ($caseState.DownloadFailure) {
        [IO.File]::WriteAllText($Destination, 'partial download')
        throw 'fixture download failure'
    }
    if ($caseState.OversizedDownload) {
        $stream = [IO.File]::Create($Destination)
        try { $stream.SetLength($MaximumBytes + 1) } finally { $stream.Dispose() }
        return
    }
    [IO.File]::Copy($caseState.Fixture, $Destination, $false)
}
'@
$extent = $downloadFunction[0].Extent
$instrumentedSource = $source.Remove($extent.StartOffset, $extent.EndOffset - $extent.StartOffset).Insert($extent.StartOffset, $downloadMock)
$bootstrap = [ScriptBlock]::Create($instrumentedSource)

# This harmless bundled installer stands in for uv/Python/application installation.
# Keeping the real child-process call tests -File quoting, PSScriptRoot, and exits.
$fixtureInstaller = @'
$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'crystalsketch-0.0.0-py3-none-any.whl'))) {
    throw 'The fixture installer did not receive its complete extracted bundle.'
}
[IO.File]::WriteAllText($env:CRYSTALSKETCH_BOOTSTRAP_TEST_MARKER, "$PSScriptRoot`n$PSCommandPath")
$env:Path = 'child-process-only'
Set-Location -LiteralPath $PSScriptRoot
exit ([int]$env:CRYSTALSKETCH_BOOTSTRAP_TEST_EXIT)
'@
$validEntries = @(
    @{ Name = 'CrystalSketch/crystalsketch-0.0.0-py3-none-any.whl'; Text = 'fixture wheel' },
    @{ Name = 'CrystalSketch/install.ps1'; Text = $fixtureInstaller },
    @{ Name = 'CrystalSketch/install.sh'; Text = '# fixture shell installer' }
)

function New-FixtureArchive {
    param([string]$Path, [object[]]$Entries)

    $stream = [IO.File]::Create($Path)
    $zip = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Create, $false)
    try {
        foreach ($spec in $Entries) {
            $entry = $zip.CreateEntry($spec.Name, [IO.Compression.CompressionLevel]::Optimal)
            if ($spec.ContainsKey('Attributes')) { $entry.ExternalAttributes = $spec.Attributes }
            $output = $entry.Open()
            try {
                if ($spec.ContainsKey('ByteCount')) {
                    $buffer = New-Object byte[] 65536
                    $remaining = [long]$spec.ByteCount
                    while ($remaining -gt 0) {
                        $count = [int][Math]::Min($buffer.Length, $remaining)
                        $output.Write($buffer, 0, $count)
                        $remaining -= $count
                    }
                } else {
                    $bytes = [Text.Encoding]::UTF8.GetBytes([string]$spec.Text)
                    $output.Write($bytes, 0, $bytes.Length)
                }
            } finally { $output.Dispose() }
        }
    } finally {
        $zip.Dispose()
        $stream.Dispose()
    }
}

function Assert-BootstrapCase {
    param(
        [string]$Name,
        [string]$Fixture,
        [switch]$ExpectFailure,
        [switch]$DownloadFailure,
        [switch]$OversizedDownload,
        [int]$InstallerExit = 0,
        [string]$ExpectedMessage = ''
    )

    $marker = Join-Path $testRoot ($Name + '.marker')
    $env:CRYSTALSKETCH_BOOTSTRAP_TEST_MARKER = $marker
    $env:CRYSTALSKETCH_BOOTSTRAP_TEST_EXIT = [string]$InstallerExit
    $caseState = @{ Fixture = $Fixture; DownloadFailure = $DownloadFailure; OversizedDownload = $OversizedDownload; TemporaryDirectory = $null }
    $beforePath = $env:Path
    $beforeUserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $beforeLocation = (Get-Location).Path
    $beforePreference = $ErrorActionPreference
    $failure = $null
    try { & $bootstrap 6>$null } catch { $failure = $_ }
    if ($ExpectFailure -and -not $failure) { throw "$Name unexpectedly succeeded." }
    if (-not $ExpectFailure -and $failure) { throw "$Name failed: $failure" }
    if ($ExpectedMessage -and $failure.ToString() -notlike "*$ExpectedMessage*") {
        throw "$Name did not preserve the expected failure: $failure"
    }
    if (-not $caseState.TemporaryDirectory -or (Test-Path -LiteralPath $caseState.TemporaryDirectory)) {
        throw "$Name did not clean its temporary directory."
    }
    $shouldRunInstaller = -not $ExpectFailure -or $InstallerExit -ne 0
    if ((Test-Path -LiteralPath $marker) -ne $shouldRunInstaller) { throw "$Name invoked the installer at the wrong time." }
    if ($shouldRunInstaller) {
        $expectedDirectory = Join-Path $caseState.TemporaryDirectory 'CrystalSketch'
        $expectedInstaller = Join-Path $expectedDirectory 'install.ps1'
        if ([IO.File]::ReadAllText($marker) -cne "$expectedDirectory`n$expectedInstaller") {
            throw "$Name did not invoke the extracted installer by its real path."
        }
    }
    if ($env:Path -cne $beforePath -or [Environment]::GetEnvironmentVariable('Path', 'User') -cne $beforeUserPath) {
        throw "$Name changed the caller's process or user PATH."
    }
    if ((Get-Location).Path -cne $beforeLocation -or $ErrorActionPreference -cne $beforePreference) {
        throw "$Name changed the caller's location or error preference."
    }
    if ([IO.File]::ReadAllText($sentinel) -cne 'keep') { throw "$Name changed unrelated caller files." }
    Write-Host "PASS $Name"
}

$testRoot = $null
$savedEnvironment = @{}
$locationPushed = $false
try {
    $candidate = Join-Path ([IO.Path]::GetTempPath()) ("Crystal bootstrap test a'a " + [Guid]::NewGuid().ToString('N'))
    $testRoot = (New-Item -ItemType Directory -Path $candidate).FullName
    $temporaryRoot = Join-Path $testRoot "temporary a'a files"
    [void][IO.Directory]::CreateDirectory($temporaryRoot)
    foreach ($name in @('TEMP', 'TMP', 'TMPDIR', 'CRYSTALSKETCH_BOOTSTRAP_TEST_MARKER', 'CRYSTALSKETCH_BOOTSTRAP_TEST_EXIT')) {
        $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
    }
    foreach ($name in @('TEMP', 'TMP', 'TMPDIR')) { [Environment]::SetEnvironmentVariable($name, $temporaryRoot, 'Process') }
    Push-Location -LiteralPath $testRoot
    $locationPushed = $true
    $sentinel = Join-Path $testRoot 'unrelated.txt'
    [IO.File]::WriteAllText($sentinel, 'keep')

    & ([ScriptBlock]::Create($source)) -Help 6>$null
    $validZip = Join-Path $testRoot 'valid.zip'
    New-FixtureArchive -Path $validZip -Entries $validEntries
    Assert-BootstrapCase -Name 'valid-with-spaces-and-apostrophes' -Fixture $validZip
    Assert-BootstrapCase -Name 'installer-failure' -Fixture $validZip -ExpectFailure -InstallerExit 23 -ExpectedMessage 'exit code 23'
    Assert-BootstrapCase -Name 'download-failure' -ExpectFailure -DownloadFailure -ExpectedMessage 'fixture download failure'
    Assert-BootstrapCase -Name 'archive-size-limit' -ExpectFailure -OversizedDownload -ExpectedMessage '128 MiB'

    $malformedZip = Join-Path $testRoot 'malformed.zip'
    [IO.File]::WriteAllText($malformedZip, 'not a ZIP file')
    Assert-BootstrapCase -Name 'malformed-zip' -Fixture $malformedZip -ExpectFailure

    $rootZip = Join-Path $testRoot 'optional-root.zip'
    New-FixtureArchive -Path $rootZip -Entries (@(@{ Name = 'CrystalSketch/'; Text = '' }) + $validEntries)
    Assert-BootstrapCase -Name 'optional-root-directory' -Fixture $rootZip

    $invalidPaths = @(
        'CrystalSketch/../escaped.ps1', '/CrystalSketch/absolute.ps1', 'C:/CrystalSketch/drive.ps1',
        'CrystalSketch\backslash.ps1', 'CrystalSketch/C:drive.ps1', 'CrystalSketch/NUL.txt',
        'CrystalSketch/trailing.', 'CrystalSketch/subdir/nested.ps1'
    )
    for ($index = 0; $index -lt $invalidPaths.Count; $index++) {
        $fixture = Join-Path $testRoot "unsafe-$index.zip"
        New-FixtureArchive -Path $fixture -Entries ($validEntries + @(@{ Name = $invalidPaths[$index]; Text = 'unsafe' }))
        Assert-BootstrapCase -Name "unsafe-path-$index" -Fixture $fixture -ExpectFailure
    }
    foreach ($collision in @('install.ps1', 'INSTALL.PS1')) {
        $fixture = Join-Path $testRoot ("duplicate-" + $collision + '.zip')
        New-FixtureArchive -Path $fixture -Entries ($validEntries + @(@{ Name = "CrystalSketch/$collision"; Text = 'duplicate' }))
        Assert-BootstrapCase -Name ("duplicate-" + $collision) -Fixture $fixture -ExpectFailure -ExpectedMessage 'Duplicate'
    }

    $fixture = Join-Path $testRoot 'missing-wheel.zip'
    New-FixtureArchive -Path $fixture -Entries $validEntries[1..2]
    Assert-BootstrapCase -Name 'missing-wheel' -Fixture $fixture -ExpectFailure
    $fixture = Join-Path $testRoot 'multiple-wheels.zip'
    New-FixtureArchive -Path $fixture -Entries ($validEntries + @(@{ Name = 'CrystalSketch/crystalsketch-0.0.1-py3-none-any.whl'; Text = 'second wheel' }))
    Assert-BootstrapCase -Name 'multiple-wheels' -Fixture $fixture -ExpectFailure
    $fixture = Join-Path $testRoot 'unexpected-wheel.zip'
    New-FixtureArchive -Path $fixture -Entries ($validEntries + @(@{ Name = 'CrystalSketch/crystalsketch-invalid.whl'; Text = 'unexpected wheel' }))
    Assert-BootstrapCase -Name 'unexpected-wheel' -Fixture $fixture -ExpectFailure
    foreach ($missingIndex in @(1, 2)) {
        $fixture = Join-Path $testRoot "missing-installer-$missingIndex.zip"
        New-FixtureArchive -Path $fixture -Entries @($validEntries | Where-Object { $_.Name -cne $validEntries[$missingIndex].Name })
        Assert-BootstrapCase -Name "missing-installer-$missingIndex" -Fixture $fixture -ExpectFailure
    }
    $fixture = Join-Path $testRoot 'symlink.zip'
    New-FixtureArchive -Path $fixture -Entries ($validEntries + @(@{ Name = 'CrystalSketch/link'; Text = '../outside'; Attributes = (0xA000 -shl 16) }))
    Assert-BootstrapCase -Name 'symlink' -Fixture $fixture -ExpectFailure

    $manyEntries = @($validEntries)
    for ($index = 0; $index -lt 98; $index++) { $manyEntries += @{ Name = "CrystalSketch/file-$index.txt"; Text = '' } }
    $fixture = Join-Path $testRoot 'entry-limit.zip'
    New-FixtureArchive -Path $fixture -Entries $manyEntries
    Assert-BootstrapCase -Name 'entry-limit' -Fixture $fixture -ExpectFailure -ExpectedMessage '100 entries'
    $fixture = Join-Path $testRoot 'expanded-size-limit.zip'
    New-FixtureArchive -Path $fixture -Entries ($validEntries + @(@{ Name = 'CrystalSketch/large.txt'; ByteCount = 134217729 }))
    Assert-BootstrapCase -Name 'expanded-size-limit' -Fixture $fixture -ExpectFailure -ExpectedMessage '128 MiB'

    # Corrupt the first entry's deflate block; a valid directory must not hide bad data.
    $fixture = Join-Path $testRoot 'corrupt-deflate.zip'
    [IO.File]::Copy($validZip, $fixture)
    $stream = [IO.File]::Open($fixture, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite)
    $reader = [IO.BinaryReader]::new($stream)
    try {
        [void]$stream.Seek(26, [IO.SeekOrigin]::Begin)
        $nameLength = $reader.ReadUInt16()
        $extraLength = $reader.ReadUInt16()
        [void]$stream.Seek(30 + $nameLength + $extraLength, [IO.SeekOrigin]::Begin)
        $stream.WriteByte(7) # BTYPE=3 is invalid in deflate.
    } finally { $reader.Dispose(); $stream.Dispose() }
    Assert-BootstrapCase -Name 'corrupt-entry-data' -Fixture $fixture -ExpectFailure

    if (@(Get-ChildItem -LiteralPath $temporaryRoot -Force).Count -ne 0) { throw 'A scenario left bootstrap files behind.' }
    Write-Host 'All Windows bootstrap fixture tests passed.'
} finally {
    if ($locationPushed) { Pop-Location }
    foreach ($name in $savedEnvironment.Keys) { [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], 'Process') }
    if ($testRoot) { Remove-Item -LiteralPath $testRoot -Recurse -Force }
}
