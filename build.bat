@echo off
setlocal

set "NO_PAUSE="
if /i "%~1"=="--no-pause" set "NO_PAUSE=1"

if not exist node_modules (
  echo Installing dependencies...
  call npm ci
  if %ERRORLEVEL% neq 0 exit /b %ERRORLEVEL%
)

echo Building (webpack)...
call npm run package
if %ERRORLEVEL% neq 0 exit /b %ERRORLEVEL%

echo Packaging VSIX...
call .\node_modules\.bin\vsce.cmd package
if %ERRORLEVEL% neq 0 exit /b %ERRORLEVEL%

echo Done.
if "%NO_PAUSE%"=="" pause
