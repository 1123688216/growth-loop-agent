param(
  [ValidateSet('doctor', 'build', 'install', 'run', 'smoke', 'logs')]
  [string]$Action = 'doctor',
  [switch]$Build,
  [switch]$ClearData,
  [switch]$Follow
)

$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$workspaceParent = Split-Path -Parent $projectRoot
$helper = Join-Path $projectRoot 'scripts\android-emulator.ps1'
$probe = Join-Path $projectRoot 'scripts\debug-apk-cdp.mjs'
$apk = Join-Path $projectRoot 'artifacts\android\growth-loop-debug.apk'
$serial = 'emulator-5554'
$packageName = 'com.growthloop.agent'

if ([string]::IsNullOrWhiteSpace($env:GROWTH_LOOP_ANDROID_SDK)) {
  $sdkRoot = Join-Path $workspaceParent 'growth-loop-android-sdk'
} else {
  $sdkRoot = $env:GROWTH_LOOP_ANDROID_SDK
}

$adb = Join-Path $sdkRoot 'platform-tools\adb.exe'

function Require-Path {
  param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Label)
  if (-not (Test-Path -LiteralPath $Path)) { throw "[$Label] missing: $Path" }
}

function Invoke-AndroidHelper {
  param([Parameter(Mandatory = $true)][string]$HelperAction, [switch]$WithBuild)
  $args = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $helper, '-Action', $HelperAction)
  if ($WithBuild) { $args += '-Build' }
  & powershell.exe @args
  if ($LASTEXITCODE -ne 0) { throw "android-emulator.ps1 $HelperAction failed." }
}

function Set-AndroidEnvironment {
  Require-Path $adb 'adb'
  $env:ANDROID_SDK_ROOT = $sdkRoot
  $env:ANDROID_HOME = $sdkRoot
}

function Assert-Emulator {
  Set-AndroidEnvironment
  & $adb start-server | Out-Host
  $state = (& $adb -s $serial get-state 2>$null) -join ''
  if ($state -notmatch 'device') { Invoke-AndroidHelper -HelperAction 'start' }
}

function Invoke-ClearData {
  if ($ClearData) {
    Write-Host "[APK-DEBUG] clearing local data for $packageName" -ForegroundColor Yellow
    & $adb -s $serial shell pm clear $packageName | Out-Host
  }
}

function Check-Backend {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:3000/' -TimeoutSec 4
    Write-Host "[APK-DEBUG] local backend HTTP $($response.StatusCode)" -ForegroundColor Green
  } catch {
    Write-Warning '[APK-DEBUG] http://127.0.0.1:3000/ is not reachable; start npm.cmd run start before debugging.'
  }
}

function Show-Doctor {
  Write-Host '[APK-DEBUG] Growth Loop Android doctor' -ForegroundColor Cyan
  Write-Host "[APK-DEBUG] project: $projectRoot"
  Write-Host "[APK-DEBUG] sdk:     $sdkRoot"
  Require-Path $adb 'adb'
  Require-Path $apk 'debug APK'
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'node is required for the CDP smoke check.' }
  $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $apk).Hash
  Write-Host "[APK-DEBUG] apk:     $apk"
  Write-Host "[APK-DEBUG] sha256:  $hash"
  Check-Backend
  & $adb start-server | Out-Host
  & $adb devices
  $foreground = (& $adb -s $serial shell dumpsys activity activities 2>$null | Select-String 'mResumedActivity' | Select-Object -First 1)
  if ($foreground) { Write-Host "[APK-DEBUG] foreground: $foreground" }
  Write-Host '[APK-DEBUG] next: -Action run -Build, then -Action smoke and -Action logs.'
}

function Show-Logs {
  Assert-Emulator
  $lines = if ($Follow) { & $adb -s $serial logcat } else { & $adb -s $serial logcat -d -t 800 }
  $interesting = $lines | Where-Object {
    $_ -match 'FATAL EXCEPTION|chromium|AndroidRuntime|Console|Uncaught|TypeError|ReferenceError|SyntaxError|com\.growthloop\.agent' -and
    $_ -notmatch 'ImeTracker|GoogleInputMethodService|AndroidIME|PackageConfigPersister|CoreBackPreview|ImeInsetsSourceProvider'
  }
  if ($interesting) { $interesting | Select-Object -Last 120 } else { Write-Host '[APK-DEBUG] no fatal/Chromium/JS errors found.' -ForegroundColor Green }
}

Set-AndroidEnvironment
switch ($Action) {
  'doctor' { Show-Doctor }
  'build' { Invoke-AndroidHelper -HelperAction 'run' -WithBuild; Write-Host "[APK-DEBUG] APK built: $apk" -ForegroundColor Green }
  'install' {
    if ($Build) { Invoke-AndroidHelper -HelperAction 'install' -WithBuild } else { Invoke-AndroidHelper -HelperAction 'install' }
    Invoke-ClearData
    Write-Host '[APK-DEBUG] APK installed; use -Action run to launch.' -ForegroundColor Green
  }
  'run' {
    if ($Build) { Invoke-AndroidHelper -HelperAction 'run' -WithBuild } else { Invoke-AndroidHelper -HelperAction 'run' }
    Invoke-ClearData
    Write-Host '[APK-DEBUG] app launched; emulator backend URL is http://10.0.2.2:3000/.' -ForegroundColor Green
  }
  'smoke' {
    Assert-Emulator
    $webViewPid = (& $adb -s $serial shell pidof $packageName).Trim()
    if ([string]::IsNullOrWhiteSpace($webViewPid)) { throw "process $packageName not found; run -Action run first." }
    & $adb -s $serial forward --remove tcp:9222 2>$null
    & $adb -s $serial forward tcp:9222 "localabstract:webview_devtools_remote_$webViewPid"
    if ($LASTEXITCODE -ne 0) { throw 'failed to forward WebView CDP port 9222.' }
    & node $probe
    if ($LASTEXITCODE -ne 0) { throw 'CDP smoke check failed.' }
  }
  'logs' { Show-Logs }
}
