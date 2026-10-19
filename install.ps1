# Installs the standalone voice-to-text tool for this user.
#
#   .\install.ps1                 install dependencies, self-check, create a desktop shortcut
#   .\install.ps1 -AddToPath      also put bin\ on the user PATH so "vtt" works in any terminal
#   .\install.ps1 -NoShortcut     skip the desktop shortcut
#   .\install.ps1 -FetchModels    download the model files when this machine has no DSH cache
#
# Nothing here needs administrator rights: the dependency install stays inside the project, the PATH
# change is user-scoped and the shortcut goes to the current user's desktop.
param(
  [switch]$AddToPath,
  [switch]$NoShortcut,
  [switch]$FetchModels,
  [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$bin = Join-Path $root 'bin'
$entry = Join-Path $bin 'vtt.mjs'

Write-Host "voice-to-text installer" -ForegroundColor Cyan
Write-Host "  project: $root"

# --- 1. Node.js --------------------------------------------------------------
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw 'Node.js was not found on PATH. Install Node.js 20 or newer, then run this script again.' }
$version = (& node --version).TrimStart('v')
$major = [int]($version.Split('.')[0])
if ($major -lt 20) { throw "Node.js 20 or newer is required; found $version." }
Write-Host "  node   : $version ($($node.Source))" -ForegroundColor Green

# --- 2. dependencies ---------------------------------------------------------
$modules = Join-Path $root 'node_modules'
if ($SkipInstall) {
  Write-Host '  deps   : skipped (-SkipInstall)' -ForegroundColor DarkGray
} elseif (Test-Path (Join-Path $modules 'sherpa-onnx-node')) {
  Write-Host '  deps   : already installed' -ForegroundColor Green
} else {
  Write-Host '  deps   : installing (koffi, sherpa-onnx-node) ...'
  # The workspace-local cache keeps npm from reaching outside the project directory, and
  # --ignore-scripts is safe because both dependencies ship prebuilt Windows x64 binaries.
  & npm install --cache (Join-Path $root '.npm-cache') --ignore-scripts --no-audit --no-fund --loglevel=error
  if ($LASTEXITCODE -ne 0) { throw "npm install failed with exit code $LASTEXITCODE." }
  Write-Host '  deps   : installed' -ForegroundColor Green
}

# --- 3. models ---------------------------------------------------------------
if ($FetchModels) {
  Write-Host '  models : fetching and verifying ...'
  & node $entry models --fetch | ForEach-Object { Write-Host "    $_" }
  if ($LASTEXITCODE -ne 0) { throw "model download failed with exit code $LASTEXITCODE." }
}

# --- 4. self-check -----------------------------------------------------------
Write-Host '  doctor :'
$doctorOutput = & node $entry doctor 2>&1
$doctorOutput | ForEach-Object { Write-Host "    $_" }
if ($LASTEXITCODE -ne 0) {
  Write-Warning 'The self-check reported problems. Run "node .\bin\vtt.mjs doctor" for details.'
}

# --- 5. PATH -----------------------------------------------------------------
if ($AddToPath) {
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  $parts = @($userPath -split ';' | Where-Object { $_ })
  if ($parts -contains $bin) {
    Write-Host '  PATH   : bin is already on the user PATH' -ForegroundColor Green
  } else {
    $updated = (@($parts) + $bin) -join ';'
    [Environment]::SetEnvironmentVariable('Path', $updated, 'User')
    Write-Host "  PATH   : added $bin (open a new terminal to pick it up)" -ForegroundColor Green
  }
}

# --- 6. shortcuts ------------------------------------------------------------
# A .lnk in the project folder always works; the desktop copy is a convenience that can fail when the
# shell refuses to write outside the project (a restricted or sandboxed session, for example).
function New-VttShortcut {
  param([string]$Path, [string]$Launcher, [string]$Description, [int]$WindowStyle = 1)
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($Path)
  # Target the launcher script: it finds node, sets the code page for Chinese output and needs no
  # nested quoting, unlike calling cmd.exe with the node path inline.
  $shortcut.TargetPath = Join-Path $root $Launcher
  $shortcut.Arguments = ''
  $shortcut.WorkingDirectory = $root
  $shortcut.Description = $Description
  $shortcut.IconLocation = "$env:SystemRoot\System32\SndVol.exe,0"
  $shortcut.WindowStyle = $WindowStyle
  $shortcut.Save()
}

$links = @(
  @{ Name = 'Voice to Text (floating button).lnk'; Launcher = 'start-overlay.vbs'; Style = 1
     Description = 'Floating microphone button: it follows the text caret, click to dictate' },
  @{ Name = 'Voice to Text (dictate).lnk'; Launcher = 'start-dictate.cmd'; Style = 7
     Description = 'Local speech to text: ctrl+alt+space to record, again to paste the text' }
)

if (-not $NoShortcut) {
  foreach ($link in $links) {
    $local = Join-Path $root $link.Name
    try {
      New-VttShortcut -Path $local -Launcher $link.Launcher -Description $link.Description -WindowStyle $link.Style
      Write-Host "  link   : $local" -ForegroundColor Green
    } catch {
      Write-Warning "Could not create $($link.Name) in the project folder: $($_.Exception.Message)"
    }
    try {
      $desktop = Join-Path ([Environment]::GetFolderPath('Desktop')) $link.Name
      New-VttShortcut -Path $desktop -Launcher $link.Launcher -Description $link.Description -WindowStyle $link.Style
      Write-Host "  link   : $desktop" -ForegroundColor Green
    } catch {
      Write-Warning "No desktop shortcut for $($link.Name) this time ($($_.Exception.Message))."
      Write-Host "           Use $local instead." -ForegroundColor DarkGray
    }
  }
}

Write-Host ''
Write-Host 'Done. Try it:' -ForegroundColor Cyan
Write-Host '  node .\bin\vtt.mjs listen --seconds 5     # one-shot: speak, see the text'
Write-Host '  node .\bin\vtt.mjs overlay                # floating button next to the text caret'
Write-Host '  node .\bin\vtt.mjs dictate                # press ctrl+alt+space in any application'
Write-Host '  node .\bin\vtt.mjs serve                  # HTTP API on 127.0.0.1:8791'
