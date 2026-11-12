# End-to-end check of the Windows service on a machine where it is safe to install one (CI's
# runners are disposable and run elevated). Moves a real per-user identity into the service,
# talks to it over its pipe, and moves it back — the identity must survive both moves unchanged.
param([Parameter(Mandatory)][string]$AppDirectory)
$ErrorActionPreference = 'Stop'
$app = (Resolve-Path $AppDirectory).Path
$service = Join-Path $app 'StreetCryptid.Repeater.Service.exe'
$hostExe = Join-Path $app 'streetcryptid-repeater-host.exe'
$user = Join-Path ([System.IO.Path]::GetTempPath()) "streetcryptid-service-test-$([guid]::NewGuid())"
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
New-Item -ItemType Directory $user | Out-Null

function Invoke-Verb([string[]]$Arguments) {
    $process = Start-Process -FilePath $service -ArgumentList $Arguments -Wait -PassThru -NoNewWindow
    return $process.ExitCode
}

try {
    # A per-user identity to move.
    $start = [System.Diagnostics.ProcessStartInfo]::new($hostExe)
    $start.UseShellExecute = $false
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    foreach ($argument in '--state-dir', $user, '--mode', 'user') { $start.ArgumentList.Add($argument) }
    $child = [System.Diagnostics.Process]::Start($start)
    $read = $child.StandardOutput.ReadLineAsync()
    if (!$read.Wait(40000)) { throw 'The per-user host did not start.' }
    $identity = ($read.Result | ConvertFrom-Json).snapshot.endpointId
    $child.StandardInput.Close()
    if (!$child.WaitForExit(10000)) { $child.Kill($true); throw 'The per-user host did not stop.' }
    $key = [System.IO.File]::ReadAllBytes((Join-Path $user 'secret.key'))

    $code = Invoke-Verb @('install', '--owner', $sid, '--from', $user)
    if ($code -ne 0) { throw "Install failed with $code." }
    if (Test-Path (Join-Path $user 'secret.key')) { throw 'The identity was copied, not moved.' }
    if (!(Test-Path (Join-Path $user 'moved-to-service'))) { throw 'The per-user directory was not marked.' }
    if ((Get-Service StreetCryptidRepeater).Status -ne 'Running') { throw 'The service is not running.' }
    $root = Join-Path $env:ProgramData 'streetCryptid'
    $broad = (Get-Acl $root).Access | Where-Object {
        $_.IdentityReference -match 'Users|Everyone|Authenticated'
    }
    if ($broad) { throw 'The service state is readable beyond SYSTEM, Administrators and the service.' }

    $pipe = [System.IO.Pipes.NamedPipeClientStream]::new('.', 'streetcryptid-repeater',
        [System.IO.Pipes.PipeDirection]::InOut)
    $pipe.Connect(15000)
    $reader = [System.IO.StreamReader]::new($pipe)
    $writer = [System.IO.StreamWriter]::new($pipe)
    $writer.AutoFlush = $true
    $sawService = $false
    $snapshot = $null
    $deadline = [DateTime]::UtcNow.AddSeconds(90)
    while ([DateTime]::UtcNow -lt $deadline -and !$snapshot) {
        $line = $reader.ReadLineAsync()
        if (!$line.Wait(60000)) { throw 'The service sent nothing.' }
        $message = $line.Result | ConvertFrom-Json
        if ($message.kind -eq 'service') { $sawService = $true }
        if ($message.kind -eq 'snapshot') { $snapshot = $message.snapshot }
    }
    if (!$sawService) { throw 'The service did not describe itself first.' }
    if (!$snapshot -or $snapshot.endpointId -ne $identity) { throw 'The service runs a different identity.' }
    if ($snapshot.mode -ne 'service') { throw 'The host does not know it runs under the service.' }
    $writer.WriteLine((@{ protocol = 2; kind = 'settings'; requestId = 'svc'; telemetry = $false; keepAwake = $true } |
        ConvertTo-Json -Compress))
    $confirmed = $false
    $deadline = [DateTime]::UtcNow.AddSeconds(20)
    while ([DateTime]::UtcNow -lt $deadline -and !$confirmed) {
        $line = $reader.ReadLineAsync()
        if (!$line.Wait(20000)) { break }
        $message = $line.Result | ConvertFrom-Json
        if ($message.kind -eq 'result' -and $message.requestId -eq 'svc') { $confirmed = [bool]$message.ok }
    }
    if (!$confirmed) { throw 'The service did not relay a settings command.' }
    # Anything else is refused: the service closes a pipe that sends it.
    $writer.WriteLine('{"protocol":2,"kind":"subscription"}')
    $closed = $reader.ReadLineAsync()
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    while ([DateTime]::UtcNow -lt $deadline) {
        if (!$closed.Wait(10000)) { throw 'The service kept a pipe that sent it an unknown command.' }
        if ($null -eq $closed.Result) { break }
        $closed = $reader.ReadLineAsync()
    }
    $pipe.Dispose()

    $code = Invoke-Verb @('uninstall', '--to', $user)
    if ($code -ne 0) { throw "Uninstall failed with $code." }
    if (Get-Service StreetCryptidRepeater -ErrorAction SilentlyContinue) { throw 'The service is still installed.' }
    $back = [System.IO.File]::ReadAllBytes((Join-Path $user 'secret.key'))
    if ([Convert]::ToHexString($back) -ne [Convert]::ToHexString($key)) { throw 'The identity changed on the way back.' }
    if (Test-Path (Join-Path $user 'moved-to-service')) { throw 'The per-user directory is still marked.' }
    if (!(Test-Path (Join-Path $user 'host-settings.json'))) { throw 'The settings did not come back with the identity.' }
    Write-Output 'Service installs, carries the same identity, relays only settings, and hands the identity back.'
} finally {
    if (Get-Service StreetCryptidRepeater -ErrorAction SilentlyContinue) { Invoke-Verb @('uninstall', '--to', $user) | Out-Null }
    Remove-Item -LiteralPath $user -Recurse -Force -ErrorAction SilentlyContinue
}
