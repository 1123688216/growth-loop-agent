param(
  [ValidateSet('start', 'stop', 'status', 'install', 'run')]
  [string]$Action = 'run',
  [switch]$Build
)

$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$workspaceParent = Split-Path -Parent $projectRoot

if ([string]::IsNullOrWhiteSpace($env:GROWTH_LOOP_ANDROID_SDK)) {
  $sdkRoot = Join-Path $workspaceParent 'growth-loop-android-sdk'
} else {
  $sdkRoot = $env:GROWTH_LOOP_ANDROID_SDK
}

if ([string]::IsNullOrWhiteSpace($env:GROWTH_LOOP_ANDROID_AVD)) {
  $avdRoot = Join-Path $workspaceParent 'growth-loop-avd'
} else {
  $avdRoot = $env:GROWTH_LOOP_ANDROID_AVD
}

$avdName = 'GrowthLoopDesktop'
$serial = 'emulator-5554'
$adb = Join-Path $sdkRoot 'platform-tools\adb.exe'
$emulator = Join-Path $sdkRoot 'emulator\emulator.exe'
$avdManager = Join-Path $sdkRoot 'cmdline-tools\latest\bin\avdmanager.bat'
$apk = Join-Path $projectRoot 'artifacts\android\growth-loop-debug.apk'

function Require-Tool {
  param(
    [Parameter(Mandatory = $true)] [string]$Path,
    [Parameter(Mandatory = $true)] [string]$Label
  )

  if (-not (Test-Path -LiteralPath $Path)) {
    throw ('Missing {0} at {1}. See docs/ANDROID_BUILD.md.' -f $Label, $Path)
  }
}

function Set-AndroidEnvironment {
  Require-Tool $adb 'adb'
  Require-Tool $emulator 'Android Emulator'
  Require-Tool $avdManager 'avdmanager'

  $env:ANDROID_SDK_ROOT = $sdkRoot
  $env:ANDROID_HOME = $sdkRoot
  $env:ANDROID_AVD_HOME = $avdRoot

  $javaRoot = Join-Path $projectRoot '.android-build\jdk21-extract\jdk-21.0.12+8'
  if (Test-Path -LiteralPath $javaRoot) {
    $env:JAVA_HOME = $javaRoot
  }
}

function Start-DesktopEmulator {
  Set-AndroidEnvironment
  & $adb start-server | Out-Host

  $connected = (& $adb devices) -join "`n"
  if ($connected -match ($serial + '\s+device')) {
    Write-Host ('Emulator ready: ' + $serial) -ForegroundColor Green
    return
  }

  $running = Get-CimInstance -ClassName Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.Name -eq 'emulator.exe' -and $_.CommandLine -like ('*-avd ' + $avdName + '*')
  }
  if (-not $running) {
    Write-Host ('Starting AVD ' + $avdName)
    Start-Process -FilePath $emulator -ArgumentList @(
      '-avd', $avdName,
      '-port', '5554',
      '-no-snapshot',
      '-no-boot-anim',
      '-gpu', 'swiftshader_indirect',
      '-noaudio'
    ) -WorkingDirectory $projectRoot -WindowStyle Normal | Out-Null
  }

  $deadline = (Get-Date).AddSeconds(180)
  do {
    $state = (& $adb -s $serial get-state 2>$null) -join ''
    $boot = (& $adb -s $serial shell getprop sys.boot_completed 2>$null) -join ''
    if ($state -match 'device' -and $boot -match '1') {
      Write-Host ('Emulator booted: ' + $serial) -ForegroundColor Green
      return
    }
    Write-Host '.' -NoNewline
    Start-Sleep -Seconds 5
  } while ((Get-Date) -lt $deadline)

  Write-Host ''
  throw 'The emulator did not finish booting within 180 seconds. Run -Action status for adb details.'
}

function Build-DebugApk {
  Push-Location $projectRoot
  try {
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw 'Next.js build failed.' }

    & npx.cmd cap sync android
    if ($LASTEXITCODE -ne 0) { throw 'Capacitor sync failed.' }

    Push-Location (Join-Path $projectRoot 'android')
    try {
      & .\gradlew.bat assembleDebug --no-daemon
      if ($LASTEXITCODE -ne 0) { throw 'Gradle assembleDebug failed.' }
    } finally {
      Pop-Location
    }
  } finally {
    Pop-Location
  }

  Require-Tool $apk 'debug APK'
}

function Install-DebugApk {
  Require-Tool $apk 'debug APK'
  & $adb -s $serial install -r $apk
  if ($LASTEXITCODE -ne 0) { throw 'APK installation failed.' }
  Write-Host ('APK installed on ' + $serial) -ForegroundColor Green
}

function Launch-GrowthLoop {
  & $adb -s $serial shell am force-stop com.growthloop.agent
  & $adb -s $serial shell monkey -p com.growthloop.agent -c android.intent.category.LAUNCHER 1 | Out-Host
  if ($LASTEXITCODE -ne 0) { throw 'Unable to launch the Android app.' }
  Write-Host 'Growth Loop is running in the desktop emulator.' -ForegroundColor Green
}

Set-AndroidEnvironment
switch ($Action) {
  'status' {
    Write-Host ('SDK: ' + $sdkRoot)
    Write-Host ('AVD: ' + (Join-Path $avdRoot ($avdName + '.avd')))
    & $adb start-server | Out-Host
    & $adb devices
    & $avdManager list avd
  }
  'stop' {
    & $adb -s $serial emu kill 2>$null
    Write-Host 'Emulator stop requested.'
  }
  'start' {
    Start-DesktopEmulator
  }
  'install' {
    if ($Build) { Build-DebugApk }
    Start-DesktopEmulator
    Install-DebugApk
  }
  'run' {
    if ($Build) { Build-DebugApk }
    Start-DesktopEmulator
    Install-DebugApk
    Launch-GrowthLoop
  }
}
