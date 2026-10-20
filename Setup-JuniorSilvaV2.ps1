param(
    [ValidateSet('Native', 'Docker')]
    [string]$Mode = 'Native',
    [switch]$Launch,
    [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

function Require-Command([string]$Name, [string]$Purpose) {
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Missing $Name. $Purpose"
    }
}

function Read-EnvironmentFile {
    $pairs = @{}
    Get-Content -LiteralPath '.env' | ForEach-Object {
        $line = $_.Trim()
        if ($line -and -not $line.StartsWith('#') -and $line.Contains('=')) {
            $name, $value = $line.Split('=', 2)
            $pairs[$name.Trim()] = $value.Trim().Trim('"').Trim("'")
        }
    }
    return $pairs
}

function Has-ConfiguredValue($Pairs, [string]$Name) {
    $value = [string]$Pairs[$Name]
    return -not [string]::IsNullOrWhiteSpace($value) -and $value -notmatch '^<.*>$' -and $value -notmatch '^(YOUR_|CHANGE_ME)'
}

Require-Command git 'Install Git, then reopen PowerShell.'

if (-not (Test-Path -LiteralPath '.env')) {
    Copy-Item -LiteralPath '.env.example' -Destination '.env'
    Write-Host 'Created .env from .env.example.'
    Write-Host 'Add a provider key and authorised service credentials to .env, then run this command again.'
    exit 0
}

$pairs = Read-EnvironmentFile
$provider = if ($pairs['PI_PROVIDER']) { $pairs['PI_PROVIDER'] } else { 'google' }
$providerKey = if ($provider -eq 'anthropic') { 'ANTHROPIC_API_KEY' } elseif ($provider -eq 'google') { 'GEMINI_API_KEY' } else { $null }
if (-not $providerKey) { throw "Unsupported PI_PROVIDER '$provider'. Configure a supported provider and its key in .env." }
if (-not (Has-ConfiguredValue $pairs $providerKey)) { throw "Set $providerKey in .env before starting Pi." }

if ($Mode -eq 'Native') {
    Require-Command node 'Install Node.js 24 or later, then reopen PowerShell.'
    Require-Command npm 'Install the npm package manager with Node.js.'

    if (-not $SkipBuild) {
        npm ci --ignore-scripts
        npm run hydrate:model-data
        npm run build:offline
        npm --prefix junior-silva ci --omit=dev --ignore-scripts
    }

    if ($Launch) {
        & (Join-Path $PSScriptRoot 'Start-JuniorSilvaV2.ps1')
    } else {
        Write-Host 'Native setup is complete. Start Pi with: .\Start-JuniorSilvaV2.ps1'
    }
    Write-Host 'For full native document/review tooling, install host dependencies or use Docker/WSL. See LOCAL_CLI_SETUP.md.'
    exit 0
}

Require-Command docker 'Install Docker Desktop or Docker Engine with Compose, then reopen PowerShell.'
& docker compose version | Out-Null
$librechatNetwork = if ($pairs['LIBRECHAT_NETWORK']) { $pairs['LIBRECHAT_NETWORK'] } else { 'librechat_default' }
$ragNetwork = if ($pairs['RAG_NETWORK']) { $pairs['RAG_NETWORK'] } else { 'rag-chat-server_default' }
foreach ($network in @($librechatNetwork, $ragNetwork)) {
    & docker network inspect $network *> $null
    if ($LASTEXITCODE -ne 0) {
        & docker network create $network | Out-Null
    }
}

if (-not (Has-ConfiguredValue $pairs 'JUNIOR_SILVA_API_KEY')) { throw 'Set JUNIOR_SILVA_API_KEY in .env before starting the Docker endpoint.' }
if (-not (Has-ConfiguredValue $pairs 'JUNIOR_SILVA_ARTIFACT_SECRET')) { throw 'Set JUNIOR_SILVA_ARTIFACT_SECRET in .env before starting the Docker endpoint.' }

if (-not $SkipBuild) {
    & docker compose build junior-silva-v2
}
& docker compose up -d junior-silva-v2
& docker compose ps junior-silva-v2

if ($Launch) {
    & docker compose --profile cli run --rm junior-silva-cli
} else {
    Write-Host 'Docker endpoint is running. Health check: curl.exe http://127.0.0.1:8132/health'
    Write-Host 'Start the Docker CLI with: docker compose --profile cli run --rm junior-silva-cli'
}
