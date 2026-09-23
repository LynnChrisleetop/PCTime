param([switch]$AcceptAndroidSdkLicense)
$ErrorActionPreference = 'Stop'
if (-not $AcceptAndroidSdkLicense) {
    throw 'Read https://developer.android.com/studio/terms, then run with -AcceptAndroidSdkLicense only if you accept the Android SDK license.'
}
$repository = Split-Path $PSScriptRoot -Parent
$toolchain = Join-Path $repository '.artifacts/android-toolchain'
New-Item -ItemType Directory -Path $toolchain -Force | Out-Null
function Get-VerifiedArchive([string]$Uri, [string]$Name, [string]$Sha256) {
    $archive = Join-Path $toolchain $Name
    if (-not (Test-Path -LiteralPath $archive)) {
        Invoke-WebRequest -Uri $Uri -OutFile $archive
    }
    if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $Sha256) {
        throw "Checksum mismatch: $archive. No archive was extracted."
    }
    return $archive
}
$jdkArchive = Get-VerifiedArchive 'https://github.com/adoptium/temurin17-binaries/releases/download/jdk-17.0.20.1%2B1/OpenJDK17U-jdk_x64_windows_hotspot_17.0.20.1_1.zip' 'jdk.zip' 'e53a79c3c3d86865bd7e787903884331068e71321714ffd44f145785affc7cb0'
$javaDirectory = Join-Path $toolchain 'jdk/jdk-17.0.20.1+1'
if (-not (Test-Path -LiteralPath (Join-Path $javaDirectory 'bin/java.exe'))) {
    Expand-Archive -LiteralPath $jdkArchive -DestinationPath (Join-Path $toolchain 'jdk') -Force
}
$gradleArchive = Get-VerifiedArchive 'https://services.gradle.org/distributions/gradle-8.11.1-bin.zip' 'gradle.zip' 'f397b287023acdba1e9f6fc5ea72d22dd63669d59ed4a289a29b1a76eee151c6'
if (-not (Test-Path -LiteralPath (Join-Path $toolchain 'gradle-8.11.1/bin/gradle.bat'))) {
    Expand-Archive -LiteralPath $gradleArchive -DestinationPath $toolchain -Force
}
$sdk = Join-Path $toolchain 'sdk'
$sdkManager = Join-Path $sdk 'cmdline-tools/latest/bin/sdkmanager.bat'
$toolsArchive = Get-VerifiedArchive 'https://dl.google.com/android/repository/commandlinetools-win-15859902_latest.zip' 'cmdtools.zip' '90ae805d20434428bffcb699c290860f19bb5f66a67e6b330067e3de801fb04a'
if (-not (Test-Path -LiteralPath $sdkManager)) {
    $extracted = Join-Path $toolchain 'sdk-tools-extracted'
    Expand-Archive -LiteralPath $toolsArchive -DestinationPath $extracted -Force
    $destination = Join-Path $sdk 'cmdline-tools/latest'
    New-Item -ItemType Directory -Path $destination -Force | Out-Null
    Get-ChildItem -LiteralPath (Join-Path $extracted 'cmdline-tools') | Copy-Item -Destination $destination -Recurse -Force
}
$env:JAVA_HOME = $javaDirectory
$env:ANDROID_HOME = $sdk
# This non-interactive acceptance is enabled only by the explicit license switch.
(1..20 | ForEach-Object { 'y' }) | & $sdkManager "--sdk_root=$sdk" --licenses
if ($LASTEXITCODE -ne 0) { throw 'SDK license processing failed.' }
& $sdkManager "--sdk_root=$sdk" 'platforms;android-35' 'build-tools;35.0.0' 'platform-tools'
if ($LASTEXITCODE -ne 0) { throw 'SDK package installation failed.' }
Write-Output 'Android build dependencies are ready. Run ./android/test.ps1 and ./android/build.ps1.'
