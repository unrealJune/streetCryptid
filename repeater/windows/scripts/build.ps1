param(
    [ValidateSet('x64', 'arm64')][string]$Architecture = 'x64',
    [ValidateSet('Debug', 'Release')][string]$Configuration = 'Release',
    [switch]$Test,
    [switch]$Package,
    [switch]$SkipFormat,
    [string]$Version = '0.1.0-preview.1'
)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
function Invoke-BuildPhase([string]$Name, [scriptblock]$Command) {
    $timer = [System.Diagnostics.Stopwatch]::StartNew()
    try { & $Command }
    finally { Write-Host ('Build phase {0}: {1:N1}s' -f $Name, $timer.Elapsed.TotalSeconds) }
}
# repeater/windows; the Rust host is a member of the repository's Cargo workspace, so cargo runs
# with -p against the root lockfile and builds into the root target directory.
$root = Split-Path $PSScriptRoot
$repoRoot = Split-Path (Split-Path $root)
Push-Location $root
try {
    $platform = if ($Architecture -eq 'arm64') { 'ARM64' } else { 'x64' }
    $rid = "win-$Architecture"
    # `desktop-release` is the host's own release profile (/Cargo.toml); the workspace's `release`
    # is the phone's size-optimized one.
    $profile = if ($Configuration -eq 'Release') { 'desktop-release' } else { 'dev' }
    $nativeProfile = if ($Configuration -eq 'Release') { 'desktop-release' } else { 'debug' }
    $targetDir = if ($env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR } else { Join-Path $repoRoot 'target' }
    # No --target when building for this machine's own architecture (every CI runner): an explicit
    # --target, even the host's own triple, builds every dependency a second time into a directory
    # of its own instead of sharing the tests' build scripts and proc macros. Cross-building (ARM64
    # from an x64 workstation) still needs it.
    $hostArch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
    $targetArgs = @()
    $hostDir = Join-Path $targetDir $nativeProfile
    if ($hostArch -ne $Architecture) {
        $triple = if ($Architecture -eq 'arm64') { 'aarch64-pc-windows-msvc' } else { 'x86_64-pc-windows-msvc' }
        $targetArgs = @('--target', $triple)
        $hostDir = Join-Path $targetDir "$triple\$nativeProfile"
    }
    # Stamped into the host's telemetry and snapshots. SC_REPEATER_OTEL_ENDPOINT, when the caller
    # sets it, is compiled in as well; without it the host has no exporter at all.
    $env:REPEATER_VERSION = $Version
    $output = Join-Path $root "artifacts\$rid\app"
    $appPri = Join-Path $output 'StreetCryptid.Repeater.pri'

    # The .NET half (tests, format checks, the WinUI app and the native-AOT service) needs nothing
    # from Rust until the host executable is copied in at the end, so it runs in a second process
    # while cargo works. Both are CPU-heavy, but restore, publish and AOT's long single-threaded
    # stretches overlap cargo's instead of waiting for them.
    $jobArgs = @($Test.IsPresent, $SkipFormat.IsPresent, $Configuration, $rid, $platform,
        $Version, $root, ${function:Invoke-BuildPhase}.ToString())
    $dotnet = Start-Job -WorkingDirectory $root -ArgumentList $jobArgs -ScriptBlock {
        param($Test, $SkipFormat, $Configuration, $rid, $platform, $Version, $root, $phaseFunction)
        $ErrorActionPreference = 'Stop'
        $PSNativeCommandUseErrorActionPreference = $true
        Set-Item Function:Invoke-BuildPhase -Value ([scriptblock]::Create($phaseFunction))
        if ($Test) {
            Invoke-BuildPhase 'managed tests' {
                dotnet test .\tests\Repeater.Tests.csproj --nologo -v:q -p:RestoreLockedMode=true
            }
            if (!$SkipFormat) {
                Invoke-BuildPhase 'managed formatting' {
                    foreach ($project in '.\core\Repeater.Core.csproj', '.\tests\Repeater.Tests.csproj', '.\service\Repeater.Service.csproj') {
                        dotnet format $project --verify-no-changes --no-restore
                    }
                }
            }
        }
        $output = Join-Path $root "artifacts\$rid\app"
        $appPri = Join-Path $output 'StreetCryptid.Repeater.pri'
        if (Test-Path -LiteralPath $appPri) { Remove-Item -LiteralPath $appPri -Force }
        Invoke-BuildPhase 'WinUI publish' {
            dotnet publish .\app\Repeater.csproj --configuration $Configuration --runtime $rid `
                -p:Platform=$platform -p:Version=$Version --output $output --nologo -v:q -p:RestoreLockedMode=true
        }
        if (!(Test-Path -LiteralPath $appPri -PathType Leaf) -or (Get-Item -LiteralPath $appPri).Length -eq 0) {
            throw 'Published app is missing its WinUI resource index.'
        }
        # The service is native AOT: one executable, which is all that gets copied under Program Files.
        $serviceOutput = Join-Path $root "artifacts\$rid\service"
        Invoke-BuildPhase 'service AOT publish' {
            dotnet publish .\service\Repeater.Service.csproj --configuration $Configuration --runtime $rid `
                -p:Version=$Version --output $serviceOutput --nologo -v:q -p:RestoreLockedMode=true
        }
        Copy-Item (Join-Path $serviceOutput 'StreetCryptid.Repeater.Service.exe') $output
    }

    try {
        if ($Test) {
            if (!$SkipFormat) { cargo fmt -p streetcryptid-repeater-host --check }
            # `repeater-test` (/Cargo.toml) is the test profile without the phone's optimized
            # dependencies, and both runs ask for trail-stash with the same features the host
            # links (live + otel), so the second reuses everything the first compiled.
            Invoke-BuildPhase 'Rust host tests' {
                cargo test -p streetcryptid-repeater-host --profile repeater-test --locked --quiet
            }
            # The desktop tests in the server crate: MemoryRepeater, arrivals, forwarding.
            Invoke-BuildPhase 'Rust desktop stash tests' {
                cargo test -p trail-stash --profile repeater-test --features 'live,otel' --locked desktop_ --quiet
            }
        }
        Invoke-BuildPhase 'Rust host build' {
            cargo build -p streetcryptid-repeater-host --locked --profile $profile @targetArgs --quiet
        }
    } finally {
        # Never leave the .NET process running behind a Rust failure.
        $dotnetDone = Wait-Job $dotnet
        Receive-Job $dotnet
        $dotnetState = $dotnetDone.State
        Remove-Job $dotnet
    }
    if ($dotnetState -ne 'Completed') {
        throw ".NET build failed ($dotnetState); its output is above."
    }

    Copy-Item (Join-Path $hostDir 'streetcryptid-repeater-host.exe') $output
    if ($Test) {
        & (Join-Path $PSScriptRoot 'test-host.ps1') -Executable (Join-Path $output 'streetcryptid-repeater-host.exe')
    }
    # Every part (app, service, host, the trail-stash server crate it embeds) is this repository's,
    # under its AGPL-3.0-or-later LICENSE; NOTICE says where the source is.
    Copy-Item (Join-Path $repoRoot 'LICENSE') (Join-Path $output 'LICENSE')
    Copy-Item .\NOTICE (Join-Path $output 'NOTICE')
    if ($Package) {
        dotnet tool restore
        dotnet vpk pack --packId StreetCryptid.Repeater --packVersion $Version `
            --packDir $output --mainExe StreetCryptid.Repeater.exe `
            --packTitle 'streetCryptid repeater' --packAuthors 'streetCryptid' `
            --icon .\app\Assets\repeater.ico --channel "repeater-$rid" `
            --runtime $rid --outputDir ".\artifacts\$rid\releases" @(
                # Signed only when the release environment provides a certificate; see README.
                if ($env:REPEATER_SIGN_PARAMS) { '--signParams', $env:REPEATER_SIGN_PARAMS }
            )
        $packagePath = Join-Path $root "artifacts\$rid\releases\StreetCryptid.Repeater-$Version-repeater-$rid-full.nupkg"
        $archive = [System.IO.Compression.ZipFile]::OpenRead($packagePath)
        try {
            $entry = $archive.Entries | Where-Object {
                $_.FullName.Replace([char]47, [char]92) -eq 'lib\app\StreetCryptid.Repeater.pri'
            }
            if ($null -eq $entry -or $entry.Length -eq 0) { throw 'Package is missing its WinUI resource index.' }
            $stream = $entry.Open()
            try { $hash = [Convert]::ToHexString([System.Security.Cryptography.SHA256]::HashData($stream)) }
            finally { $stream.Dispose() }
            if ($hash -ne (Get-FileHash -LiteralPath $appPri).Hash) {
                throw 'Packaged WinUI resource index does not match the published app.'
            }
            foreach ($required in 'StreetCryptid.Repeater.Service.exe', 'streetcryptid-repeater-host.exe') {
                if (!($archive.Entries | Where-Object { $_.Name -eq $required })) {
                    throw "Package is missing $required."
                }
            }
            # The service's own files, for its unattended updater (service/Updater.cs), which
            # fetches this one asset rather than the whole app. Taken from the package, so they are
            # byte for byte what the app installs (signed, once releases are). Keep the names in
            # step with ServiceLayout.InstalledFiles and ServiceLayout.ServiceArchive.
            $serviceZip = Join-Path $root "artifacts\$rid\releases\StreetCryptid.Repeater.Service-$rid.zip"
            if (Test-Path -LiteralPath $serviceZip) { Remove-Item -LiteralPath $serviceZip -Force }
            $bundle = [System.IO.Compression.ZipFile]::Open($serviceZip, [System.IO.Compression.ZipArchiveMode]::Create)
            try {
                foreach ($name in 'StreetCryptid.Repeater.Service.exe', 'streetcryptid-repeater-host.exe', 'NOTICE', 'LICENSE') {
                    $source = $archive.Entries | Where-Object {
                        $_.FullName.Replace([char]47, [char]92) -eq "lib\app\$name"
                    }
                    if ($null -eq $source) { throw "Package is missing lib\app\$name." }
                    $from = $source.Open()
                    $to = $bundle.CreateEntry($name, [System.IO.Compression.CompressionLevel]::Optimal).Open()
                    try { $from.CopyTo($to) } finally { $to.Dispose(); $from.Dispose() }
                }
            } finally { $bundle.Dispose() }
        } finally { $archive.Dispose() }
    }
} finally { Pop-Location }
