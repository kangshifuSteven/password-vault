$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
$testRoot = Join-Path $env:TEMP ("password-vault-updater-test-{0}" -f [guid]::NewGuid().ToString('N'))
$profile = Join-Path $testRoot 'Default'
$old = Join-Path $testRoot 'old-extension'
$new = Join-Path $testRoot 'second-extension'
$backup = Join-Path $testRoot 'backups'
$oldId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
$newId = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

try {
    New-Item -ItemType Directory -Path $profile, $old, $new -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $project 'manifest.json') -Destination $old
    Copy-Item -LiteralPath (Join-Path $project 'manifest.json') -Destination $new
    Set-Content -LiteralPath (Join-Path $old 'background.js') -Value 'old code'
    Set-Content -LiteralPath (Join-Path $new 'background.js') -Value 'other code'

    $settings = @{}
    $settings[$oldId] = @{ path = $old }
    $settings[$newId] = @{ path = $new }
    @{ extensions = @{ settings = $settings } } | ConvertTo-Json -Depth 10 |
        Set-Content -LiteralPath (Join-Path $profile 'Secure Preferences')
    $vaultDir = Join-Path $profile "Local Extension Settings\$oldId"
    New-Item -ItemType Directory -Path $vaultDir -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $vaultDir 'vault-marker') -Value 'encrypted data stays here'

    $args = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $project 'update-windows.ps1'),
        '-ProfileRoot', $profile, '-SourceDirectory', $project, '-BackupRoot', $backup)
    $listing = & powershell.exe @args -ListOnly 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0 -or $listing -notmatch $oldId -or $listing -notmatch $newId) {
        throw 'The updater did not list both installed IDs.'
    }
    if ((Get-Content -LiteralPath (Join-Path $old 'background.js') -Raw).Trim() -ne 'old code') {
        throw 'ListOnly changed an installed extension.'
    }

    $result = & powershell.exe @args -ExtensionId $oldId -NonInteractive 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) { throw "Update failed: $result" }
    $expected = (Get-FileHash -LiteralPath (Join-Path $project 'background.js') -Algorithm SHA256).Hash
    $actual = (Get-FileHash -LiteralPath (Join-Path $old 'background.js') -Algorithm SHA256).Hash
    if ($actual -ne $expected) { throw 'The selected extension was not updated.' }
    if ((Get-Content -LiteralPath (Join-Path $new 'background.js') -Raw).Trim() -ne 'other code') {
        throw 'The other extension was changed.'
    }
    if ((Get-Content -LiteralPath (Join-Path $vaultDir 'vault-marker') -Raw).Trim() -ne 'encrypted data stays here') {
        throw 'The vault directory was changed.'
    }
    if (-not @(Get-ChildItem -LiteralPath $backup -Directory | Where-Object Name -Like "${oldId}_*").Count) {
        throw 'The previous extension code was not backed up.'
    }
    Write-Host 'Updater test passed: selected ID updated; other ID and vault storage unchanged.'
} finally {
    $tempRoot = [IO.Path]::GetFullPath($env:TEMP).TrimEnd('\') + '\'
    $resolvedTestRoot = [IO.Path]::GetFullPath($testRoot)
    if ($resolvedTestRoot.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -and
        (Split-Path -Leaf $resolvedTestRoot) -like 'password-vault-updater-test-*') {
        Remove-Item -LiteralPath $resolvedTestRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}
