@echo off
setlocal
title On The Way Logistics - Secure Admin Login Setup
cd /d "%~dp0backend"
where node >nul 2>nul
if errorlevel 1 (echo Install Node.js 20 LTS or newer first.& pause& exit /b 1)
if not exist node_modules (echo Run START-WINDOWS.bat once first so dependencies are installed.& pause& exit /b 1)
if not exist payments.sqlite (echo Database not found. Run START-WINDOWS.bat once, then stop it and run this setup again.& pause& exit /b 1)
echo.
echo This will RESET the temporary passwords for all four admin accounts
echo in this extracted project's backend\payments.sqlite database.
echo The new credentials will be verified and saved in this backend folder.
echo.
choice /C YN /N /M "Continue? [Y/N] "
if errorlevel 2 exit /b 0
node setup-admin-credentials.js
if errorlevel 1 (echo Admin credential setup failed. Read the error above.& pause& exit /b 1)
echo.
echo Use ONLY the newly generated credentials shown above.
echo Credentials file: backend\ADMIN-TEMPORARY-LOGIN-CREDENTIALS.txt
pause
