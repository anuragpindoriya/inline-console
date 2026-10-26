# Builds build\inline-console.zip (install via Settings > Plugins > gear > Install Plugin from Disk).
# ponytail: plain javac against a local WebStorm instead of Gradle; switch to the IntelliJ Platform
# Gradle Plugin when this needs CI, tests against several IDE versions, or Marketplace publishing.
param([string]$Ide = $env:WEBSTORM_HOME)
$ErrorActionPreference = 'Stop'

if (-not $Ide) {
    # newest installed WebStorm; its product-info.json says which product and build a folder holds
    $Ide = Get-ChildItem "$env:ProgramFiles\JetBrains", "$env:LOCALAPPDATA\Programs" -Directory -ErrorAction SilentlyContinue |
        Where-Object { Test-Path (Join-Path $_.FullName 'product-info.json') } |
        ForEach-Object {
            $info = Get-Content (Join-Path $_.FullName 'product-info.json') -Raw | ConvertFrom-Json
            if ($info.productCode -eq 'WS') { [pscustomobject]@{ Path = $_.FullName; Build = [version]$info.buildNumber } }
        } |
        Sort-Object Build -Descending | Select-Object -First 1 -ExpandProperty Path
    if (-not $Ide) { throw "No WebStorm found. Pass -Ide '<WebStorm folder>' or set WEBSTORM_HOME." }
}
Write-Host "Compiling against $Ide"

$out = Join-Path $PSScriptRoot 'build'
$classes = Join-Path $out 'classes'
$pluginDir = Join-Path $out 'inline-console'
if (Test-Path $out) { Remove-Item -Recurse -Force $out }

$sources = (Get-ChildItem -Recurse (Join-Path $PSScriptRoot 'src') -Filter *.java).FullName
& javac --release 25 -proc:none -nowarn -encoding UTF-8 -cp "$Ide\lib\*" -d $classes @sources
if ($LASTEXITCODE -ne 0) { throw "javac failed" }
& java -cp "$classes;$Ide\lib\*" dev.inlineconsole.AutoConnect
if ($LASTEXITCODE -ne 0) { throw "AutoConnect self-check failed" }

Copy-Item -Recurse (Join-Path $PSScriptRoot 'resources\*') $classes
New-Item -ItemType Directory -Force (Join-Path $pluginDir 'lib') | Out-Null
& jar --create --file (Join-Path $pluginDir 'lib\inline-console.jar') -C $classes .
if ($LASTEXITCODE -ne 0) { throw "jar failed" }
# the npm package's files ride along: Vite auto-connect imports js/auto.mjs straight from the plugin folder
New-Item -ItemType Directory -Force (Join-Path $pluginDir 'js') | Out-Null
Get-ChildItem (Join-Path $PSScriptRoot '..\js\*') -File -Exclude 'test.cjs', '*.tgz' | Copy-Item -Destination (Join-Path $pluginDir 'js')

Compress-Archive -Path $pluginDir -DestinationPath (Join-Path $out 'inline-console.zip')
Write-Host "Built $(Join-Path $out 'inline-console.zip')"
