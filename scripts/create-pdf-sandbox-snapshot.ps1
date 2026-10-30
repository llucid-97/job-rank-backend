#requires -Version 5.1
$ErrorActionPreference = "Stop"

$project = "jobrank-api"
$sandboxName = "jobrank-pdf-parser-seed-$([DateTime]::UtcNow.ToString('yyyyMMddHHmmss'))-$([Guid]::NewGuid().ToString('N').Substring(0, 8))"
$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$sandboxCreated = $false

function Invoke-VercelSandboxCli {
    param([Parameter(Mandatory = $true)][string[]]$Arguments)

    & vercel @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Vercel Sandbox CLI command failed (exit $LASTEXITCODE): vercel $($Arguments -join ' ')"
    }
}

Push-Location $repositoryRoot
try {
    Invoke-VercelSandboxCli -Arguments @(
        "sandbox", "create", "--project", $project, "--name", $sandboxName,
        "--vcpus", "1", "--timeout", "10m", "--network-policy", "allow-all", "--non-persistent"
    )
    $sandboxCreated = $true

    Invoke-VercelSandboxCli -Arguments @(
        "sandbox", "exec", "--project", $project, "--timeout", "5m", $sandboxName, "--",
        "npm", "install", "--prefix", "/vercel/sandbox/pdf-worker", "--no-save", "--package-lock=false",
        "pdf-parse@2.4.5", "pdfjs-dist@5.4.296", "@napi-rs/canvas@0.1.80"
    )

    Invoke-VercelSandboxCli -Arguments @(
        "sandbox", "exec", "--project", $project, "--timeout", "1m", $sandboxName, "--",
        "mkdir", "-p", "/vercel/sandbox/pdf-worker/scripts"
    )

    Invoke-VercelSandboxCli -Arguments @(
        "sandbox", "copy", "--project", $project,
        "scripts/pdf-sandbox-extract.mjs",
        "${sandboxName}:/vercel/sandbox/pdf-worker/extract.mjs"
    )

    Invoke-VercelSandboxCli -Arguments @(
        "sandbox", "copy", "--project", $project,
        "scripts/patch-pdfjs-resource-limits.mjs",
        "${sandboxName}:/vercel/sandbox/pdf-worker/scripts/patch-pdfjs-resource-limits.mjs"
    )
    Invoke-VercelSandboxCli -Arguments @(
        "sandbox", "copy", "--project", $project,
        "scripts/validate-pdfjs-resource-patch.mjs",
        "${sandboxName}:/vercel/sandbox/pdf-worker/scripts/validate-pdfjs-resource-patch.mjs"
    )

    Invoke-VercelSandboxCli -Arguments @(
        "sandbox", "exec", "--project", $project, "--timeout", "2m", $sandboxName, "--",
        "node", "/vercel/sandbox/pdf-worker/scripts/patch-pdfjs-resource-limits.mjs"
    )
    Invoke-VercelSandboxCli -Arguments @(
        "sandbox", "exec", "--project", $project, "--timeout", "2m", $sandboxName, "--",
        "node", "/vercel/sandbox/pdf-worker/scripts/patch-pdfjs-resource-limits.mjs"
    )

    $snapshotOutput = & vercel sandbox snapshot --project $project --expiration 0 --stop $sandboxName 2>&1
    $snapshotExitCode = $LASTEXITCODE
    foreach ($line in $snapshotOutput) { Write-Host $line }
    if ($snapshotExitCode -ne 0) {
        throw "Vercel Sandbox CLI snapshot command failed (exit $snapshotExitCode)."
    }

    $snapshotText = ($snapshotOutput | ForEach-Object { $_.ToString() }) -join "`n"
    $snapshotText = $snapshotText -replace "\x1B\[[0-?]*[ -/]*[@-~]", ""
    if ($snapshotText -notmatch "(?i)\bSnapshot\s+(snap_[A-Za-z0-9_-]+)\s+created\b") {
        throw "Snapshot succeeded, but the CLI confirmation did not include a parseable snapshot ID. Use 'vercel sandbox snapshots list --project $project --name $sandboxName' to retrieve it."
    }

    Write-Host "Created clean PDF parser snapshot: $($Matches[1])"
}
finally {
    if ($sandboxCreated) {
        & vercel sandbox remove --project $project $sandboxName
        if ($LASTEXITCODE -ne 0) {
            Write-Warning "Could not remove seed sandbox '$sandboxName'. The parser snapshot is retained independently."
        }
    }
    Pop-Location
}

