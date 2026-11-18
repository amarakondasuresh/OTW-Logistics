@echo off
setlocal
title On The Way Logistics - Reset an admin password
cd /d "%~dp0backend"
where node >nul 2>nul
if errorlevel 1 (echo Install Node.js 20 LTS or newer first.& pause& exit /b 1)
if not exist node_modules (echo Run START-WINDOWS.bat once first so the packages are installed.& pause& exit /b 1)
if exist payments.sqlite goto have_db
echo No database found in this folder:
echo "%CD%"
echo Run this file from the same project folder you start the server from.
pause
exit /b 1

:have_db
echo.
node reset-admin-password.js --list
if errorlevel 1 (pause& exit /b 1)
echo.
echo The server window must show this same folder on its "Database:" line.
echo.
set "ADMIN_EMAIL="
set /p "ADMIN_EMAIL=Type the email of the admin to reset, then press Enter (just Enter cancels): "
if not defined ADMIN_EMAIL exit /b 0
echo.
node reset-admin-password.js "%ADMIN_EMAIL%"
if errorlevel 1 (echo.& echo Nothing was changed. Check the email and try again.& pause& exit /b 1)
echo.
echo Next: open http://localhost:8080/dashboard/ and sign in with that email and the
echo temporary password above, then choose your own password and keep it safe.
echo If the page says "Too many sign-in attempts", close the server window,
echo run START-WINDOWS.bat again, and sign in.
echo.
pause
