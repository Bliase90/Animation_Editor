@echo off
rem Double-click to run the Animation Editor on Windows.
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install the LTS version from https://nodejs.org
  echo then close this window and run start.bat again.
  start "" https://nodejs.org/en/download
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installing dependencies, this takes a minute the first time...
  call npm install
  if errorlevel 1 ( pause & exit /b 1 )
)

rem Open the editor once the build is done and the server is up.
start "" cmd /c "timeout /t 12 >nul & start http://127.0.0.1:7878/"
call npm start
pause
