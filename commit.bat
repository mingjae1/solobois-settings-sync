@echo off
setlocal

set "NO_PAUSE="
if /i "%~1"=="--no-pause" (
  set "NO_PAUSE=1"
  shift
)

:: Get the commit message from arguments, default to "Update settings"
set "msg=%~1"
if "%msg%"=="" set "msg=Update settings (%date% %time%)"

echo Starting commit and push process...
echo ----------------------------------

:: Add all changes
echo [1/3] Staging changes...
git add .

:: Commit
echo [2/3] Committing changes with message: "%msg%"
git commit -m "%msg%"

:: Push (to origin which has both GitHub and GitLab)
echo [3/3] Pushing to GitHub and GitLab...
git push origin

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
  )
)

echo ----------------------------------
echo Done!
if "%NO_PAUSE%"=="" pause
