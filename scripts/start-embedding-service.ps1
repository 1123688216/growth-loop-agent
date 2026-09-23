$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$serviceDirectory = Join-Path $projectRoot "services\embedding"
$pythonPath = if ($env:EMBEDDING_PYTHON) { $env:EMBEDDING_PYTHON } else { "G:\MinerU\.venv\Scripts\python.exe" }

if (-not (Test-Path -LiteralPath $pythonPath -PathType Leaf)) {
  throw "Embedding Python not found: $pythonPath. Set EMBEDDING_PYTHON to a compatible Python executable."
}
if (-not $env:EMBEDDING_DEVICE) { $env:EMBEDDING_DEVICE = "auto" }

Push-Location $serviceDirectory
try {
  & $pythonPath -m uvicorn growth_loop_embedding.main:app --host 127.0.0.1 --port 8020
} finally {
  Pop-Location
}
