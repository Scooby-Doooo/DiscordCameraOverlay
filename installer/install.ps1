# Installs Equicord with CameraOverlay into Discord. Safe to run again.
# Usage: irm https://github.com/__REPO__/releases/latest/download/install.ps1 | iex
# The release build replaces __REPO__ with this repository.
& {
    $ErrorActionPreference = "Stop"
    # Windows PowerShell's progress bar makes Invoke-WebRequest many times slower
    $ProgressPreference = "SilentlyContinue"
    $discordDir = "$env:LOCALAPPDATA\Discord"
    $dataDir = "$env:APPDATA\Equicord"

    # Newest app-* folder by version number, not by name (app-1.0.10000 sorts before app-1.0.9265 as text)
    $app = Get-ChildItem $discordDir -Directory -Filter "app-*" -ErrorAction SilentlyContinue |
        Sort-Object { [version]($_.Name -replace "^app-") } -Descending |
        Select-Object -First 1
    if (-not $app) { throw "Discord is not installed in $discordDir" }

    Write-Host "Downloading Equicord with CameraOverlay..."
    New-Item -ItemType Directory -Force "$dataDir\settings" | Out-Null
    # Not %TEMP%: with a non-Latin user name it can be an 8.3 path (C:\Users\5B3B~1\...) that Move-Item fails to resolve
    $download = "$dataDir\equicord.asar.download"
    Invoke-WebRequest "https://github.com/__REPO__/releases/latest/download/desktop.asar" -OutFile $download -UseBasicParsing

    # Discord keeps the asar open while running
    $running = Get-Process Discord -ErrorAction SilentlyContinue
    if ($running) { $running | Stop-Process -Force; Start-Sleep -Seconds 3 }

    [IO.File]::Copy($download, "$dataDir\equicord.asar", $true)
    [IO.File]::Delete($download)

    # Turn the plugin and auto-update on: updates come from this repository's releases, which include the plugin
    $settingsFile = "$dataDir\settings\settings.json"
    $settings = [pscustomobject]@{}
    if (Test-Path $settingsFile) {
        $raw = Get-Content $settingsFile -Raw -Encoding UTF8
        if ($raw) {
            Copy-Item $settingsFile "$settingsFile.before-cameraoverlay" -Force
            $settings = ConvertFrom-Json $raw
        }
    }
    # Earlier versions of this installer turned these off
    $settings | Add-Member autoUpdate $true -Force
    $settings | Add-Member autoUpdateNotification $true -Force
    if (-not $settings.plugins) { $settings | Add-Member plugins ([pscustomobject]@{}) -Force }
    if (-not $settings.plugins.CameraOverlay) { $settings.plugins | Add-Member CameraOverlay ([pscustomobject]@{}) -Force }
    $settings.plugins.CameraOverlay | Add-Member enabled $true -Force
    # WriteAllText: no BOM, which Node's JSON.parse rejects
    [IO.File]::WriteAllText($settingsFile, (ConvertTo-Json -InputObject $settings -Depth 100))

    $resources = Join-Path $app.FullName "resources"
    $asar = Join-Path $resources "app.asar"
    # An unpatched install has app.asar as a file; keep it as _app.asar, which Equicord loads Discord from
    if (Test-Path $asar -PathType Leaf) {
        if (Test-Path "$resources\_app.asar") { throw "Both app.asar and _app.asar exist in $resources, not touching anything." }
        Rename-Item $asar "_app.asar"
    }
    New-Item -ItemType Directory -Force $asar | Out-Null
    $requirePath = "$dataDir\equicord.asar\patcher.js".Replace("\", "\\")
    [IO.File]::WriteAllText("$asar\index.js", "require(`"$requirePath`");")
    [IO.File]::WriteAllText("$asar\package.json", '{"name":"discord","main":"index.js"}')

    Write-Host "Done: Equicord with CameraOverlay is installed into Discord $($app.Name -replace '^app-')."
    Start-Process "$discordDir\Update.exe" -ArgumentList "--processStart", "Discord.exe"
}
