param(
    [ValidateSet('Init', 'Check', 'Start', 'Stop', 'Status', 'Logs')]
    [string]$Action = 'Start',
    [ValidateRange(15, 900)] [int]$WaitSeconds = 300
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$projectRoot = (Resolve-Path -LiteralPath (Split-Path -Parent $PSScriptRoot)).ProviderPath
$deployDir = Join-Path $projectRoot 'deploy\ragflow'
$envPath = Join-Path $deployDir '.env'
$composePath = Join-Path $deployDir 'compose.yaml'
$stackName = 'growth-loop-ragflow'
if (-not (Test-Path -LiteralPath $composePath -PathType Leaf)) { throw 'RAGFlow compose file is missing.' }

function New-LocalSecret {
    $bytes = New-Object byte[] 32
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    return ([BitConverter]::ToString($bytes)).Replace('-', '').ToLowerInvariant()
}

function Invoke-Stack([string[]]$DockerArguments) {
    & docker compose --project-name $stackName --project-directory $deployDir --env-file $envPath -f $composePath @DockerArguments
    if ($LASTEXITCODE -ne 0) { throw "Docker Compose failed ($LASTEXITCODE). Existing data was not deleted." }
}

Get-Command docker -ErrorAction Stop | Out-Null
if (-not (Test-Path -LiteralPath $envPath -PathType Leaf)) {
    if ($Action -notin @('Init', 'Start')) { throw 'Run start-ragflow.cmd -Action Init first.' }
    # Never invent new credentials for existing volumes after losing the env file.
    $ownedVolumes = @(& docker volume ls --filter "label=com.docker.compose.project=$stackName" --format '{{.Name}}')
    if ($LASTEXITCODE -ne 0) { throw 'Start Docker Desktop first.' }
    if ($ownedVolumes.Count -gt 0) { throw 'Existing RAGFlow volumes found but .env is missing. Restore its backup; credentials were not regenerated.' }
    $values = @('RAGFLOW_WEB_PORT=8088', 'REGISTER_ENABLED=1')
    foreach ($key in @('MYSQL_ROOT_PASSWORD', 'MYSQL_PASSWORD', 'ELASTIC_PASSWORD', 'MINIO_PASSWORD', 'REDIS_PASSWORD', 'RAGFLOW_SECRET_KEY')) {
        $values += "$key=$(New-LocalSecret)"
    }
    # CreateNew refuses to overwrite a concurrent setup or an existing secret file.
    $stream = [IO.File]::Open($envPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
        $bytes = [Text.Encoding]::UTF8.GetBytes(($values -join "`n") + "`n")
        $stream.Write($bytes, 0, $bytes.Length)
    } finally { $stream.Dispose() }
    Write-Host '[INIT] Created private deployment .env; credentials are not printed.'
}

$port = 8088
foreach ($line in Get-Content -LiteralPath $envPath -Encoding UTF8) {
    if ($line -match '^RAGFLOW_WEB_PORT=(\d+)$') { $port = [int]$Matches[1] }
    if ($line -match '=GENERATE_ME$') { throw 'Placeholder credentials found. Use the initializer, not the example passwords.' }
}
if ($port -lt 1024 -or $port -gt 65535) { throw 'RAGFLOW_WEB_PORT must be between 1024 and 65535.' }
$baseUrl = "http://127.0.0.1:$port"
Invoke-Stack -DockerArguments @('config', '--quiet')

switch ($Action) {
    'Init' { Write-Host '[OK] Deployment configuration initialized. No containers started.'; exit 0 }
    'Check' {
        & docker info --format 'Docker: memory={{.MemTotal}} bytes; CPUs={{.NCPU}}'
        if ($LASTEXITCODE -ne 0) { throw 'Docker engine is unavailable.' }
        Invoke-Stack -DockerArguments @('config', '--images')
        Write-Host "[OK] Compose valid. Local endpoint: $baseUrl. No containers started."
        exit 0
    }
    'Status' { Invoke-Stack -DockerArguments @('ps', '--all'); exit 0 }
    'Logs' { Invoke-Stack -DockerArguments @('logs', '--tail', '80', 'ragflow'); exit 0 }
    'Stop' {
        Invoke-Stack -DockerArguments @('stop', '--timeout', '30')
        Write-Host '[STOP] Only growth-loop-ragflow containers stopped. Volumes, images and other stacks preserved.'
        exit 0
    }
}

# Only an already owned stack may occupy our configured web port.
$listener = New-Object Net.Sockets.TcpClient
$occupied = $false
try { $occupied = $listener.ConnectAsync('127.0.0.1', $port).Wait(500) -and $listener.Connected } catch { } finally { $listener.Dispose() }
if ($occupied) {
    $owned = @(& docker ps --filter "label=com.docker.compose.project=$stackName" --filter 'label=com.docker.compose.service=ragflow' --format '{{.Ports}}')
    if ($LASTEXITCODE -ne 0) { throw 'Cannot check port ownership.' }
    if (-not ($owned -match "127\.0\.0\.1:$port->80/tcp")) { throw "Port $port belongs to another service. Change RAGFLOW_WEB_PORT; nothing was stopped." }
}
Write-Host '[START] Starting isolated RAGFlow stack. Missing dependency images may be downloaded.'
Invoke-Stack -DockerArguments @('up', '-d', '--pull', 'missing')
$timer = [Diagnostics.Stopwatch]::StartNew()
do {
    try {
        $health = Invoke-RestMethod -Uri "$baseUrl/api/v1/system/healthz" -TimeoutSec 10
        if ($health.status -eq 'ok' -and $health.db -eq 'ok' -and $health.redis -eq 'ok' -and $health.doc_engine -eq 'ok' -and $health.storage -eq 'ok') {
            Write-Host "[READY] RAGFlow: $baseUrl (database / search / storage / queue healthy)."
            Write-Host 'Create your RAGFlow account in the browser. MinerU/Qwen and the learning application are not connected yet.'
            exit 0
        }
    } catch { }
    Write-Host "[WAIT] RAGFlow initialization: $([int]$timer.Elapsed.TotalSeconds)s."
    Start-Sleep -Seconds 5
} while ($timer.Elapsed.TotalSeconds -lt $WaitSeconds)
throw 'Startup not verified before timeout. Containers are left intact. Run start-ragflow.cmd -Action Status or -Action Logs; stop-ragflow.cmd preserves data.'
