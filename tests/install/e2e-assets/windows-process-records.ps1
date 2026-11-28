# Process identity records shared by the stale old-payload check and the failed-update
# evidence collector, so both report a process with the same fields and log line.

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
