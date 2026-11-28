# Verify no processes from the replaced OLD package directory remain alive after swap.
# When any are seen initially, poll up to -SettleSeconds for post-swap teardown while
# recording full process identity (ProcessId, ParentProcessId, Name, CreationDate,
# ExecutablePath, CommandLine) to both stdout and proof/stale-processes.json.
param(
    [Parameter(Mandatory = $true)][string]$OldInstallLocation,
    [Parameter(Mandatory = $true)][string]$ProofDir,
    [int]$SettleSeconds = 15,
    [int]$PollMilliseconds = 1000
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$prefix = $OldInstallLocation.TrimEnd('\') + '\'

function Format-ProcessRecord($Proc) {
    $created = $null
    if ($null -ne $Proc.PSObject.Properties['CreationDate'] -and $null -ne $Proc.CreationDate) {
        $created = if ($Proc.CreationDate -is [datetime]) {
            $Proc.CreationDate.ToUniversalTime().ToString('o')
        } else {
            [string]$Proc.CreationDate
        }
    }
    $ppid = if ($null -ne $Proc.PSObject.Properties['ParentProcessId']) { $Proc.ParentProcessId } else { $null }
    $name = if ($null -ne $Proc.PSObject.Properties['Name']) { $Proc.Name } else { $null }
    $cmd = if ($null -ne $Proc.PSObject.Properties['CommandLine']) { $Proc.CommandLine } else { $null }
    return [ordered]@{
        ProcessId       = $Proc.ProcessId
        ParentProcessId = $ppid
        Name            = $name
        CreationDate    = $created
        ExecutablePath  = $Proc.ExecutablePath
        CommandLine     = $cmd
    }
}

function Format-ProcessLine($Record) {
    $cmd = if ($null -ne $Record.CommandLine) { ($Record.CommandLine -replace '\s+', ' ').Trim() } else { '' }
    if ($cmd.Length -gt 240) { $cmd = $cmd.Substring(0, 240) + '...' }
    return "pid=$($Record.ProcessId) ppid=$($Record.ParentProcessId) name=$($Record.Name) exe=$($Record.ExecutablePath) cmd=$cmd"
}

function Find-StaleProcesses {
    $hits = @(Get-CimInstance Win32_Process | Where-Object {
        $_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
    })
    return @($hits | ForEach-Object { Format-ProcessRecord $_ })
}

$initial = @(Find-StaleProcesses)
if ($initial.Count -eq 0) { return }

$firstSeen = (Get-Date).ToUniversalTime()
Write-Host "  [stale] $($initial.Count) old payload process(es) alive under $($OldInstallLocation); waiting up to ${SettleSeconds}s for teardown"
foreach ($record in $initial) { Write-Host "    $(Format-ProcessLine $record)" }

$remaining = $initial
if ($SettleSeconds -gt 0) {
    $deadline = (Get-Date).AddSeconds($SettleSeconds)
    while ($remaining.Count -gt 0 -and (Get-Date) -lt $deadline) {
        if ($PollMilliseconds -gt 0) { Start-Sleep -Milliseconds $PollMilliseconds }
        $remaining = @(Find-StaleProcesses)
    }
}

$checkedAt = (Get-Date).ToUniversalTime()
$settled = ($remaining.Count -eq 0)
New-Item -ItemType Directory -Force -Path $ProofDir | Out-Null
$report = [ordered]@{
    oldInstallLocation = $OldInstallLocation
    firstSeenAt        = $firstSeen.ToString('o')
    checkedAt          = $checkedAt.ToString('o')
    settleSeconds      = $SettleSeconds
    settled            = $settled
    initial            = [object[]]@($initial)
    remaining          = [object[]]@($remaining)
}
ConvertTo-Json -InputObject $report -Depth 5 | Set-Content -LiteralPath (Join-Path $ProofDir 'stale-processes.json') -Encoding UTF8

if ($settled) {
    $elapsed = [Math]::Round(($checkedAt - $firstSeen).TotalSeconds, 1)
    Write-Host "  [stale] old payload processes exited within ${elapsed}s (saved stale-processes.json)"
    return
}

Write-Host "  [stale] $($remaining.Count) old payload process(es) still alive after ${SettleSeconds}s (saved stale-processes.json):"
foreach ($record in $remaining) { Write-Host "    $(Format-ProcessLine $record)" }
$summary = (@($remaining | ForEach-Object { Format-ProcessLine $_ }) -join '; ')
throw "Old payload processes remain alive after ${SettleSeconds}s: $summary"
