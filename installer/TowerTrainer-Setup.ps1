<#
TowerTrainer one-file installer for Windows.
  Right-click -> Run with PowerShell   (or:  powershell -ExecutionPolicy Bypass -File TowerTrainer-Setup.ps1)

What it does, and nothing else:
  1. checks for Python 3.9+ (offers to install it with winget, or opens python.org);
  2. downloads the TowerTrainer source zip from GitHub into %LOCALAPPDATA%\TowerTrainer (asks before replacing);
  3. puts a "Tower Trainer" shortcut on the desktop that runs start.bat;
  4. starts the server and opens the setup wizard (http://localhost:8780/setup) for the optional parts:
     voices, speech recognition, EuroScope radar files, X-Plane / XRadio.
It never downloads EuroScope, sector packages, Navigraph data or X-Plane; those stay the user's own.
#>
param([string]$Target = "$env:LOCALAPPDATA\TowerTrainer", [string]$Repo = "https://github.com/Anviktor2411/TowerTrainer", [switch]$NoStart)
$ErrorActionPreference = "Stop"
function Say($t) { Write-Host "== $t" -ForegroundColor Cyan }

Say "Python"
$py = $null
foreach ($cand in @("python", "py")) {
  try { $v = & $cand -c "import sys; print('%d.%d' % sys.version_info[:2])" 2>$null; if ($v -and [version]$v -ge [version]"3.9") { $py = $cand; break } } catch {}
}
if (-not $py) {
  Write-Host "Python 3.9+ was not found."
  $ans = Read-Host "Install Python 3.12 with winget now? (y/n)"
  if ($ans -eq "y") {
    winget install --id Python.Python.3.12 --accept-package-agreements --accept-source-agreements
    $py = "python"
  } else {
    Start-Process "https://www.python.org/downloads/"
    Write-Host "Install Python (tick 'Add python.exe to PATH') and run this installer again."
    exit 1
  }
}
Write-Host "Python: $py"

Say "TowerTrainer files -> $Target"
if (Test-Path "$Target\server.py") {
  $ans = Read-Host "TowerTrainer is already in $Target. Replace the program files (your cache and settings are kept)? (y/n)"
  if ($ans -ne "y") { Write-Host "Keeping the existing copy."; $skip = $true }
}
if (-not $skip) {
  $tmp = Join-Path $env:TEMP ("tt-" + [guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Force $tmp | Out-Null
  $zip = Join-Path $tmp "TowerTrainer.zip"
  Invoke-WebRequest -UseBasicParsing "$Repo/archive/refs/heads/main.zip" -OutFile $zip
  Expand-Archive -Path $zip -DestinationPath $tmp -Force
  $src = Get-ChildItem $tmp -Directory | Where-Object { Test-Path (Join-Path $_.FullName "server.py") } | Select-Object -First 1
  if (-not $src) { throw "The downloaded archive has no server.py" }
  New-Item -ItemType Directory -Force $Target | Out-Null
  # program files only: cache/ and models/ (airports, voices) of an earlier install stay
  Get-ChildItem $src.FullName | Where-Object { $_.Name -notin @("cache", "models") } | ForEach-Object { Copy-Item $_.FullName -Destination $Target -Recurse -Force }
  Remove-Item $tmp -Recurse -Force
  Write-Host "Copied to $Target"
}

Say "Desktop shortcut"
$lnk = Join-Path ([Environment]::GetFolderPath("Desktop")) "Tower Trainer.lnk"
$s = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk)
$s.TargetPath = Join-Path $Target "start.bat"
$s.WorkingDirectory = $Target
$s.Save()
Write-Host "Shortcut: $lnk"

if (-not $NoStart) {
  Say "Starting the server and the setup wizard"
  Start-Process -FilePath $py -ArgumentList "server.py" -WorkingDirectory $Target -WindowStyle Minimized
  Start-Sleep -Seconds 3
  Start-Process "http://localhost:8780/setup"
}
Write-Host "Done. Start the trainer later with the desktop shortcut (it opens http://localhost:8780)."
