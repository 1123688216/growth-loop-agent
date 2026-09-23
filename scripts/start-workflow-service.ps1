$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$serviceRoot = Join-Path $projectRoot 'services\workflow'
$pythonPath = Join-Path $serviceRoot '.venv\Scripts\python.exe'

# Load only workflow/model configuration, without executing dotenv contents or printing secrets.
$configKeys = @('WORKFLOW_SERVICE_TOKEN', 'WORKFLOW_CHECKPOINT_PATH', 'WORKFLOW_LLM_ENABLED', 'WORKFLOW_LLM_BASE_URL', 'WORKFLOW_LLM_API_KEY', 'WORKFLOW_LLM_MODEL', 'LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL')
foreach ($name in @('.env', '.env.local')) {
  $configPath = Join-Path $projectRoot $name
  if (Test-Path -LiteralPath $configPath -PathType Leaf) {
    foreach ($line in Get-Content -LiteralPath $configPath -Encoding UTF8) {
      if ($line -match '^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$' -and $Matches[1] -in $configKeys) {
        $key = $Matches[1]
        $value = $Matches[2].Trim().Trim('"').Trim("'")
        if ($value) { [Environment]::SetEnvironmentVariable($key, $value, 'Process') }
      }
    }
  }
}
foreach ($suffix in @('BASE_URL', 'API_KEY', 'MODEL')) {
  if (-not [Environment]::GetEnvironmentVariable("WORKFLOW_LLM_$suffix")) {
    [Environment]::SetEnvironmentVariable("WORKFLOW_LLM_$suffix", [Environment]::GetEnvironmentVariable("LLM_$suffix"), 'Process')
  }
}

if (-not (Test-Path -LiteralPath $pythonPath -PathType Leaf)) {
  throw 'Workflow virtual environment is missing. Run uv sync in services\workflow first.'
}

Push-Location $serviceRoot
try {
  & $pythonPath -m uvicorn growth_loop_workflow.main:app --host 127.0.0.1 --port 8030
} finally {
  Pop-Location
}
