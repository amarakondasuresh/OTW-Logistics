@echo off
setlocal
 title On The Way Logistics - Server
cd /d "%~dp0backend"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Node.js is not installed.
  echo  Download and install Node.js 20 LTS or newer from https://nodejs.org
  echo  Then close this window and run START-WINDOWS.bat again.
  echo.
  pause
  exit /b 1
)

for /f "tokens=1 delims=v." %%A in ('node --version') do set NODE_MAJOR=%%A
if %NODE_MAJOR% LSS 20 (
  echo.
  echo  Your Node.js version is too old: 
  node --version
  echo  This project requires Node.js 20 LTS or newer.
  echo  Install the current LTS version from https://nodejs.org and try again.
  echo.
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo npm was not found. Reinstall Node.js LTS from https://nodejs.org.
  pause
  exit /b 1
)

if not exist ".env" copy ".env.example" ".env" >nul

rem Install packages the first time, and again whenever package.json changes.
fc /b "package.json" "node_modules\.installed-package.json" >nul 2>nul
if not errorlevel 1 goto packages_ok
echo Installing required packages, please wait...
call npm install --no-audit --no-fund
if errorlevel 1 goto install_failed
if not exist "node_modules" mkdir "node_modules"
copy /y "package.json" "node_modules\.installed-package.json" >nul

goto packages_ok

:install_failed
echo.
echo  Package installation failed. Check your internet connection and try again.
echo  If the error mentions node-gyp or better-sqlite3, install Node.js 20 LTS or newer.
pause
exit /b 1

:packages_ok
rem If an older copy of the server is still running, the browser would show that copy instead of this one.
node check-port.js
if errorlevel 1 goto port_busy
echo.
echo  Starting the server. Keep this window open.
echo  The Admin Portal will open automatically in your browser.
echo.

rem Wait briefly for the backend to start, then open the actual Admin Portal (not the public website).
start "" powershell.exe -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 3; Start-Process 'http://localhost:8080/dashboard/'"
call npm start

echo.
echo  The server has stopped. Read the error above, then restart this file.
pause
exit /b

:port_busy
echo.
echo  The server was NOT started, so the browser was not opened.
pause
exit /b 1
