param([switch]$CheckOnly)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot

# Only import service configuration, never evaluate dotenv contents as code.
$allowed = @('EMBEDDING_SERVICE_URL', 'EMBEDDING_TIMEOUT_MS', 'EMBEDDING_PYTHON', 'EMBEDDING_DEVICE', 'EMBEDDING_BGE_M3_PATH', 'EMBEDDING_QWEN3_PATH', 'MINERU_DEVICE_MODE', 'MINERU_MODEL_SOURCE', 'MINERU_TOOLS_CONFIG_JSON', 'MINERU_BACKEND', 'MINERU_EFFORT', 'MINERU_TIMEOUT_SECONDS')
foreach ($file in @('.env', '.env.local')) {
    $path = Join-Path $projectRoot $file
    if (Test-Path -LiteralPath $path -PathType Leaf) {
        foreach ($line in Get-Content -LiteralPath $path -Encoding UTF8) {
            if ($line -match '^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$' -and $Matches[1] -in $allowed) {
                $key = $Matches[1]
                $value = $Matches[2].Trim()
                if ($value.Length -ge 2 -and (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'")))) {
                    $value = $value.Substring(1, $value.Length - 2)
                }
                if ($value) { [Environment]::SetEnvironmentVariable($key, $value, 'Process') }
            }
        }
    }
}

$env:MINERU_API_URL = 'http://127.0.0.1:6000'
if (-not $env:EMBEDDING_SERVICE_URL) { $env:EMBEDDING_SERVICE_URL = 'http://127.0.0.1:8020' }
if (-not $env:MINERU_BACKEND) { $env:MINERU_BACKEND = 'pipeline' }
if (-not $env:MINERU_EFFORT) { $env:MINERU_EFFORT = 'medium' }
if (-not $env:MINERU_TIMEOUT_SECONDS) { $env:MINERU_TIMEOUT_SECONDS = '900' }
if (-not $env:EMBEDDING_DEVICE) { $env:EMBEDDING_DEVICE = 'auto' }
$embeddingPython = if ($env:EMBEDDING_PYTHON) { $env:EMBEDDING_PYTHON } else { 'G:\MinerU\.venv\Scripts\python.exe' }
$services = @(
    @{
        Name = 'MinerU'
        Port = 6000
        Exe = 'G:\MinerU\.venv\Scripts\mineru-api.exe'
        Dir = 'G:\MinerU'
        Args = @(
            '--host', '0.0.0.0',
            '--port', '6000'
        )
    },

    @{
        Name = 'RAG'
        Port = 8010
        Exe = (Join-Path $projectRoot 'services\rag_ingestion\.venv\Scripts\python.exe')
        Dir = (Join-Path $projectRoot 'services\rag_ingestion')
        Args = @(
            '-m', 'uvicorn',
            'growth_loop_rag.main:app',
            '--host', '0.0.0.0',
            '--port', '8010'
        )
    },

    @{
        Name = 'Embedding'
        Port = 8020
        Exe = $embeddingPython
        Dir = (Join-Path $projectRoot 'services\embedding')
        Args = @(
            '-m', 'uvicorn',
            'growth_loop_embedding.main:app',
            '--host', '0.0.0.0',
            '--port', '8020'
        )
    }
)
function Get-ServiceHealth($service) {
    try {
        $result = Invoke-RestMethod -Uri "http://127.0.0.1:$($service.Port)/health" -TimeoutSec 5
        $valid = switch ($service.Name) {
            'MinerU' { $result.status -eq 'healthy' -and $null -ne $result.protocol_version }
            'RAG' { $result.status -eq 'ok' -and $null -ne $result.llamaIndexVersion -and $result.mineruHealthy -eq $true }
            'Embedding' { $result.status -eq 'ok' -and $null -ne $result.models -and $null -ne $result.device }
        }
        if ($valid) { return $result }
    } catch { }
    return $null
}

function Test-LocalPort([int]$port) {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $pending = $client.BeginConnect('127.0.0.1', $port, $null, $null)
        if (-not $pending.AsyncWaitHandle.WaitOne(500)) { return $false }
        $client.EndConnect($pending)
        return $true
    } catch { return $false } finally { $client.Dispose() }
}

# Validate all paths before starting any service.
foreach ($service in $services) {
    if (-not (Test-Path -LiteralPath $service.Exe -PathType Leaf)) { throw "Missing executable: $($service.Exe)" }
    if (-not (Test-Path -LiteralPath $service.Dir -PathType Container)) { throw "Missing directory: $($service.Dir)" }
    Write-Host "[CHECK] $($service.Name): $($service.Exe) (port $($service.Port))"
}
foreach ($modelPath in @(
    $(if ($env:EMBEDDING_BGE_M3_PATH) { $env:EMBEDDING_BGE_M3_PATH } else { 'G:\Embedding\bge-m3' }),
    $(if ($env:EMBEDDING_QWEN3_PATH) { $env:EMBEDDING_QWEN3_PATH } else { 'G:\Embedding\qwen3-embedding-0.6b' })
)) {
    if (-not (Test-Path -LiteralPath $modelPath -PathType Container)) { Write-Warning "Model directory missing: $modelPath (no automatic download)" }
}
if ($CheckOnly) {
    foreach ($service in $services) {
        Write-Host "[CHECK] Port $($service.Port) occupied: $(Test-LocalPort $service.Port)"
    }
    Write-Host 'Path/port check complete. No services started; dependencies and inference not tested.'
    exit 0
}

$logDir = Join-Path $projectRoot '.runtime\rag-stack'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
foreach ($service in $services) {
    $health = Get-ServiceHealth $service
    if ($health) {
        Write-Host "[REUSE] $($service.Name) healthy at http://127.0.0.1:$($service.Port)"
        continue
    }
    if (Test-LocalPort $service.Port) {
        throw "Port $($service.Port) is occupied but $($service.Name) health validation failed. Check the existing service; no process was stopped."
    }
    $outLog = Join-Path $logDir "$($service.Name)-$stamp.out.log"
    $errLog = Join-Path $logDir "$($service.Name)-$stamp.err.log"
    $launchExe = (Resolve-Path -LiteralPath $service.Exe -ErrorAction Stop).ProviderPath
    if (-not [System.IO.Path]::IsPathRooted($launchExe) -or -not (Test-Path -LiteralPath $launchExe -PathType Leaf)) { throw 'Invalid launch executable.' }
    $process = Start-Process -FilePath $launchExe -ArgumentList $service.Args -WorkingDirectory $service.Dir -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError $errLog -PassThru
    # Persist ownership before health checks, including partially started stacks.
    # Process.Path may be null immediately after Start-Process on Windows. Use the
    # exact resolved executable we launched; stop still verifies the live process.
    $record = @{ Name = $service.Name; Pid = $process.Id; StartTicks = $process.StartTime.ToUniversalTime().Ticks.ToString(); Exe = $launchExe; Project = $projectRoot }
    $record | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $logDir "$($service.Name).process.json") -Encoding UTF8
    Write-Host "[START] $($service.Name) PID=$($process.Id); log: $errLog"
    $timer = [Diagnostics.Stopwatch]::StartNew()
    do {
        $process.Refresh()
        if ($process.HasExited) { throw "$($service.Name) exited ($($process.ExitCode)). See $errLog" }
        $health = Get-ServiceHealth $service
        if ($health) { break }
        Write-Host "[WAIT] $($service.Name): $([int]$timer.Elapsed.TotalSeconds)s"
        Start-Sleep -Seconds 2
    } while ($timer.Elapsed.TotalSeconds -lt 120)
    if (-not $health) { throw "$($service.Name) did not become healthy within 120s. It may still be starting. See $errLog; already started services are left running." }
    Write-Host "[READY] $($service.Name) in $([math]::Round($timer.Elapsed.TotalSeconds, 1))s"
    if ($service.Name -eq 'Embedding') { Write-Host "Device: $($health.device). Models load lazily on the first embedding request." }
}
Write-Host "Ready. Logs: $logDir"
Write-Host 'Next.js .env.local: RAG_INGESTION_URL=http://127.0.0.1:8010 and EMBEDDING_SERVICE_URL=http://0.0.0.1:8020'
Write-Host 'This script does not start Next.js or the workflow service.'
Write-Host 'Stop managed services: stop-rag.cmd (or stop-rag.cmd -Service RAG).'
