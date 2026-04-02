@echo off
setlocal

REM Full release flow:
REM 1) Ensure clean working tree
REM 2) Bump version (patch by default)
REM 3) Finalize CHANGELOG.md: move [Unreleased] -> [X.Y.Z]
REM 4) Publish to VS Code Marketplace + Open VSX
REM 5) Commit + tag vX.Y.Z + push (tag triggers GitHub Release workflow)

set "BUMP=patch"
set "NO_PAUSE="
if /i "%~1"=="--no-pause" (
  set "NO_PAUSE=1"
  shift
)
if not "%~1"=="" set "BUMP=%~1"

for /f "delims=" %%s in ('git status --porcelain') do (
  echo Release aborted: working tree not clean. Please commit/stash changes first.
  if "%NO_PAUSE%"=="" pause
  exit /b 10
)

echo Bumping version: %BUMP%
call npm version %BUMP% --no-git-tag-version
if errorlevel 1 exit /b %ERRORLEVEL%

for /f %%v in ('node -p "require('./package.json').version"') do set VERSION=%%v
set TAG=v%VERSION%

echo Finalizing CHANGELOG.md for %VERSION%...
for /f %%d in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd"') do set RELDATE=%%d
call node scripts\finalize-changelog.mjs %VERSION% %RELDATE%
if errorlevel 1 (
  echo Release aborted: failed to finalize CHANGELOG.md (make sure [Unreleased] has notes).
  if "%NO_PAUSE%"=="" pause
  exit /b %ERRORLEVEL%
)

git rev-parse "%TAG%" >nul 2>nul
if not errorlevel 1 (
  echo Release aborted: git tag "%TAG%" already exists.
  if "%NO_PAUSE%"=="" pause
  exit /b 3
)

echo Publishing marketplaces...
set "NO_PAUSE=1"
call publish.bat --no-bump --no-pause
if errorlevel 1 (
  echo Release aborted: publish.bat failed.
  if "%NO_PAUSE%"=="" pause
  exit /b %ERRORLEVEL%
)

echo.
echo Committing release changes...
git add package.json package-lock.json README.md CHANGELOG.md
git commit -m "Release %TAG%"
if errorlevel 1 exit /b %ERRORLEVEL%

echo.
echo Tagging %TAG%...
git tag "%TAG%"
if errorlevel 1 exit /b %ERRORLEVEL%

echo.
echo Pushing commit and tag (this triggers GitHub Actions release)...
git push origin
if errorlevel 1 exit /b %ERRORLEVEL%

REM If origin's default branch is different (e.g. origin/HEAD -> origin/master),
REM also push the current HEAD to that default branch to avoid manual GitHub merges.
for /f "delims=" %%h in ('git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2^>nul') do set ORIGIN_HEAD=%%h
for /f "delims=" %%b in ('git symbolic-ref --short HEAD') do set CURRENT_BRANCH=%%b
if not "%ORIGIN_HEAD%"=="" (
  for /f "tokens=2 delims=/" %%d in ("%ORIGIN_HEAD%") do set DEFAULT_BRANCH=%%d
  if not "%DEFAULT_BRANCH%"=="" if /i not "%CURRENT_BRANCH%"=="%DEFAULT_BRANCH%" (
    echo Detected origin default branch: %DEFAULT_BRANCH% (current: %CURRENT_BRANCH%)
    echo Also pushing HEAD -> %DEFAULT_BRANCH%...
    git push origin HEAD:%DEFAULT_BRANCH%
    if errorlevel 1 exit /b %ERRORLEVEL%
  )
)

git push origin "%TAG%"
if errorlevel 1 exit /b %ERRORLEVEL%

echo.
echo Done: %TAG% published and pushed.
if "%NO_PAUSE%"=="" pause
