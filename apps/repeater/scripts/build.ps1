param(
    [ValidateSet('x64', 'arm64')][string]$Architecture = 'x64',
    [ValidateSet('Debug', 'Release')][string]$Configuration = 'Release',
    [switch]$Test,
    [switch]$Package,
    [string]$Version = '0.1.0-preview.1'
)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
$root = Split-Path $PSScriptRoot
Push-Location $root
try {
    & (Join-Path $PSScriptRoot 'prepare-runtime.ps1')
    $target = if ($Architecture -eq 'arm64') { 'aarch64-pc-windows-msvc' } else { 'x86_64-pc-windows-msvc' }
    $platform = if ($Architecture -eq 'arm64') { 'ARM64' } else { 'x64' }
    $rid = "win-$Architecture"
    $profile = if ($Configuration -eq 'Release') { 'release' } else { 'dev' }
    # Stamped into the host's telemetry and snapshots. SC_REPEATER_OTEL_ENDPOINT, when the caller
    # sets it, is compiled in as well; without it the host has no exporter at all.
    $env:REPEATER_VERSION = $Version
    if ($Test) {
        & (Join-Path $PSScriptRoot 'test-prepare-runtime.ps1')
        cargo fmt --manifest-path .\native\Cargo.toml --check
        cargo test --manifest-path .\native\Cargo.toml --locked --quiet
        $previousTarget = $env:CARGO_TARGET_DIR
        try {
            $env:CARGO_TARGET_DIR = Join-Path $root 'native\target'
            cargo test --manifest-path .\vendor\trail-stash\rust\Cargo.toml --locked --features live desktop_ --quiet
        } finally { $env:CARGO_TARGET_DIR = $previousTarget }
        dotnet test .\tests\Repeater.Tests.csproj --nologo -v:q -p:RestoreLockedMode=true
        foreach ($project in '.\core\Repeater.Core.csproj', '.\tests\Repeater.Tests.csproj', '.\service\Repeater.Service.csproj') {
            dotnet format $project --verify-no-changes --no-restore
        }
    }
    cargo build --manifest-path .\native\Cargo.toml --locked --profile $profile --target $target --quiet
    $output = Join-Path $root "artifacts\$rid\app"
    $appPri = Join-Path $output 'StreetCryptid.Repeater.pri'
    if (Test-Path -LiteralPath $appPri) { Remove-Item -LiteralPath $appPri -Force }
    dotnet publish .\windows\Repeater.csproj --configuration $Configuration --runtime $rid `
        -p:Platform=$platform -p:Version=$Version --output $output --nologo -v:q -p:RestoreLockedMode=true
    if (!(Test-Path -LiteralPath $appPri -PathType Leaf) -or (Get-Item -LiteralPath $appPri).Length -eq 0) {
        throw 'Published app is missing its WinUI resource index.'
    }
    # The service is native AOT: one executable, which is all that gets copied under Program Files.
    $serviceOutput = Join-Path $root "artifacts\$rid\service"
    dotnet publish .\service\Repeater.Service.csproj --configuration $Configuration --runtime $rid `
        -p:Version=$Version --output $serviceOutput --nologo -v:q -p:RestoreLockedMode=true
    Copy-Item (Join-Path $serviceOutput 'StreetCryptid.Repeater.Service.exe') $output
    $nativeProfile = if ($Configuration -eq 'Release') { 'release' } else { 'debug' }
    Copy-Item ".\native\target\$target\$nativeProfile\streetcryptid-repeater-host.exe" $output
    if ($Test) {
        & (Join-Path $PSScriptRoot 'test-host.ps1') -Executable (Join-Path $output 'streetcryptid-repeater-host.exe')
    }
    Copy-Item .\vendor\trail-stash\LICENSE (Join-Path $output 'LICENSE-trail-stash')
    Copy-Item .\native\trail-stash.patch (Join-Path $output 'trail-stash.patch')
    Copy-Item .\NOTICE (Join-Path $output 'NOTICE')
    if ($Package) {
        dotnet tool restore
        dotnet vpk pack --packId StreetCryptid.Repeater --packVersion $Version `
            --packDir $output --mainExe StreetCryptid.Repeater.exe `
            --packTitle 'streetCryptid repeater' --packAuthors 'streetCryptid' `
            --icon .\windows\Assets\repeater.ico --channel "repeater-$rid" `
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
        } finally { $archive.Dispose() }
    }
} finally { Pop-Location }
