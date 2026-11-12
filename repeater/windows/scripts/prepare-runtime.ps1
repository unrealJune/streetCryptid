$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
# git writes UTF-8; decoding its diff in the console's code page mangles every non-ASCII
# character and makes an exactly-patched checkout look modified.
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$root = Split-Path $PSScriptRoot
$source = Join-Path $root 'vendor\trail-stash'
$revision = '326c530149ded29c88e899c6cb2fe6a0bd0f4365'
$patch = Join-Path $root 'native\trail-stash.patch'

if (!(Test-Path $source)) {
    New-Item -ItemType Directory -Force (Split-Path $source) | Out-Null
    git clone --quiet --no-checkout https://github.com/unrealJune/trail-stash.git $source
    git -C $source -c core.autocrlf=false checkout --quiet --detach $revision
}
if ((git -C $source rev-parse HEAD).Trim() -ne $revision) {
    throw "Unexpected upstream revision in $source. Refusing to modify it."
}
# Accept only pristine pinned source or exactly our patch, including staged changes.
if (git -C $source ls-files --others --exclude-standard) {
    throw "Unexpected untracked files in $source. Refusing to modify it."
}
$diff = git -C $source --no-pager diff --no-ext-diff --binary HEAD
if ($diff) {
    $expected = (Get-Content $patch -Raw).Replace("`r`n", "`n").Trim()
    if (($diff -join "`n").Trim() -ne $expected) {
        throw "Unexpected upstream changes in $source. Refusing to overwrite them."
    }
} else {
    git -C $source apply --check $patch
    git -C $source apply $patch
}
