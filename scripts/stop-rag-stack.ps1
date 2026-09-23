param(
    [ValidateSet('All', 'MinerU', 'RAG', 'Embedding')][string]$Service = 'All',
    [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$recordDirectory = Join-Path $projectRoot '.runtime\rag-stack'
# Stop consumers before the GPU and parser. Never kill by port or process name.
$names = if ($Service -eq 'All') { @('RAG', 'Embedding', 'MinerU') } else { @($Service) }

function Get-OwnedProcess($record) {
    if ($record.Project -ne $projectRoot -or [int]$record.Pid -le 0 -or -not $record.StartTicks) {
        throw 'Invalid process ownership record. No process stopped.'
    }
    $candidate = Get-Process -Id ([int]$record.Pid) -ErrorAction SilentlyContinue
    if (-not $candidate) { return $null }
    if (-not $record.Exe) { throw 'Live service has an incomplete old ownership record. Refusing to infer its executable.' }
    $livePath = $candidate.Path
    if (-not $livePath) {
        $liveInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $($candidate.Id)"
        if (-not $liveInfo) { return $null }
        $livePath = $liveInfo.ExecutablePath
    }
    if (-not $livePath -or $candidate.StartTime.ToUniversalTime().Ticks.ToString() -ne [string]$record.StartTicks -or $livePath -ne $record.Exe) {
        Write-Warning "PID $($record.Pid) no longer matches the recorded service; skipped."
        return $null
    }
    return $candidate
}

function Get-ProcessTree($parent, $snapshot) {
    # Return children before parents, keeping process handles to avoid PID-only kills.
    foreach ($entry in $snapshot | Where-Object { $_.ParentProcessId -eq $parent.Id }) {
        $child = Get-Process -Id $entry.ProcessId -ErrorAction SilentlyContinue
        if (-not $child) { continue }
        # Reject recycled PIDs/old parent references. CIM timestamps have lower precision.
        if ($child.StartTime -lt $parent.StartTime -or
            [math]::Abs(($child.StartTime.ToUniversalTime() - $entry.CreationDate.ToUniversalTime()).TotalMilliseconds) -gt 10) { continue }
        Get-ProcessTree $child $snapshot
    }
    return $parent
}

foreach ($name in $names) {
    $recordPath = Join-Path $recordDirectory "$name.process.json"
    if (-not (Test-Path -LiteralPath $recordPath -PathType Leaf)) {
        Write-Warning "[SKIP] $name has no ownership record. Old/manual/reused services must be stopped in their original terminal."
        continue
    }
    $record = Get-Content -LiteralPath $recordPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($record.Name -ne $name) { throw "Mismatched service record: $name" }
    $root = Get-OwnedProcess $record
    if (-not $root) { Write-Host "[SKIP] $name is stopped or ownership no longer matches."; continue }
    $snapshot = @(Get-CimInstance Win32_Process)
    $targets = @(Get-ProcessTree $root $snapshot)
    foreach ($target in $targets) {
        Write-Host "[TARGET] $name PID=$($target.Id) executable=$($target.Path)"
    }
    if ($CheckOnly) { continue }
    # Recheck the root immediately before termination; fail closed if it changed.
    if (-not (Get-OwnedProcess $record)) { throw "$name ownership changed; stop aborted." }
    foreach ($target in $targets) {
        $target.Refresh()
        if ($target.HasExited) { continue }
        try { $target.Kill() } catch {
            # Python launchers can exit automatically when their child exits.
            # Ignore only a confirmed exit/PID replacement, never a live access denial.
            $remaining = Get-CimInstance Win32_Process -Filter "ProcessId = $($target.Id)"
            if ($remaining -and [math]::Abs(($target.StartTime.ToUniversalTime() - $remaining.CreationDate.ToUniversalTime()).TotalMilliseconds) -le 10) { throw }
            continue
        }
        if (-not $target.WaitForExit(10000)) { throw "PID $($target.Id) did not stop; no stronger termination attempted." }
    }
    Write-Host "[STOPPED] $name. Logs and uploaded files were preserved."
}
if ($CheckOnly) { Write-Host 'Check only: no processes stopped.' }
else { Write-Host 'Done. Unmanaged services, Next.js and workflow were not targeted.' }
