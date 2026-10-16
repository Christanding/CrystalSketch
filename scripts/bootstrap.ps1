param([switch]$Help)

# Compatible with Windows PowerShell 5.1 and invocation as a remote scriptblock.
function Get-CrystalReleaseArchive {
    param([string]$Destination, [long]$MaximumBytes)

    $uri = [Uri]'https://github.com/Christanding/CrystalSketch/releases/latest/download/CrystalSketch.zip'
    $previousProtocol = [Net.ServicePointManager]::SecurityProtocol
    try {
        # Older Windows PowerShell sessions may not enable TLS 1.2 by default.
        [Net.ServicePointManager]::SecurityProtocol = $previousProtocol -bor [Net.SecurityProtocolType]::Tls12
        for ($redirects = 0; $redirects -le 10; $redirects++) {
            $request = [Net.HttpWebRequest]::Create($uri)
            $request.AllowAutoRedirect = $false
            $request.UserAgent = 'CrystalSketch-bootstrap'
            $request.Timeout = 60000
            $request.ReadWriteTimeout = 60000
            $response = $request.GetResponse()
            try {
                if ([int]$response.StatusCode -in @(301, 302, 303, 307, 308)) {
                    if ($redirects -eq 10 -or -not $response.Headers['Location']) {
                        throw 'The release download returned an invalid redirect.'
                    }
                    $uri = [Uri]::new($uri, $response.Headers['Location'])
                    if ($uri.Scheme -ne 'https') { throw 'The release download redirected away from HTTPS.' }
                    continue
                }
                if ([int]$response.StatusCode -ne 200) { throw 'The release download did not return a ZIP file.' }
                if ($response.ContentLength -gt $MaximumBytes) { throw 'The release archive exceeds the 128 MiB limit.' }

                $source = $response.GetResponseStream()
                $destinationStream = $null
                try {
                    $destinationStream = [IO.File]::Open($Destination, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
                    $buffer = New-Object byte[] 65536
                    $received = 0L
                    while (($count = $source.Read($buffer, 0, $buffer.Length)) -gt 0) {
                        $received += $count
                        if ($received -gt $MaximumBytes) { throw 'The release archive exceeds the 128 MiB limit.' }
                        $destinationStream.Write($buffer, 0, $count)
                    }
                    if ($response.ContentLength -ge 0 -and $received -ne $response.ContentLength) {
                        throw 'The release download was incomplete.'
                    }
                } finally {
                    if ($destinationStream) { $destinationStream.Dispose() }
                    $source.Dispose()
                }
                return
            } finally { $response.Dispose() }
        }
    } finally { [Net.ServicePointManager]::SecurityProtocol = $previousProtocol }
}

function Expand-CrystalReleaseArchive {
    param([string]$ArchivePath, [string]$Destination, [long]$MaximumBytes)

    if ((Get-Item -LiteralPath $ArchivePath).Length -gt $MaximumBytes) {
        throw 'The release archive exceeds the 128 MiB limit.'
    }
    Add-Type -AssemblyName System.IO.Compression
    if (-not [IO.Compression.ZipArchiveEntry].GetProperty('ExternalAttributes')) {
        throw 'Safe ZIP validation requires .NET Framework 4.7.2 or later. Update Windows/.NET and try again.'
    }
    $archiveStream = [IO.File]::OpenRead($ArchivePath)
    $archive = $null
    try {
        $archive = [IO.Compression.ZipArchive]::new($archiveStream, [IO.Compression.ZipArchiveMode]::Read, $false)
        if ($archive.Entries.Count -eq 0 -or $archive.Entries.Count -gt 100) {
            throw 'The release archive must contain between 1 and 100 entries.'
        }
        $names = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
        $totalLength = 0L
        $wheelCount = 0
        foreach ($entry in $archive.Entries) {
            $name = $entry.FullName
            if (-not $names.Add($name)) { throw "Duplicate archive path: $name" }
            $unixType = ($entry.ExternalAttributes -shr 16) -band 0xF000
            if ($unixType -notin @(0, 0x8000, 0x4000) -or ($entry.ExternalAttributes -band 0x400) -ne 0) {
                throw "Links and special files are not allowed in the release archive: $name"
            }
            if ($name -ceq 'CrystalSketch/') {
                if ($entry.Length -ne 0) { throw 'The archive root directory contains data.' }
                continue
            }
            if ($name -cnotmatch '\ACrystalSketch/[^/]+\z') { throw "Unexpected archive path: $name" }
            $fileName = $name.Substring('CrystalSketch/'.Length)
            if ($fileName -in @('.', '..') -or $fileName -match '[<>:"\\|?*\x00-\x1f]' -or
                $fileName -match '[. ]\z' -or
                $fileName -match '\A(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|\z)' -or
                $unixType -eq 0x4000 -or ($entry.ExternalAttributes -band 0x10) -ne 0) {
                throw "Invalid release file name or type: $name"
            }
            $totalLength += $entry.Length
            if ($entry.Length -lt 0 -or $totalLength -gt $MaximumBytes) {
                throw 'The unpacked release exceeds the 128 MiB limit.'
            }
            if ($fileName -match '\.whl\z') {
                if ($fileName -cnotmatch '\Acrystalsketch-[A-Za-z0-9][A-Za-z0-9_.+]*-py3-none-any\.whl\z' -or $entry.Length -eq 0) {
                    throw "Unexpected or empty wheel: $name"
                }
                $wheelCount++
            }
            if ($fileName -in @('install.ps1', 'install.sh') -and $entry.Length -eq 0) {
                throw "The release installer is empty: $name"
            }
        }
        if ($wheelCount -ne 1 -or -not $names.Contains('CrystalSketch/install.ps1') -or
            -not $names.Contains('CrystalSketch/install.sh')) {
            throw 'The release archive must contain exactly one wheel, install.ps1, and install.sh.'
        }

        $bundleDirectory = Join-Path $Destination 'CrystalSketch'
        [void][IO.Directory]::CreateDirectory($bundleDirectory)
        $buffer = New-Object byte[] 65536
        $expanded = 0L
        foreach ($entry in $archive.Entries) {
            if ($entry.FullName -ceq 'CrystalSketch/') { continue }
            $target = Join-Path $bundleDirectory $entry.FullName.Substring('CrystalSketch/'.Length)
            $source = $entry.Open()
            $output = $null
            try {
                $output = [IO.File]::Open($target, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
                $entryBytes = 0L
                # Read every entry fully before any installer code can run.
                while (($count = $source.Read($buffer, 0, $buffer.Length)) -gt 0) {
                    $entryBytes += $count
                    $expanded += $count
                    if ($entryBytes -gt $entry.Length -or $expanded -gt $MaximumBytes) {
                        throw 'The extracted release data exceeds its declared size.'
                    }
                    $output.Write($buffer, 0, $count)
                }
                if ($entryBytes -ne $entry.Length) { throw "Incomplete archive entry: $($entry.FullName)" }
            } finally {
                if ($output) { $output.Dispose() }
                $source.Dispose()
            }
        }
        return (Join-Path $bundleDirectory 'install.ps1')
    } finally {
        if ($archive) { $archive.Dispose() }
        $archiveStream.Dispose()
    }
}

function Invoke-CrystalReleaseInstaller {
    param([string]$InstallerPath)

    # A separate process preserves the caller's working directory and process PATH.
    # Bypass is limited to this child process; no stored execution policy is changed.
    $powerShell = (Get-Process -Id $PID).Path
    & $powerShell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $InstallerPath | Out-Host
    return $LASTEXITCODE
}

if ($Help) {
    Write-Host 'Downloads the latest official CrystalSketch release and runs its bundled Windows installer.'
    Write-Host 'Missing uv, Python 3.12, and application dependencies are prepared by the bundled installer.'
    Write-Host 'No Git, Bun, or preinstalled Python is needed. Reopen your terminal after installation, then run Crystal.'
    return
}

$previousErrorAction = $ErrorActionPreference
$temporaryDirectory = $null
try {
    $ErrorActionPreference = 'Stop'
    $candidateDirectory = Join-Path ([IO.Path]::GetTempPath()) ('crystalsketch-bootstrap-' + [Guid]::NewGuid().ToString('N'))
    # Assign ownership only after creation succeeds, so an existing path is never removed.
    $temporaryDirectory = (New-Item -ItemType Directory -Path $candidateDirectory -ErrorAction Stop).FullName
    $archivePath = Join-Path $temporaryDirectory 'CrystalSketch.zip'
    Write-Host 'Downloading the latest CrystalSketch release...'
    Get-CrystalReleaseArchive -Destination $archivePath -MaximumBytes 134217728
    $installerPath = Expand-CrystalReleaseArchive -ArchivePath $archivePath -Destination $temporaryDirectory -MaximumBytes 134217728
    Write-Host 'Release archive verified. Starting the bundled installer...'
    $installerExit = Invoke-CrystalReleaseInstaller -InstallerPath $installerPath
    if ($installerExit -ne 0) { throw "CrystalSketch installation failed (exit code $installerExit)." }
    Write-Host 'CrystalSketch installation completed. Reopen your terminal, then run Crystal.'
} finally {
    try {
        if ($temporaryDirectory -and (Test-Path -LiteralPath $temporaryDirectory)) {
            Remove-Item -LiteralPath $temporaryDirectory -Recurse -Force
        }
    } finally { $ErrorActionPreference = $previousErrorAction }
}
