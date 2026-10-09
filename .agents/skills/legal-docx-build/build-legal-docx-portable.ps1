param(
    [Parameter(Mandatory = $true, Position = 0)] [string[]] $Source,
    [Parameter(Mandatory = $true, Position = 1)] [string] $Output
)

$ErrorActionPreference = 'Stop'
$scriptPath = Join-Path $PSScriptRoot 'build-legal-docx-portable.py'
if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) { throw 'WSL is required for the portable DOCX renderer.' }

function To-WslPath([string] $value) {
    $resolved = [System.IO.Path]::GetFullPath($value)
    return (& wsl.exe -d Ubuntu -- wslpath -a $resolved).Trim()
}

$wslScript = To-WslPath $scriptPath
$wslSources = @($Source | ForEach-Object { To-WslPath $_ })
$wslOutput = To-WslPath $Output
& wsl.exe -d Ubuntu -- python3 $wslScript @wslSources $wslOutput
if ($LASTEXITCODE -ne 0) { throw "Portable DOCX rendering failed with exit code $LASTEXITCODE." }
