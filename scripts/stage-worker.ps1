# Stage a freshly built Rust worker into the plugin package.
#
# `lib/worker.js` verifies runtime/<target>/provenance.json (target, executable,
# sha256) before it will run the binary, so replacing the worker without
# refreshing the receipt would make the plugin refuse its own binary.
#
# Usage:  pwsh -File scripts/stage-worker.ps1 [-Source <path to dsh-ops-worker.exe>]
param(
  [string]$Source = ''
)

$ErrorActionPreference = 'Stop'
$packageRoot = Split-Path $PSScriptRoot -Parent

if ($Source -eq '') {
  $Source = Join-Path $packageRoot 'native\target\release\dsh-ops-worker.exe'
}
if (-not (Test-Path $Source)) {
  throw "No built worker at $Source. Run: cargo build --release --locked (in native/)"
}

$target = 'win32-x64'
$name = 'dsh-ops-worker.exe'
$dir = Join-Path $packageRoot "runtime\$target"
New-Item -ItemType Directory -Path $dir -Force | Out-Null
$dest = Join-Path $dir $name
Copy-Item $Source $dest -Force

$sha = (Get-FileHash $dest -Algorithm SHA256).Hash.ToLower()
$version = (Get-Content (Join-Path $packageRoot 'package.json') -Raw | ConvertFrom-Json).version

$receipt = [ordered]@{
  version    = $version
  target     = $target
  executable = $name
  sha256     = $sha
  source     = 'Built from native/ in this repository (cargo build --release --locked).'
}
$json = $receipt | ConvertTo-Json -Depth 4
# LF only: .gitattributes declares '*.json text eol=lf', and ConvertTo-Json
# emits CRLF, so a CRLF receipt would show up as a whole-file diff on every
# restage. Normalise here instead of letting git rewrite it later.
$json = $json -replace "`r`n", "`n"
# No BOM: JSON.parse rejects one, and Windows editors add it by default.
[System.IO.File]::WriteAllText(
  (Join-Path $dir 'provenance.json'),
  $json + "`n",
  (New-Object System.Text.UTF8Encoding($false))
)

Write-Host "staged $dest"
Write-Host "sha256 $sha"
Write-Host "receipt version $version"