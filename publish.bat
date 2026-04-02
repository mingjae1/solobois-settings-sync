@echo off
setlocal

set "BUMP_MODE=none"
set "NO_PAUSE="

for %%A in (%*) do (
    if /i "%%~A"=="--no-bump" set "BUMP_MODE=none"
    if /i "%%~A"=="--bump-patch" set "BUMP_MODE=patch"
    if /i "%%~A"=="--bump-minor" set "BUMP_MODE=minor"
    if /i "%%~A"=="--bump-major" set "BUMP_MODE=major"
    if /i "%%~A"=="--no-pause" set "NO_PAUSE=1"
    if /i "%%~A"=="--help" set "SHOW_HELP=1"
)

if /i "%SHOW_HELP%"=="1" (
    echo Usage: publish.bat [options]
    echo.
    echo Options:
    echo   --no-bump      Publish current package version ^(default^)
    echo   --bump-patch   Bump patch version before publish
    echo   --bump-minor   Bump minor version before publish
    echo   --bump-major   Bump major version before publish
    echo   --no-pause     Do not pause at the end
    echo.
    exit /b 0
)

echo Loading environment variables...
for %%f in (.env token.env) do (
    if exist %%f (
        echo Loading from %%f...
        for /f "usebackq tokens=1,2 delims==" %%a in ("%%f") do (
            set %%a=%%b
        )
    )
)

if not exist .\node_modules\.bin\vsce.cmd (
    echo Installing dependencies...
    call npm ci
    if %ERRORLEVEL% neq 0 exit /b %ERRORLEVEL%
)

if /i "%BUMP_MODE%"=="none" (
    echo Skipping version bump ^(default mode: publish current version^)
) else (
    echo Bumping version: %BUMP_MODE%
    call npm version %BUMP_MODE% --no-git-tag-version
    if %ERRORLEVEL% neq 0 exit /b %ERRORLEVEL%
)

echo Building and Packaging...
call npm run package

if %ERRORLEVEL% neq 0 (
    echo Build failed! Exiting...
    exit /b %ERRORLEVEL%
)

echo Publishing to VS Code Marketplace...
call .\node_modules\.bin\vsce.cmd publish
if %ERRORLEVEL% neq 0 (
    echo VSCE Publish failed!
    exit /b %ERRORLEVEL%
)

echo Publishing to Open VSX...
if "%OVSX_PAT%"=="" (
    echo ERROR: OVSX_PAT environment variable is not set.
    echo Please set it in .env file: OVSX_PAT=your_token
    exit /b 2
)
call .\node_modules\.bin\ovsx.cmd publish -p %OVSX_PAT%
if %ERRORLEVEL% neq 0 (
    echo Open VSX Publish failed!
    exit /b %ERRORLEVEL%
)

:version
for /f %%v in ('node -p "require('./package.json').version"') do set VERSION=%%v
echo.
echo Published version: %VERSION%
echo Tip: push a tag v%VERSION% to trigger GitHub Release workflow.

if "%NO_PAUSE%"=="" pause
exit /b 0
