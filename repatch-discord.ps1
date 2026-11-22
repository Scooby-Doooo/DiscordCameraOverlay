# Points the newest Discord install at the locally built Equicord again.
# Run it after a Discord update: each update unpacks a fresh app-* folder without the patch.
param(
    [string]$DiscordDir = "$env:LOCALAPPDATA\Discord",
    [string]$EquicordDist = (Join-Path $PSScriptRoot "..\Equicord\dist\desktop"),
    [switch]$NoRestart
)

$ErrorActionPreference = "Stop"

$patcher = Join-Path (Resolve-Path $EquicordDist) "patcher.js"
if (-not (Test-Path $patcher)) { throw "No Equicord build at $patcher. Run 'pnpm build' in the Equicord folder first." }

# Newest app-* folder by version number, not by name (app-1.0.10000 sorts before app-1.0.9265 as text)
$app = Get-ChildItem $DiscordDir -Directory -Filter "app-*" |
    Sort-Object { [version]($_.Name -replace "^app-") } -Descending |
    Select-Object -First 1
if (-not $app) { throw "No app-* folder in $DiscordDir" }
$resources = Join-Path $app.FullName "resources"
$asar = Join-Path $resources "app.asar"
$original = Join-Path $resources "_app.asar"

$running = Get-Process Discord -ErrorAction SilentlyContinue
if ($running -and -not $NoRestart) {
    $running | Stop-Process -Force
    Start-Sleep -Seconds 3
}

# An unpatched install has app.asar as a file; keep it as _app.asar, which Equicord loads Discord from
if (Test-Path $asar -PathType Leaf) {
    if (Test-Path $original) { throw "Both app.asar and _app.asar exist in $resources, not touching anything." }
    Rename-Item $asar "_app.asar"
}
New-Item -ItemType Directory -Force $asar | Out-Null

$requirePath = $patcher.Replace("\", "\\")
# WriteAllText: no BOM, which Node would otherwise choke on in package.json
[IO.File]::WriteAllText((Join-Path $asar "index.js"), "require(`"$requirePath`");")
[IO.File]::WriteAllText((Join-Path $asar "package.json"), '{"name":"discord","main":"index.js"}')

Write-Host "Patched $($app.Name) -> $patcher"

if (-not $NoRestart) {
    Start-Process (Join-Path $DiscordDir "Update.exe") -ArgumentList "--processStart", "Discord.exe"
    Write-Host "Discord restarted."
}
