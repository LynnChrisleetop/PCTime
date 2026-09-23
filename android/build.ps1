param([string]$JavaHome = $env:JAVA_HOME, [string]$AndroidHome = $env:ANDROID_HOME)
$ErrorActionPreference = 'Stop'
$repository = Split-Path $PSScriptRoot -Parent
$toolchain = Join-Path $repository '.artifacts/android-toolchain'
if (-not $JavaHome) {
    $candidate = Get-ChildItem -Path (Join-Path $toolchain 'jdk/*') -Directory -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($candidate) { $JavaHome = $candidate.FullName }
}
if (-not $AndroidHome) { $AndroidHome = Join-Path $toolchain 'sdk' }
if (-not $JavaHome -or -not (Test-Path -LiteralPath (Join-Path $JavaHome 'bin/java.exe'))) { throw 'JDK 17 is required; set JAVA_HOME.' }
if (-not (Test-Path -LiteralPath (Join-Path $AndroidHome 'platforms/android-35/android.jar'))) { throw 'Install Android SDK platform 35 and build-tools 35.0.0 after accepting the SDK license.' }
$gradle = Join-Path $toolchain 'gradle-8.11.1/bin/gradle.bat'
if (-not (Test-Path -LiteralPath $gradle)) { throw 'Gradle 8.11.1 is required under .artifacts/android-toolchain.' }
$env:JAVA_HOME = $JavaHome
$env:ANDROID_HOME = $AndroidHome
$env:GRADLE_USER_HOME = Join-Path $repository '.artifacts/g'
& $gradle -p $PSScriptRoot --no-daemon --no-watch-fs :app:assembleDebug :app:lintDebug
if ($LASTEXITCODE -ne 0) { throw 'Android build or lint failed' }
$output = Join-Path $repository '.artifacts/android'
New-Item -ItemType Directory -Path $output -Force | Out-Null
$apk = Join-Path $PSScriptRoot 'app/build/outputs/apk/debug/app-debug.apk'
& (Join-Path $AndroidHome 'build-tools/35.0.0/apksigner.bat') verify --verbose $apk
if ($LASTEXITCODE -ne 0) { throw 'Android APK signature verification failed' }
Copy-Item -LiteralPath $apk -Destination (Join-Path $output 'PCTime-Android-debug.apk') -Force
$version = (Get-Content -LiteralPath (Join-Path $repository 'package.json') -Raw | ConvertFrom-Json).version
$release = Join-Path $repository "release/$version"
New-Item -ItemType Directory -Path $release -Force | Out-Null
$releaseApk = Join-Path $release "PCTime-Android-$version-debug.apk"
Copy-Item -LiteralPath $apk -Destination $releaseApk -Force
Get-FileHash -Algorithm SHA256 -LiteralPath $releaseApk
