$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
if (-not (Test-Path -LiteralPath '.env')) { throw 'Missing .env.' }
$pairs = @{}
Get-Content -LiteralPath '.env' | ForEach-Object {
    $line = $_.Trim()
    if ($line -and -not $line.StartsWith('#') -and $line.Contains('=')) {
        $name, $value = $line.Split('=', 2)
        $pairs[$name.Trim()] = $value.Trim().Trim('"').Trim("'")
    }
}
foreach ($name in @('GEMINI_API_KEY', 'ANTHROPIC_API_KEY')) { if ($pairs[$name]) { Set-Item -Path "Env:$name" -Value $pairs[$name] } }
$provider = if ($pairs['PI_PROVIDER']) { $pairs['PI_PROVIDER'] } else { 'google' }
$model = if ($pairs['PI_MODEL']) { $pairs['PI_MODEL'] } else { 'gemini-3.1-flash-lite-preview' }
$thinking = if ($pairs['PI_THINKING']) { $pairs['PI_THINKING'] } else { 'medium' }
$citationDelivery = Join-Path $PSScriptRoot '.pi/extensions/legal-research-citation-delivery.ts'
$previewDelivery = Join-Path $PSScriptRoot '.pi/extensions/librechat-preview-delivery.ts'
$legalContext = Join-Path $PSScriptRoot '.pi/extensions/junior-silva-legal-context.ts'
& node (Join-Path $PSScriptRoot 'packages/coding-agent/dist/bundle/cli.js') --tui-mode regular --no-builtin-tools --provider $provider --model $model --thinking $thinking --extension $legalContext --extension $citationDelivery --extension $previewDelivery @args
