param(
    [string]$SourceDirectory = $PSScriptRoot,
    [string]$ProfileRoot,
    [string]$ExtensionId,
    [string]$BackupRoot = (Join-Path $env:LOCALAPPDATA 'PasswordVault\CodeBackups'),
    [switch]$NonInteractive,
    [switch]$ListOnly
)

$ErrorActionPreference = 'Stop'

try {
    $source = (Resolve-Path -LiteralPath $SourceDirectory).Path
    $sourceManifestPath = Join-Path $source 'manifest.json'
    $sourceManifest = Get-Content -LiteralPath $sourceManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($sourceManifest.manifest_version -ne 3 -or -not $sourceManifest.name) {
        throw 'The update folder does not contain a valid extension manifest.'
    }

    $codeFiles = @(Get-ChildItem -LiteralPath $source -File | Where-Object {
        $_.Name -eq 'manifest.json' -or $_.Extension -in @('.js', '.html', '.css')
    })
    if (-not @($codeFiles | Where-Object Name -eq 'background.js').Count) {
        throw 'The update folder is missing background.js.'
    }

    if ($ProfileRoot) {
        $profiles = @((Resolve-Path -LiteralPath $ProfileRoot).Path)
    } else {
        $profiles = @()
        foreach ($browser in @(
            (Join-Path $env:LOCALAPPDATA 'Google\Chrome\User Data'),
            (Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\User Data')
        )) {
            if (-not (Test-Path -LiteralPath $browser)) { continue }
            $profiles += @(Get-ChildItem -LiteralPath $browser -Directory | Where-Object {
                $_.Name -eq 'Default' -or $_.Name -like 'Profile *'
            } | Select-Object -ExpandProperty FullName)
        }
    }

    $candidates = @()
    foreach ($profile in $profiles) {
        $preferencesPath = Join-Path $profile 'Secure Preferences'
        if (-not (Test-Path -LiteralPath $preferencesPath)) { continue }
        $preferences = Get-Content -LiteralPath $preferencesPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if (-not $preferences.extensions.settings) { continue }
        foreach ($entry in $preferences.extensions.settings.PSObject.Properties) {
            $path = $entry.Value.path
            if (-not $path -or -not [IO.Path]::IsPathRooted($path)) { continue }
            $installedManifestPath = Join-Path $path 'manifest.json'
            if (-not (Test-Path -LiteralPath $installedManifestPath)) { continue }
            $installedManifest = Get-Content -LiteralPath $installedManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($installedManifest.name -ne $sourceManifest.name -or
                $installedManifest.action.default_popup -ne $sourceManifest.action.default_popup) { continue }
            $candidates += [pscustomobject]@{
                Id = $entry.Name
                Profile = $profile
                Path = (Resolve-Path -LiteralPath $path).Path
                Installed = (Get-Item -LiteralPath $path).CreationTime
                Version = $installedManifest.version
            }
        }
    }

    if (-not $candidates.Count) {
        throw 'No installed copy found. For a first install, use Load unpacked in the browser.'
    }

    Write-Host "Update files: $source"
    Write-Host "Update version: $($sourceManifest.version)"
    Write-Host ''
    for ($i = 0; $i -lt $candidates.Count; $i++) {
        $item = $candidates[$i]
        Write-Host "[$($i + 1)] ID $($item.Id) | installed $($item.Installed) | version $($item.Version)"
        Write-Host "    $($item.Path)"
    }
    if ($ListOnly) { return }

    if ($ExtensionId) {
        $selected = @($candidates | Where-Object Id -eq $ExtensionId)
        if ($selected.Count -ne 1) { throw 'That extension ID was not found in the installed copies.' }
        $item = $selected[0]
    } elseif ($candidates.Count -eq 1) {
        $item = $candidates[0]
    } else {
        $choice = Read-Host 'Enter the number of the ORIGINAL extension ID shown in chrome://extensions'
        $number = 0
        if (-not [int]::TryParse($choice, [ref]$number) -or $number -lt 1 -or $number -gt $candidates.Count) {
            throw 'No extension was changed. Choose a number from the list.'
        }
        $item = $candidates[$number - 1]
    }

    if (-not $NonInteractive) {
        $answer = Read-Host "Update ID $($item.Id) in place? Type YES"
        if ($answer -cne 'YES') { throw 'No extension was changed.' }
    } elseif (-not $ExtensionId) {
        throw 'NonInteractive requires an explicit ExtensionId.'
    }

    if ($source.TrimEnd('\') -ieq $item.Path.TrimEnd('\')) {
        throw 'The update files are already in the installed folder. Reload the existing extension.'
    }

    # Only extension code is copied. Browser-managed vault storage is outside this folder.
    $backup = Join-Path $BackupRoot ("{0}_{1}" -f $item.Id, (Get-Date -Format 'yyyyMMdd_HHmmss'))
    New-Item -ItemType Directory -Path $backup -Force | Out-Null
    $createdFiles = @()
    foreach ($file in $codeFiles) {
        $destination = Join-Path $item.Path $file.Name
        if (Test-Path -LiteralPath $destination) {
            Copy-Item -LiteralPath $destination -Destination (Join-Path $backup $file.Name) -Force
        } else {
            $createdFiles += $destination
        }
    }

    try {
        foreach ($file in $codeFiles) {
            $destination = Join-Path $item.Path $file.Name
            Copy-Item -LiteralPath $file.FullName -Destination $destination -Force
            if ((Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash -ne
                (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash) {
                throw "Verification failed: $($file.Name)"
            }
        }
    } catch {
        foreach ($file in @(Get-ChildItem -LiteralPath $backup -File)) {
            Copy-Item -LiteralPath $file.FullName -Destination (Join-Path $item.Path $file.Name) -Force
        }
        foreach ($path in $createdFiles) {
            if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force }
        }
        throw
    }

    Write-Host ''
    Write-Host "Updated ID $($item.Id). The extension ID and its browser vault storage were kept."
    Write-Host 'Open chrome://extensions (or edge://extensions) and click Reload on THIS ID.'
    Write-Host 'Do not drag the ZIP onto the extensions page. Do not remove the original extension.'
    Write-Host "Code backup: $backup"
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
