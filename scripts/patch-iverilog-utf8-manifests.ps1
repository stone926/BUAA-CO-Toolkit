[CmdletBinding()]
param(
  [string]$RuntimeRoot = (Join-Path $PSScriptRoot "..\vendor\iverilog\win32-x64"),
  [string]$ManifestPath = (Join-Path $PSScriptRoot "iverilog-utf8-codepage.manifest"),
  [string]$ManifestTool = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$expectedOriginalSha256 = @{
  "bin/iverilog-vpi.exe" = "497e9f9e183526908a765be973ed1cf6b00b1704abd1e6302e043136b579b1b1"
  "bin/iverilog.exe" = "25e1ba02e72f58d9d484bc5457d69a6b179d22d86bdf5ba5d6f9f0d4fe620bbf"
  "bin/vvp.exe" = "f0775603e1f1bcf1b2dea16dff963a4b7d71b7b33d5bbe23d2b01ff5b2304e09"
  "lib/ivl/ivl.exe" = "75b5b4569796b4cd85c74e9b4836699a70159279c3bae20268a8578558686643"
  "lib/ivl/ivlpp.exe" = "d41181df44c4c6a6ad07e5f91a34f7624ec081150c5b08e007133afdb7fad3c8"
  "lib/ivl/vhdlpp.exe" = "83974fee3745a754110abc5ef51468fa7a90f2afec36d5288e4c02e5ed6ca9bf"
}

function Resolve-ManifestTool {
  if ($ManifestTool) {
    $explicit = Get-Command $ManifestTool -ErrorAction SilentlyContinue
    if ($explicit) {
      return $explicit.Source
    }
    if (Test-Path -LiteralPath $ManifestTool -PathType Leaf) {
      return (Resolve-Path -LiteralPath $ManifestTool).Path
    }
    throw "Manifest tool not found: $ManifestTool"
  }

  $onPath = Get-Command "mt.exe" -ErrorAction SilentlyContinue
  if ($onPath) {
    return $onPath.Source
  }

  $programFilesX86 = [Environment]::GetFolderPath("ProgramFilesX86")
  $windowsKitsBin = Join-Path $programFilesX86 "Windows Kits\10\bin"
  if (Test-Path -LiteralPath $windowsKitsBin -PathType Container) {
    $candidate = Get-ChildItem -LiteralPath $windowsKitsBin -Directory |
      Sort-Object -Property Name -Descending |
      ForEach-Object { Join-Path $_.FullName "x64\mt.exe" } |
      Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
      Select-Object -First 1
    if ($candidate) {
      return $candidate
    }
  }

  throw "mt.exe was not found. Install the Windows SDK or pass -ManifestTool."
}

function Read-EmbeddedManifest {
  param(
    [Parameter(Mandatory)] [string]$Tool,
    [Parameter(Mandatory)] [string]$Executable
  )

  $temporaryManifest = [System.IO.Path]::GetTempFileName()
  try {
    & $Tool ("-inputresource:{0};#1" -f $Executable) ("-out:{0}" -f $temporaryManifest) -nologo
    if ($LASTEXITCODE -ne 0) {
      throw "mt.exe could not extract the manifest from $Executable"
    }
    return Get-Content -LiteralPath $temporaryManifest -Raw -Encoding UTF8
  } finally {
    [System.IO.File]::Delete($temporaryManifest)
  }
}

function Test-Utf8CodePageManifest {
  param([Parameter(Mandatory)] [string]$Manifest)

  return $Manifest -match '<activeCodePage\b[^>]*>\s*UTF-8\s*</activeCodePage>'
}

function Get-PeLayout {
  param(
    [Parameter(Mandatory)] [byte[]]$Bytes,
    [Parameter(Mandatory)] [string]$Label
  )

  if ($Bytes.Length -lt 64 -or $Bytes[0] -ne 0x4d -or $Bytes[1] -ne 0x5a) {
    throw "$Label is not a valid PE image."
  }

  $peOffset = [BitConverter]::ToUInt32($Bytes, 0x3c)
  if (
    $peOffset -gt $Bytes.Length - 24 -or
    $Bytes[$peOffset] -ne 0x50 -or
    $Bytes[$peOffset + 1] -ne 0x45 -or
    $Bytes[$peOffset + 2] -ne 0 -or
    $Bytes[$peOffset + 3] -ne 0
  ) {
    throw "$Label has an invalid PE header."
  }

  $fileHeaderOffset = [int]$peOffset + 4
  $numberOfSections = [BitConverter]::ToUInt16($Bytes, $fileHeaderOffset + 2)
  $optionalHeaderSize = [BitConverter]::ToUInt16($Bytes, $fileHeaderOffset + 16)
  $optionalHeaderOffset = $fileHeaderOffset + 20
  if ($optionalHeaderSize -lt 68 -or $optionalHeaderOffset + $optionalHeaderSize -gt $Bytes.Length) {
    throw "$Label has an invalid optional header."
  }

  $optionalHeaderMagic = [BitConverter]::ToUInt16($Bytes, $optionalHeaderOffset)
  $dataDirectoryOffset = switch ($optionalHeaderMagic) {
    0x10b { $optionalHeaderOffset + 96 }
    0x20b { $optionalHeaderOffset + 112 }
    default { throw "$Label has an unsupported optional-header magic value." }
  }
  $securityDirectoryOffset = $dataDirectoryOffset + (4 * 8)
  if ($securityDirectoryOffset + 8 -gt $optionalHeaderOffset + $optionalHeaderSize) {
    throw "$Label has no complete PE security directory."
  }
  if (
    [BitConverter]::ToUInt32($Bytes, $securityDirectoryOffset) -ne 0 -or
    [BitConverter]::ToUInt32($Bytes, $securityDirectoryOffset + 4) -ne 0
  ) {
    throw "$Label is Authenticode-signed; the manifest patch must not invalidate a signature."
  }

  $sectionTableOffset = $optionalHeaderOffset + $optionalHeaderSize
  if ($sectionTableOffset + ($numberOfSections * 40) -gt $Bytes.Length) {
    throw "$Label has a truncated PE section table."
  }

  [uint64]$rawSectionEnd = 0
  for ($sectionIndex = 0; $sectionIndex -lt $numberOfSections; $sectionIndex++) {
    $sectionOffset = $sectionTableOffset + ($sectionIndex * 40)
    [uint64]$rawSize = [BitConverter]::ToUInt32($Bytes, $sectionOffset + 16)
    [uint64]$rawPointer = [BitConverter]::ToUInt32($Bytes, $sectionOffset + 20)
    $sectionEnd = $rawPointer + $rawSize
    if ($sectionEnd -gt $Bytes.Length) {
      throw "$Label has a truncated PE section."
    }
    if ($sectionEnd -gt $rawSectionEnd) {
      $rawSectionEnd = $sectionEnd
    }
  }

  return [pscustomobject]@{
    FileHeaderOffset = $fileHeaderOffset
    ChecksumOffset = $optionalHeaderOffset + 64
    NumberOfSections = $numberOfSections
    RawSectionEnd = [int]$rawSectionEnd
    SectionTableOffset = $sectionTableOffset
  }
}

function Get-BytesSha256 {
  param([Parameter(Mandatory)] [AllowEmptyCollection()] [byte[]]$Bytes)

  $sha256 = [System.Security.Cryptography.SHA256]::Create()
  try {
    return ([BitConverter]::ToString($sha256.ComputeHash($Bytes)) -replace '-', '').ToLowerInvariant()
  } finally {
    $sha256.Dispose()
  }
}

function Get-NonResourceSectionSignature {
  param(
    [Parameter(Mandatory)] [byte[]]$Bytes,
    [Parameter(Mandatory)] [string]$Label
  )

  $layout = Get-PeLayout -Bytes $Bytes -Label $Label
  $signatures = @()
  for ($sectionIndex = 0; $sectionIndex -lt $layout.NumberOfSections; $sectionIndex++) {
    $sectionOffset = $layout.SectionTableOffset + ($sectionIndex * 40)
    $nameLength = 0
    while ($nameLength -lt 8 -and $Bytes[$sectionOffset + $nameLength] -ne 0) {
      $nameLength++
    }
    $name = [Text.Encoding]::ASCII.GetString($Bytes, $sectionOffset, $nameLength)
    if ($name -eq '.rsrc') {
      continue
    }

    $rawSize = [int][BitConverter]::ToUInt32($Bytes, $sectionOffset + 16)
    $rawPointer = [int][BitConverter]::ToUInt32($Bytes, $sectionOffset + 20)
    $sectionBytes = [byte[]]::new($rawSize)
    if ($rawSize -gt 0) {
      [Array]::Copy($Bytes, $rawPointer, $sectionBytes, 0, $rawSize)
    }
    $signatures += "${sectionIndex}:${name}:${rawSize}:$(Get-BytesSha256 -Bytes $sectionBytes)"
  }
  return $signatures -join '|'
}

function Get-CoffSymbolTail {
  param(
    [Parameter(Mandatory)] [byte[]]$Bytes,
    [Parameter(Mandatory)] [string]$Label
  )

  $layout = Get-PeLayout -Bytes $Bytes -Label $Label
  [uint32]$symbolTablePointer = [BitConverter]::ToUInt32($Bytes, $layout.FileHeaderOffset + 8)
  [uint32]$numberOfSymbols = [BitConverter]::ToUInt32($Bytes, $layout.FileHeaderOffset + 12)
  if ($symbolTablePointer -eq 0 -or $numberOfSymbols -eq 0) {
    throw "$Label has no COFF symbol table to preserve."
  }
  if ($symbolTablePointer -ne $layout.RawSectionEnd) {
    throw "$Label has an unexpected overlay before its COFF symbol table."
  }

  [uint64]$stringTableOffset = [uint64]$symbolTablePointer + ([uint64]$numberOfSymbols * 18)
  if ($stringTableOffset + 4 -gt $Bytes.Length) {
    throw "$Label has a truncated COFF symbol table."
  }
  [uint32]$stringTableLength = [BitConverter]::ToUInt32($Bytes, [int]$stringTableOffset)
  if ($stringTableLength -lt 4 -or $stringTableOffset + $stringTableLength -ne $Bytes.Length) {
    throw "$Label has a truncated or unexpected COFF string table."
  }

  $tail = [byte[]]::new($Bytes.Length - [int]$symbolTablePointer)
  [Array]::Copy($Bytes, [int]$symbolTablePointer, $tail, 0, $tail.Length)
  return [pscustomobject]@{
    Bytes = $tail
    NumberOfSymbols = $numberOfSymbols
  }
}

function Set-UInt32LittleEndian {
  param(
    [Parameter(Mandatory)] [byte[]]$Bytes,
    [Parameter(Mandatory)] [int]$Offset,
    [Parameter(Mandatory)] [uint32]$Value
  )

  [Array]::Copy([BitConverter]::GetBytes($Value), 0, $Bytes, $Offset, 4)
}

if (-not ([System.Management.Automation.PSTypeName]"PeChecksumNative").Type) {
  Add-Type -TypeDefinition @"
using System.Runtime.InteropServices;

public static class PeChecksumNative
{
    [DllImport("imagehlp.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    public static extern uint MapFileAndCheckSumW(
        string filename,
        out uint headerSum,
        out uint checkSum);
}
"@
}

function Update-PeChecksum {
  param([Parameter(Mandatory)] [string]$Executable)

  $bytes = [System.IO.File]::ReadAllBytes($Executable)
  $layout = Get-PeLayout -Bytes $bytes -Label $Executable
  Set-UInt32LittleEndian -Bytes $bytes -Offset $layout.ChecksumOffset -Value 0
  [System.IO.File]::WriteAllBytes($Executable, $bytes)

  [uint32]$headerSum = 0
  [uint32]$computedSum = 0
  $status = [PeChecksumNative]::MapFileAndCheckSumW(
    $Executable,
    [ref]$headerSum,
    [ref]$computedSum
  )
  if ($status -ne 0) {
    throw "MapFileAndCheckSumW failed for $Executable with status $status."
  }

  Set-UInt32LittleEndian -Bytes $bytes -Offset $layout.ChecksumOffset -Value $computedSum
  [System.IO.File]::WriteAllBytes($Executable, $bytes)

  [uint32]$verifiedHeaderSum = 0
  [uint32]$verifiedComputedSum = 0
  $status = [PeChecksumNative]::MapFileAndCheckSumW(
    $Executable,
    [ref]$verifiedHeaderSum,
    [ref]$verifiedComputedSum
  )
  if (
    $status -ne 0 -or
    $verifiedHeaderSum -ne $computedSum -or
    $verifiedComputedSum -ne $computedSum
  ) {
    throw "PE checksum verification failed for $Executable."
  }
}

$resolvedRuntimeRoot = (Resolve-Path -LiteralPath $RuntimeRoot).Path
$resolvedManifestPath = (Resolve-Path -LiteralPath $ManifestPath).Path
$runtimePrefix = $resolvedRuntimeRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar) +
  [System.IO.Path]::DirectorySeparatorChar
$mt = Resolve-ManifestTool
$patchMetadataPath = Join-Path $resolvedRuntimeRoot "UTF8_MANIFEST_PATCH.json"
$expectedPatchedSha256 = @{}
if (Test-Path -LiteralPath $patchMetadataPath -PathType Leaf) {
  $patchMetadata = Get-Content -LiteralPath $patchMetadataPath -Raw -Encoding UTF8 |
    ConvertFrom-Json
  foreach ($patchedTarget in $patchMetadata.targets) {
    $expectedPatchedSha256[$patchedTarget.path] = $patchedTarget.patchedSha256
  }
}

# Preflight every input before creating or replacing any output. Windows mt.exe
# rewrites .rsrc but drops MinGW's trailing COFF symbol/string table while
# retaining its header pointer, so the tail must be validated and preserved.
$patchPlans = @()
foreach ($entry in $expectedOriginalSha256.GetEnumerator() | Sort-Object -Property Key) {
  $relativePath = $entry.Key
  $target = [System.IO.Path]::GetFullPath(
    (Join-Path $resolvedRuntimeRoot ($relativePath -replace '/', [System.IO.Path]::DirectorySeparatorChar))
  )
  if (-not $target.StartsWith($runtimePrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to patch a path outside the runtime root: $target"
  }
  if (-not (Test-Path -LiteralPath $target -PathType Leaf)) {
    throw "Bundled executable is missing: $relativePath"
  }

  $originalBytes = [System.IO.File]::ReadAllBytes($target)
  $embedded = Read-EmbeddedManifest -Tool $mt -Executable $target
  if (Test-Utf8CodePageManifest -Manifest $embedded) {
    $null = Get-CoffSymbolTail -Bytes $originalBytes -Label $relativePath
    $actualPatchedSha256 = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant()
    if (
      -not $expectedPatchedSha256.ContainsKey($relativePath) -or
      $actualPatchedSha256 -ne $expectedPatchedSha256[$relativePath]
    ) {
      throw "Unexpected patched binary hash for ${relativePath}: $actualPatchedSha256"
    }
    $patchPlans += [pscustomobject]@{
      AlreadyPatched = $true
      RelativePath = $relativePath
      Target = $target
    }
    continue
  }

  $actualOriginalSha256 = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualOriginalSha256 -ne $entry.Value) {
    throw "Unexpected unpatched binary hash for ${relativePath}: $actualOriginalSha256"
  }
  $originalCoff = Get-CoffSymbolTail -Bytes $originalBytes -Label $relativePath

  $patchPlans += [pscustomobject]@{
    AlreadyPatched = $false
    OriginalCoff = $originalCoff
    OriginalSectionSignature = (Get-NonResourceSectionSignature `
        -Bytes $originalBytes `
        -Label $relativePath)
    RelativePath = $relativePath
    Target = $target
  }
}

$generatedPlans = @()
$replacementBackups = @()
$deleteReplacementBackups = $true
try {
  # Build and fully verify all six temporary executables before touching the
  # bundled runtime. This keeps a late invalid input from leaving a mixed tree.
  foreach ($plan in $patchPlans) {
    if ($plan.AlreadyPatched) {
      continue
    }

    $temporaryExecutable = "$($plan.Target).utf8-patch-$([guid]::NewGuid().ToString('N')).tmp"
    Copy-Item -LiteralPath $plan.Target -Destination $temporaryExecutable
    try {
      & $mt `
        ("-inputresource:{0};#1" -f $plan.Target) `
        -manifest $resolvedManifestPath `
        ("-outputresource:{0};#1" -f $temporaryExecutable) `
        -nologo
      if ($LASTEXITCODE -ne 0) {
        throw "mt.exe could not merge the UTF-8 manifest into $($plan.RelativePath)"
      }

      $resourcePatchedBytes = [System.IO.File]::ReadAllBytes($temporaryExecutable)
      $resourcePatchedLayout = Get-PeLayout `
        -Bytes $resourcePatchedBytes `
        -Label $plan.RelativePath
      if ($resourcePatchedLayout.RawSectionEnd -ne $resourcePatchedBytes.Length) {
        throw "mt.exe left an unexpected overlay in $($plan.RelativePath)"
      }
      if ($resourcePatchedBytes.Length -gt [uint32]::MaxValue) {
        throw "$($plan.RelativePath) is too large for a COFF symbol-table pointer."
      }
      $patchedSectionSignature = Get-NonResourceSectionSignature `
        -Bytes $resourcePatchedBytes `
        -Label $plan.RelativePath
      if ($patchedSectionSignature -ne $plan.OriginalSectionSignature) {
        throw "mt.exe changed a non-resource PE section in $($plan.RelativePath)"
      }

      $finalBytes = [byte[]]::new(
        $resourcePatchedBytes.Length + $plan.OriginalCoff.Bytes.Length
      )
      [Array]::Copy($resourcePatchedBytes, 0, $finalBytes, 0, $resourcePatchedBytes.Length)
      [Array]::Copy(
        $plan.OriginalCoff.Bytes,
        0,
        $finalBytes,
        $resourcePatchedBytes.Length,
        $plan.OriginalCoff.Bytes.Length
      )
      Set-UInt32LittleEndian `
        -Bytes $finalBytes `
        -Offset ($resourcePatchedLayout.FileHeaderOffset + 8) `
        -Value ([uint32]$resourcePatchedBytes.Length)
      Set-UInt32LittleEndian `
        -Bytes $finalBytes `
        -Offset ($resourcePatchedLayout.FileHeaderOffset + 12) `
        -Value $plan.OriginalCoff.NumberOfSymbols
      [System.IO.File]::WriteAllBytes($temporaryExecutable, $finalBytes)
      Update-PeChecksum -Executable $temporaryExecutable

      $verifiedBytes = [System.IO.File]::ReadAllBytes($temporaryExecutable)
      $verifiedCoff = Get-CoffSymbolTail -Bytes $verifiedBytes -Label $plan.RelativePath
      if (
        (Get-BytesSha256 -Bytes $verifiedCoff.Bytes) -ne
        (Get-BytesSha256 -Bytes $plan.OriginalCoff.Bytes)
      ) {
        throw "COFF symbol/string tables changed while patching $($plan.RelativePath)"
      }

      $patchedManifest = Read-EmbeddedManifest -Tool $mt -Executable $temporaryExecutable
      if (-not (Test-Utf8CodePageManifest -Manifest $patchedManifest)) {
        throw "UTF-8 activeCodePage was not embedded into $($plan.RelativePath)"
      }
      $generatedFileHash = Get-FileHash -LiteralPath $temporaryExecutable -Algorithm SHA256
      $generatedSha256 = $generatedFileHash.Hash.ToLowerInvariant()
      if (
        $expectedPatchedSha256.ContainsKey($plan.RelativePath) -and
        $generatedSha256 -ne $expectedPatchedSha256[$plan.RelativePath]
      ) {
        throw "Generated binary hash does not match metadata for $($plan.RelativePath): $generatedSha256"
      }

      $generatedPlans += [pscustomobject]@{
        RelativePath = $plan.RelativePath
        Target = $plan.Target
        TemporaryExecutable = $temporaryExecutable
      }
    } catch {
      [System.IO.File]::Delete($temporaryExecutable)
      throw
    }
  }

  foreach ($generated in $generatedPlans) {
    $backup = "$($generated.Target).utf8-backup-$([guid]::NewGuid().ToString('N')).tmp"
    Copy-Item -LiteralPath $generated.Target -Destination $backup
    $replacementBackups += [pscustomobject]@{
      Backup = $backup
      Target = $generated.Target
    }
  }

  # Keep exact backups until every replacement succeeds. An incomplete rollback
  # intentionally preserves its backups for manual recovery.
  try {
    foreach ($generated in $generatedPlans) {
      Move-Item `
        -LiteralPath $generated.TemporaryExecutable `
        -Destination $generated.Target `
        -Force
    }
  } catch {
    $replacementError = $_
    $rollbackFailures = @()
    foreach ($replacement in $replacementBackups) {
      try {
        Copy-Item -LiteralPath $replacement.Backup -Destination $replacement.Target -Force
      } catch {
        $rollbackFailures += $replacement.Target
      }
    }
    if ($rollbackFailures.Count -gt 0) {
      $deleteReplacementBackups = $false
      throw (
        "Runtime replacement failed and rollback was incomplete. " +
        "Backups were preserved beside these targets: $($rollbackFailures -join ', '). " +
        "Original error: $($replacementError.Exception.Message)"
      )
    }
    throw $replacementError
  }
} finally {
  foreach ($generated in $generatedPlans) {
    [System.IO.File]::Delete($generated.TemporaryExecutable)
  }
  if ($deleteReplacementBackups) {
    foreach ($replacement in $replacementBackups) {
      [System.IO.File]::Delete($replacement.Backup)
    }
  }
}

foreach ($plan in $patchPlans) {
  if ($plan.AlreadyPatched) {
    Write-Host "UTF-8 manifest already present: $($plan.RelativePath)"
  } else {
    $patchedSha256 = (Get-FileHash -LiteralPath $plan.Target -Algorithm SHA256).Hash.ToLowerInvariant()
    Write-Host "Patched $($plan.RelativePath) ($patchedSha256)"
  }
}
