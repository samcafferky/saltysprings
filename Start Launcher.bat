@echo off
title OGFN Launcher
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. Get it from https://nodejs.org & pause & exit /b 1)
if not exist node_modules (echo Installing for the first time... & call npm install)
call npm run launcher
pause
