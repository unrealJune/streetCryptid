# streetCryptid repeater for Windows: download the installer for this PC and run it.
#
#   irm https://streetcrypt.id/repeater/install.ps1 | iex
#
# What it does, all of it:
#   1. Picks x64 or ARM64 from the machine's native architecture (not this shell's, which on an
#      ARM64 PC can be an emulated x64 process).
#   2. Downloads that installer from the project's GitHub releases (the `repeater-preview` feed the
#      app itself updates from) into your temp folder.
#   3. Marks the file as downloaded from the internet, exactly as a browser would, and opens it.
#
# Step 3 is deliberate. The preview installers are not code-signed yet, so Windows SmartScreen
# will say it does not recognise the app. A file fetched by a script carries no such mark and
# would skip that check silently; we would rather you see the warning and choose. Click
# "More info", check the publisher line reads "Unknown publisher", then "Run anyway".
#
# Nothing here needs administrator rights. Running as a Windows service is offered by the app's
# own setup, which asks for approval itself.
#
# Source: https://github.com/unrealJune/streetCryptid/blob/main/website/site/repeater/install.ps1

& {
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue' # Windows PowerShell 5.1 downloads ~50x slower with the bar.

    # Windows PowerShell 5.1 can default to TLS 1.0, which GitHub refuses.
    [Net.ServicePointManager]::SecurityProtocol =
        [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

    # The native architecture, from the one place emulation does not rewrite it.
    $arch = $null
    try {
        $arch = (Get-ItemProperty -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Environment' -Name PROCESSOR_ARCHITECTURE).PROCESSOR_ARCHITECTURE
    } catch { }
    if (-not $arch) {
        $arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
    }
    switch ($arch) {
        'AMD64' { $rid = 'win-x64' }
        'ARM64' { $rid = 'win-arm64' }
        default { throw "The streetCryptid repeater runs on 64-bit Windows (x64 or ARM64); this PC reports '$arch'." }
    }

    $name = "StreetCryptid.Repeater-repeater-$rid-Setup.exe"
    $url = "https://github.com/unrealJune/streetCryptid/releases/download/repeater-preview/$name"
    $dest = Join-Path ([IO.Path]::GetTempPath()) $name

    Write-Host "streetCryptid repeater: downloading the $rid installer..."
    Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $dest

    # The Mark of the Web, as a browser writes it. If it cannot be written, do not run the file:
    # that would be the silent bypass this script exists not to do.
    try {
        $zone = "[ZoneTransfer]`r`nZoneId=3`r`nReferrerUrl=https://streetcrypt.id/repeater`r`nHostUrl=$url`r`n"
        Set-Content -LiteralPath $dest -Stream Zone.Identifier -Value $zone
    } catch {
        Write-Warning "Could not mark the installer as downloaded, so it was not started. Open it yourself from: $dest"
        Start-Process -FilePath 'explorer.exe' -ArgumentList "/select,`"$dest`""
        return
    }

    Write-Host 'Starting the installer. Windows will ask before running an unsigned preview.'
    Start-Process -FilePath $dest
}
