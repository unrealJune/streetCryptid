param([Parameter(Mandatory)][string]$Executable)
$ErrorActionPreference = 'Stop'
$executablePath = (Resolve-Path $Executable).Path
$state = Join-Path ([System.IO.Path]::GetTempPath()) "streetcryptid-host-test-$([guid]::NewGuid())"
New-Item -ItemType Directory $state | Out-Null

function Start-Host {
    $start = [System.Diagnostics.ProcessStartInfo]::new($executablePath)
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    foreach ($argument in '--state-dir', $state, '--mode', 'user') { $start.ArgumentList.Add($argument) }
    [System.Diagnostics.Process]::Start($start)
}

function Read-Message($child, [int]$Milliseconds = 40000) {
    $read = $child.StandardOutput.ReadLineAsync()
    if (!$read.Wait($Milliseconds)) { throw 'Host produced no message before its deadline.' }
    # Never print the raw line: snapshots of an unclaimed host contain a claim secret.
    $read.Result | ConvertFrom-Json
}

try {
    $identity = $null
    foreach ($pass in 1..2) {
        $child = Start-Host
        try {
            $message = Read-Message $child
            if ($message.protocol -ne 2 -or $message.kind -ne 'snapshot' -or
                $message.snapshot.claimed -or !$message.snapshot.claimUrl -or
                $message.snapshot.tracked -ne 0 -or $message.snapshot.mode -ne 'user') { throw 'Invalid fresh-host status.' }
            if ($pass -eq 1) {
                $identity = $message.snapshot.endpointId
                if ($message.snapshot.settings.telemetry -or $message.snapshot.settings.keepAwake) {
                    throw 'A fresh host must not send diagnostics or hold the PC awake before it is asked to.'
                }
            } else {
                if ($identity -ne $message.snapshot.endpointId) { throw 'Identity changed on restart.' }
                if (!$message.snapshot.settings.keepAwake) { throw 'Settings did not survive restart.' }
            }
            $requestId = "settings-$pass"
            $child.StandardInput.WriteLine((@{
                protocol = 2; kind = 'settings'; requestId = $requestId
                telemetry = $false; keepAwake = $true
            } | ConvertTo-Json -Compress))
            $child.StandardInput.Flush()
            $confirmed = $false
            $reflected = $false
            $deadline = [DateTime]::UtcNow.AddSeconds(15)
            while ([DateTime]::UtcNow -lt $deadline) {
                $reply = Read-Message $child 15000
                if ($reply.kind -eq 'result' -and $reply.requestId -eq $requestId) {
                    if (!$reply.ok) { throw 'Settings command was refused.' }
                    $confirmed = $true
                }
                if ($confirmed -and $reply.kind -eq 'snapshot') {
                    if (!$reply.snapshot.settings.keepAwake) { throw 'Settings not reflected.' }
                    $reflected = $true
                    break
                }
            }
            if (!$confirmed -or !$reflected) { throw 'Settings command was not acknowledged and reflected.' }
            $child.StandardInput.Close()
            if (!$child.WaitForExit(10000)) { throw 'Host did not stop after stdin closed.' }
            if ($child.ExitCode -ne 0) { throw 'Host returned a failure exit code.' }
        } finally {
            if (!$child.HasExited) { $child.Kill($true); $child.WaitForExit() }
            $child.Dispose()
        }
    }
    foreach ($kept in 'secret.key', 'host-settings.json') {
        if (!(Test-Path (Join-Path $state $kept))) { throw "The host keeps no $kept on disk." }
    }
    # Memory only: no replica and no ciphertext on disk, ever.
    foreach ($never in 'docs', 'blobs') {
        if (Test-Path (Join-Path $state $never)) { throw "The host wrote $never to disk." }
    }

    # A directory whose identity went to the service must never start a second one.
    Set-Content (Join-Path $state 'moved-to-service') 'moved'
    $child = Start-Host
    try {
        if (!$child.WaitForExit(15000)) { throw 'Host started in a directory owned by the service.' }
        if ($child.ExitCode -eq 0) { throw 'Host accepted a directory owned by the service.' }
    } finally {
        if (!$child.HasExited) { $child.Kill($true); $child.WaitForExit() }
        $child.Dispose()
    }
    Write-Output 'Host keeps identity and settings but no content on disk, refuses service-owned state, and stops on pipe EOF.'
} finally {
    Remove-Item -LiteralPath $state -Recurse -Force
}
