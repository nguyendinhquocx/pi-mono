@echo off
setlocal EnableExtensions DisableDelayedExpansion
rem li - source-built Pi fork launcher (branch li/stable).
rem Keeps the shared Pi profile: maps PI_* profile vars to their LI_* names,
rem pins every runtime path to this worktree, and never touches global Pi.
rem Bundle lifecycle (SPEC-2026-11-28): when the bundle is missing this launcher
rem journals missing-detected, takes the build lock and restores the newest
rem bundle.old-<attemptId> marker BEFORE the --version branch; while a live
rem build holds the lock it waits ~3s and fails with a journal entry instead of
rem racing the swap. Journal schema is shared verbatim with build-li.mjs.

rem Canonical Li worktree root (parent of this bin directory).
for %%I in ("%~dp0..") do set "LI_ROOT=%%~fI"

rem Fail closed when PI_* and LI_* disagree about the profile.
if defined PI_CODING_AGENT_DIR if defined LI_CODING_AGENT_DIR if /I not "%PI_CODING_AGENT_DIR%"=="%LI_CODING_AGENT_DIR%" goto :conflict_agent
if defined PI_CODING_AGENT_SESSION_DIR if defined LI_CODING_AGENT_SESSION_DIR if /I not "%PI_CODING_AGENT_SESSION_DIR%"=="%LI_CODING_AGENT_SESSION_DIR%" goto :conflict_session

rem Alias the shared Pi profile into the LI_* names when not set yet.
if defined PI_CODING_AGENT_DIR if not defined LI_CODING_AGENT_DIR set "LI_CODING_AGENT_DIR=%PI_CODING_AGENT_DIR%"
if defined PI_CODING_AGENT_SESSION_DIR if not defined LI_CODING_AGENT_SESSION_DIR set "LI_CODING_AGENT_SESSION_DIR=%PI_CODING_AGENT_SESSION_DIR%"

set "LI_RUNTIME=1"
set "PI_PACKAGE_DIR=%LI_ROOT%\packages\coding-agent"
set "PI_CORE_CLI_PATH=%PI_PACKAGE_DIR%\dist\bundle\cli.js"
set "PI_OSC_GUARD_DIST=%PI_PACKAGE_DIR%\dist"
set "PI_SKIP_VERSION_CHECK=1"
set "LI_DIST_DIR=%PI_PACKAGE_DIR%\dist"
set "LI_LOCK_DIR=%LI_DIST_DIR%\.bundle-lock"
set "LI_TMP_RECEIPT=%LI_DIST_DIR%\li-build-receipt.json.tmp"

where node >nul 2>nul || goto :no_node

set "LI_JOURNAL=%LI_BUILD_JOURNAL%"
if not defined LI_JOURNAL set "LI_JOURNAL=%USERPROFILE%\.pi\agent\li-build-journal.jsonl"

if exist "%PI_CORE_CLI_PATH%" goto :cli_ready

rem === missing bundle: fail-closed recovery BEFORE the --version branch ===
set /a LI_WAIT_ROUNDS=0

:recover_loop
if %LI_WAIT_ROUNDS% GEQ 5 goto :recover_giveup
md "%LI_LOCK_DIR%" >nul 2>nul
if errorlevel 1 goto :recover_held

rem We own the lock: record the owner, then restore the newest old marker.
rem PS commands are chunked into short vars: cmd's label scanner misses labels
rem that follow very long lines in LF-ended .cmd files.
set "LI_PS_O1=$p=$PID;try{$p=(Get-CimInstance Win32_Process -Filter ('ProcessId={0}' -f $PID)).ParentProcessId}catch{};"
set "LI_PS_O2=$s='';try{$s=(Get-Process -Id $p).StartTime.ToFileTime()}catch{};"
set "LI_PS_O3=[IO.File]::WriteAllText(($env:LI_LOCK_DIR+'\owner.json'),(ConvertTo-Json ([pscustomobject]@{pid=[int]$p;start=''+$s})))"
powershell -NoProfile -Command "%LI_PS_O1%%LI_PS_O2%%LI_PS_O3%" >nul 2>nul
set "LI_BEST_OLD="
for /f "delims=" %%D in ('dir /b /ad "%LI_DIST_DIR%\bundle.old-*" 2^>nul') do call :consider_old "%%D"
if defined LI_BEST_OLD goto :do_restore
call :journal missing-detected "no bundle.old-* marker with cli.js"
call :release_lock
goto :no_build

:do_restore
if exist "%LI_DIST_DIR%\bundle\" goto :restore_conflict
move /y "%LI_DIST_DIR%\%LI_BEST_OLD%" "%LI_DIST_DIR%\bundle" >nul 2>nul
if exist "%PI_CORE_CLI_PATH%" goto :restore_ok
call :journal missing-detected "restore failed from %LI_BEST_OLD%"
call :release_lock
goto :no_build

:restore_conflict
call :journal missing-detected "bundle dir exists without cli.js; refusing to restore over it"
call :release_lock
goto :no_build

:restore_ok
if exist "%LI_TMP_RECEIPT%" del /f /q "%LI_TMP_RECEIPT%" >nul 2>nul
call :journal recovered "restored %LI_BEST_OLD%"
call :release_lock
goto :cli_ready

:recover_held
set /a LI_WAIT_ROUNDS+=1
ping -n 2 127.0.0.1 >nul
if exist "%PI_CORE_CLI_PATH%" goto :cli_ready
if %LI_WAIT_ROUNDS% LSS 3 goto :recover_loop
call :lock_state
if /i "%LOCK_STATE%"=="stale" (
    rd /s /q "%LI_LOCK_DIR%" >nul 2>nul
    goto :recover_loop
)
call :journal missing-detected "bundle missing; build in progress (lock state %LOCK_STATE%)"
goto :no_build_busy

:recover_giveup
call :journal missing-detected "bundle missing; lock unresolved after bounded wait"
goto :no_build_busy

:cli_ready
rem --version prints from the build receipt without starting the CLI.
if "%~1"=="--version" goto :version
if "%~1"=="-v" goto :version

rem Preserve the caller's CWD: node inherits it and Pi reads project resources from it.
node "%PI_CORE_CLI_PATH%" %*
exit /b %ERRORLEVEL%

:version
node -e "const fs=require('fs');let r;try{r=JSON.parse(fs.readFileSync(process.argv[1],'utf8'))}catch(e){console.error('[li] Li build receipt missing or unreadable: '+process.argv[1]);console.error('[li] Build Li first: node scripts/build-li.mjs');process.exit(1)};console.log('li '+(r.baseVersion||'?')+' (source '+(r.gitShortSha||'?')+')')" "%PI_PACKAGE_DIR%\dist\li-build-receipt.json"
exit /b %ERRORLEVEL%

:no_node
echo [li] node was not found on PATH. Install Node.js ^>=22.19 first. 1>&2
exit /b 1

:no_build
echo [li] Li CLI build not found: %PI_CORE_CLI_PATH% 1>&2
echo [li] Build Li first: cd /d "%LI_ROOT%" then: node scripts/build-li.mjs 1>&2
exit /b 1

:no_build_busy
echo [li] Li CLI build not found and a build appears to be running (lock: %LI_LOCK_DIR%). 1>&2
echo [li] Wait for the build to finish and run li again. Journal: %LI_JOURNAL% 1>&2
exit /b 1

:consider_old
set "LI_CAND=%~1"
rem attemptId = 13-digit epoch + dash + pid. 'c' of old-consumed never matches.
set "LI_ID=%LI_CAND:~11%"
echo %LI_ID%|findstr /r /c:"^[0-9][0-9]*-[0-9][0-9]*$" >nul || exit /b 0
if not "%LI_ID:~13,1%"=="-" exit /b 0
if not exist "%LI_DIST_DIR%\%LI_CAND%\cli.js" exit /b 0
if defined LI_BEST_OLD (
    if /i "%LI_CAND%" GTR "%LI_BEST_OLD%" set "LI_BEST_OLD=%LI_CAND%"
) else (
    set "LI_BEST_OLD=%LI_CAND%"
)
exit /b 0

:release_lock
rd /s /q "%LI_LOCK_DIR%" >nul 2>nul
exit /b 0

:journal
set "LI_J_KIND=%~1"
set "LI_J_DETAIL=%~2"
set "LI_PS_J1=$j=$env:LI_JOURNAL;$d=Split-Path -Parent $j;if(-not(Test-Path -LiteralPath $d)){New-Item -ItemType Directory -Force -Path $d | Out-Null};"
set "LI_PS_J2=$p=$PID;try{$p=(Get-CimInstance Win32_Process -Filter ('ProcessId={0}' -f $PID)).ParentProcessId}catch{};if(-not $p){$p=$PID};"
set "LI_PS_J3=$e=[ordered]@{schemaVersion=1;ts=(Get-Date).ToUniversalTime().ToString('o');kind=$env:LI_J_KIND;pid=[int]$p;liRoot=$env:LI_ROOT;detail=(''+$env:LI_J_DETAIL)};"
set "LI_PS_J4=[IO.File]::AppendAllText($j,((ConvertTo-Json ([pscustomobject]$e) -Compress)+[char]10))"
powershell -NoProfile -Command "%LI_PS_J1%%LI_PS_J2%%LI_PS_J3%%LI_PS_J4%" >nul 2>nul
exit /b 0

:lock_state
set "LOCK_STATE=unknown"
set "LI_PS_L1=$state='unknown';$o=$null;try{$o=Get-Content -Raw -LiteralPath ($env:LI_LOCK_DIR+'\owner.json') | ConvertFrom-Json}catch{};"
set "LI_PS_L2=if($o -and $o.pid){$alive=$false;try{Get-Process -Id $o.pid -ErrorAction Stop | Out-Null;$alive=$true}catch{};"
set "LI_PS_L3=if(-not $alive){$state='stale'}elseif(-not $o.start){$state='alive'}else{$cur='';try{$cur=(Get-Process -Id $o.pid).StartTime.ToFileTime()}catch{};"
set "LI_PS_L4=if((''+$cur) -ne (''+$o.start)){$state='stale'}else{$state='alive'}}};$state"
powershell -NoProfile -Command "%LI_PS_L1%%LI_PS_L2%%LI_PS_L3%%LI_PS_L4%" > "%TEMP%\li-lock-state.tmp" 2>nul
set /p LOCK_STATE=<"%TEMP%\li-lock-state.tmp"
if not defined LOCK_STATE set "LOCK_STATE=unknown"
del /f /q "%TEMP%\li-lock-state.tmp" >nul 2>nul
exit /b 0

:conflict_agent
echo [li] PI_CODING_AGENT_DIR and LI_CODING_AGENT_DIR point to different profiles; refusing to start. 1>&2
echo   PI_CODING_AGENT_DIR=%PI_CODING_AGENT_DIR% 1>&2
echo   LI_CODING_AGENT_DIR=%LI_CODING_AGENT_DIR% 1>&2
echo [li] Unset or align one of them so Li and Pi agree on the shared profile. 1>&2
exit /b 1

:conflict_session
echo [li] PI_CODING_AGENT_SESSION_DIR and LI_CODING_AGENT_SESSION_DIR point to different directories; refusing to start. 1>&2
echo   PI_CODING_AGENT_SESSION_DIR=%PI_CODING_AGENT_SESSION_DIR% 1>&2
echo   LI_CODING_AGENT_SESSION_DIR=%LI_CODING_AGENT_SESSION_DIR% 1>&2
echo [li] Unset or align one of them so Li and Pi agree on the shared session dir. 1>&2
exit /b 1
