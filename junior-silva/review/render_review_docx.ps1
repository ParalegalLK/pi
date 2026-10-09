param(
    [Parameter(Mandatory = $true)] [string] $Findings,
    [Parameter(Mandatory = $true)] [string] $Output,
    [string] $Source,
    [string] $SourceText,
    [string] $Title = 'Sri Lankan Legal Review',
    [string] $Perspective = ''
)

$ErrorActionPreference = 'Stop'
$scriptPath = Join-Path $PSScriptRoot 'render_review_docx.py'
function To-WslPath([string] $value) {
    $full = [System.IO.Path]::GetFullPath($value)
    if ($full -match '^([A-Za-z]):\\(.*)$') {
        return ('/mnt/' + $Matches[1].ToLowerInvariant() + '/' + ($Matches[2] -replace '\\', '/'))
    }
    throw "Cannot map this Windows path into WSL: $full"
}
$arguments = @((To-WslPath $scriptPath), '--findings', (To-WslPath $Findings), '--output', (To-WslPath $Output), '--title', $Title, '--perspective', $Perspective)
if ($Source) { $arguments += @('--source', (To-WslPath $Source)) }
if ($SourceText) { $arguments += @('--source-text', (To-WslPath $SourceText)) }
& wsl.exe -d Ubuntu -- python3 @arguments
if ($LASTEXITCODE -ne 0) { throw "Native review rendering failed with exit code $LASTEXITCODE." }
