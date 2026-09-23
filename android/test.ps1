param([string]$JavaHome = $env:JAVA_HOME)
$ErrorActionPreference = 'Stop'
$project = $PSScriptRoot
$repository = Split-Path $project -Parent
if (-not $JavaHome) {
    $candidate = Get-ChildItem -Path (Join-Path $repository '.artifacts/android-toolchain/jdk/*') -Directory -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($candidate) { $JavaHome = $candidate.FullName }
}
if (-not $JavaHome -or -not (Test-Path -LiteralPath (Join-Path $JavaHome 'bin/javac.exe'))) { throw 'JDK 17 is required; set JAVA_HOME.' }
$output = Join-Path $repository '.artifacts/android-tests'
New-Item -ItemType Directory -Path $output -Force | Out-Null
& (Join-Path $JavaHome 'bin/javac.exe') -encoding UTF-8 -d $output (Join-Path $project 'app/src/main/java/com/pctime/android/UsageIntervals.java') (Join-Path $project 'tests/UsageIntervalsTest.java')
if ($LASTEXITCODE -ne 0) { throw 'Java compilation failed' }
& (Join-Path $JavaHome 'bin/java.exe') -cp $output UsageIntervalsTest
if ($LASTEXITCODE -ne 0) { throw 'Interval tests failed' }
