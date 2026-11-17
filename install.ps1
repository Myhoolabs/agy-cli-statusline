$ErrorActionPreference = "Stop"

function Write-Step {
    param([string]$Message)
    Write-Host "[agy-cli-statusline] $Message" -ForegroundColor Cyan
}

function Get-ShortPath {
    param([string]$TargetPath)
    if ([string]::IsNullOrWhiteSpace($TargetPath) -or -not (Test-Path -LiteralPath $TargetPath)) {
        return $TargetPath
    }
    if ($TargetPath -notmatch '\s') {
        return $TargetPath
    }
    $cmdLine = 'for %I in ("' + $TargetPath + '") do @echo %~sI'
    $short = (& cmd.exe /c $cmdLine 2>$null | Select-Object -First 1)
    if ($short -and -not [string]::IsNullOrWhiteSpace($short)) {
        return $short.Trim()
    }
    return $TargetPath
}

function Write-Utf8NoBom {
    param(
        [string]$Path,
        [string]$Content
    )
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $Content, $utf8NoBom)
}

# 1. Check Node.js and npx
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    throw "Node.js not found in PATH. Please install Node.js (v20+ recommended) first."
}
$npxCmd = Get-Command npx -ErrorAction SilentlyContinue
if (-not $npxCmd) {
    throw "npx not found in PATH. Please make sure npm/npx is installed with Node.js."
}

$nodePath = $nodeCmd.Source
$nodeShortPath = Get-ShortPath -TargetPath $nodePath
Write-Step "Node.js: $nodePath (short: $nodeShortPath)"

# 2. Initialize / upgrade agy-powerline
Write-Step "Running npx -y agy-powerline@latest init --yes ..."
& npx -y agy-powerline@latest init --yes
if ($LASTEXITCODE -ne 0) {
    throw "agy-powerline init failed with exit code $LASTEXITCODE."
}

# 3. Deploy turn-elapsed.js
$installDir = Join-Path $env:USERPROFILE ".agy-powerline"
if (-not (Test-Path -LiteralPath $installDir)) {
    New-Item -ItemType Directory -Path $installDir -Force | Out-Null
}

$srcTurnScript = Join-Path $PSScriptRoot "turn-elapsed.js"
$dstTurnScript = Join-Path $installDir "turn-elapsed.js"
if (-not (Test-Path -LiteralPath $srcTurnScript)) {
    throw "Missing source file: $srcTurnScript"
}
if (Test-Path -LiteralPath $dstTurnScript) {
    Copy-Item -LiteralPath $dstTurnScript -Destination "$dstTurnScript.bak" -Force
}
Copy-Item -LiteralPath $srcTurnScript -Destination $dstTurnScript -Force
$turnShortPath = Get-ShortPath -TargetPath $dstTurnScript
Write-Step "Installed turn-elapsed.js -> $dstTurnScript"

# 4. Generate statusline.config.json with machine-local short paths
$srcConfig = Join-Path $PSScriptRoot "statusline.config.json"
$dstConfig = Join-Path $installDir "statusline.config.json"
if (-not (Test-Path -LiteralPath $srcConfig)) {
    throw "Missing source file: $srcConfig"
}
if (Test-Path -LiteralPath $dstConfig) {
    Copy-Item -LiteralPath $dstConfig -Destination "$dstConfig.bak" -Force
}

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$templateText = [System.IO.File]::ReadAllText($srcConfig, $utf8NoBom)
$execCmdValue = "$nodeShortPath $turnShortPath"
$escapedExecCmd = $execCmdValue.Replace('\', '\\').Replace('"', '\"')
$updatedConfigText = ([regex]'"cmd"\s*:\s*"[^"]*"').Replace(
    $templateText,
    { param($m) '"cmd": "' + $escapedExecCmd + '"' },
    1
)

# Validate JSON before writing
$null = $updatedConfigText | ConvertFrom-Json
Write-Utf8NoBom -Path $dstConfig -Content $updatedConfigText
Write-Step "Installed statusline.config.json (exec cmd: $execCmdValue)"

# 5. Verify / update ~/.gemini/antigravity-cli/settings.json
$agyDir = Join-Path $env:USERPROFILE ".gemini\antigravity-cli"
$settingsPath = Join-Path $agyDir "settings.json"
$launcherShortPath = Get-ShortPath -TargetPath (Join-Path $installDir "statusline.cmd")
$expectedCommand = $launcherShortPath -replace '\\', '/'

if (-not (Test-Path -LiteralPath $agyDir)) {
    New-Item -ItemType Directory -Path $agyDir -Force | Out-Null
}

if (Test-Path -LiteralPath $settingsPath) {
    $rawSettings = [System.IO.File]::ReadAllText($settingsPath, $utf8NoBom)
    $settingsObj = if ([string]::IsNullOrWhiteSpace($rawSettings)) {
        [PSCustomObject]@{}
    } else {
        $rawSettings | ConvertFrom-Json
    }
    $currentType = $settingsObj.statusLine.type
    $currentCommand = $settingsObj.statusLine.command
    if ($currentType -ne "command" -or $currentCommand -ne $expectedCommand) {
        Copy-Item -LiteralPath $settingsPath -Destination "$settingsPath.agy-cli-statusline.bak" -Force
        $statusLineObj = [PSCustomObject]@{
            type    = "command"
            command = $expectedCommand
        }
        if ($null -eq $settingsObj.PSObject.Properties["statusLine"]) {
            $settingsObj | Add-Member -NotePropertyName "statusLine" -NotePropertyValue $statusLineObj
        } else {
            $settingsObj.statusLine = $statusLineObj
        }
        $jsonOut = ($settingsObj | ConvertTo-Json -Depth 16) + "`n"
        Write-Utf8NoBom -Path $settingsPath -Content $jsonOut
        Write-Step "Updated statusLine in $settingsPath -> $expectedCommand"
    } else {
        Write-Step "Verified statusLine in $settingsPath -> $expectedCommand"
    }
} else {
    $settingsObj = [PSCustomObject]@{
        statusLine = [PSCustomObject]@{
            type    = "command"
            command = $expectedCommand
        }
    }
    $jsonOut = ($settingsObj | ConvertTo-Json -Depth 16) + "`n"
    Write-Utf8NoBom -Path $settingsPath -Content $jsonOut
    Write-Step "Created $settingsPath with statusLine -> $expectedCommand"
}

# 6. Run agy-powerline doctor
Write-Step "Running npx -y agy-powerline doctor ..."
& npx -y agy-powerline doctor
if ($LASTEXITCODE -ne 0) {
    throw "agy-powerline doctor failed with exit code $LASTEXITCODE."
}

Write-Step "Done! Restart or open a new agy session to see the statusline."
