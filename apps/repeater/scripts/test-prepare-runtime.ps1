$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
$root = Split-Path $PSScriptRoot
$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) "repeater-prepare-test-$([guid]::NewGuid())"
New-Item -ItemType Directory -Force "$testRoot\scripts", "$testRoot\native", "$testRoot\vendor" | Out-Null
try {
    Copy-Item "$PSScriptRoot\prepare-runtime.ps1" "$testRoot\scripts\prepare-runtime.ps1"
    Copy-Item "$root\native\trail-stash.patch" "$testRoot\native\trail-stash.patch"
    $checkout = "$testRoot\vendor\trail-stash"
    git clone --quiet --shared --no-checkout "$root\vendor\trail-stash" $checkout
    git -C $checkout -c core.autocrlf=false checkout --quiet --detach 326c530149ded29c88e899c6cb2fe6a0bd0f4365
    $prepare = "$testRoot\scripts\prepare-runtime.ps1"
    & $prepare
    & $prepare

    $untracked = "$checkout\unexpected.txt"
    Set-Content $untracked 'local file'
    $refused = $false
    try { & $prepare } catch { $refused = $true }
    if (!$refused -or !(Test-Path $untracked)) { throw 'Untracked-file protection failed.' }
    Remove-Item -LiteralPath $untracked

    $node = "$checkout\rust\src\node.rs"
    Add-Content $node '// staged-local-edit'
    git -C $checkout add rust/src/node.rs
    $before = (Get-FileHash $node).Hash
    $refused = $false
    try { & $prepare } catch { $refused = $true }
    if (!$refused -or (Get-FileHash $node).Hash -ne $before) { throw 'Staged-edit protection failed.' }
    Write-Output 'Runtime preparation preserves staged and untracked changes.'
} finally {
    Remove-Item -LiteralPath $testRoot -Recurse -Force
}
