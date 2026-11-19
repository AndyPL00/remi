@echo off
rem Porneste serverul Remi si tunelul public Cloudflare.
rem Inchide ferestrele "Remi - server" si "Remi - tunel" ca sa opresti jocul.
cd /d "%~dp0"
title Remi

set "CLOUDFLARED=C:\Program Files (x86)\cloudflared\cloudflared.exe"
if not exist "%CLOUDFLARED%" set "CLOUDFLARED=C:\Program Files\cloudflared\cloudflared.exe"
if not exist "%CLOUDFLARED%" (
  echo Nu gasesc cloudflared. Instaleaza-l cu:  winget install Cloudflare.cloudflared
  pause
  exit /b 1
)

if not exist node_modules (
  echo Instalez bibliotecile...
  call npm install --no-fund --no-audit
)

rem The server reads the public link from this log, to show it in the waiting room.
set "REMI_TUNNEL_LOG=%TEMP%\remi-tunnel.log"
if exist "%REMI_TUNNEL_LOG%" del "%REMI_TUNNEL_LOG%"

start "Remi - server" cmd /k node server\index.js
timeout /t 2 /nobreak >nul
start "Remi - tunel" /min "%CLOUDFLARED%" tunnel --no-autoupdate --url http://localhost:3000 --logfile "%REMI_TUNNEL_LOG%"

echo Astept linkul public...
powershell -NoProfile -Command "$u=$null; for($i=0;$i -lt 60 -and -not $u;$i++){ Start-Sleep 1; if(Test-Path $env:REMI_TUNNEL_LOG){ $m=Select-String -Path $env:REMI_TUNNEL_LOG -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' | Select-Object -First 1; if($m){ $u=$m.Matches[0].Value } } }; if($u){ Set-Clipboard $u; Write-Host ''; Write-Host '  Link pentru prieteni:' $u; Write-Host '  (copiat in clipboard)'; Write-Host '' } else { Write-Host 'Nu am primit linkul. Verifica fereastra Remi - tunel.' }"

start "" http://localhost:3000
echo Pe calculatorul tau poti juca si la http://localhost:3000
echo Linkul se schimba de fiecare data cand pornesti din nou.
echo.
pause
