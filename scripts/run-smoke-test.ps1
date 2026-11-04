param(
    [switch]$Build
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$bridgeRoot = Split-Path -Parent $PSScriptRoot
$fixtureRoot = Join-Path $bridgeRoot "examples\smoke-workspace-fixture"
$cliPath = Join-Path $bridgeRoot "dist\cli.js"

if (-not (Test-Path -LiteralPath $fixtureRoot -PathType Container)) {
    throw "Smoke-Fixture wurde nicht gefunden: $fixtureRoot"
}

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) "omega-agent-bridge-smoke-$timestamp"
$workspaceRoot = Join-Path $tempRoot "workspace"
$specPath = Join-Path $tempRoot "smoke-run.spec.json"

New-Item -ItemType Directory -Force -Path $workspaceRoot | Out-Null
Copy-Item -Path (Join-Path $fixtureRoot "*") -Destination $workspaceRoot -Recurse -Force

$spec = [ordered]@{
    goal = "Create a STATUS.md file in this smoke-test workspace that summarizes the fixture and confirms the bridge run."
    workspace = $workspaceRoot
    constraints = @(
        "Change only files inside this smoke-test workspace.",
        "Keep the result short and practical.",
        "Do not delete or rename the existing files."
    )
    success_criteria = @(
        "A STATUS.md file exists in the workspace root.",
        "The file briefly summarizes the fixture.",
        "Existing fixture files still exist after the run."
    )
    allow_write = $true
    max_subjobs = 3
    timeout_minutes = 20
    report_format = "full"
}

$json = $spec | ConvertTo-Json -Depth 10
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
[System.IO.File]::WriteAllText($specPath, $json, $utf8NoBom)

Push-Location -LiteralPath $bridgeRoot
try {
    if ($Build -or -not (Test-Path -LiteralPath $cliPath -PathType Leaf)) {
        Write-Host "Baue Omega Agent Bridge..." -ForegroundColor Cyan
        & npm run build
        if ($LASTEXITCODE -ne 0) {
            exit $LASTEXITCODE
        }
    }

    Write-Host "Smoke-Test-Workspace: $workspaceRoot" -ForegroundColor Cyan
    Write-Host "Spec: $specPath" -ForegroundColor Cyan
    Write-Host ""
    & node $cliPath run --spec $specPath --json
    exit $LASTEXITCODE
}
finally {
    Pop-Location
}
