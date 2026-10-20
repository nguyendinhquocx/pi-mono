@echo off
setlocal EnableExtensions DisableDelayedExpansion
rem li - source-built Pi fork launcher (branch li/stable).
rem Keeps the shared Pi profile: maps PI_* profile vars to their LI_* names,
rem pins every runtime path to this worktree, and never touches global Pi.

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

where node >nul 2>nul || goto :no_node

rem --version prints from the build receipt without starting the CLI.
if "%~1"=="--version" goto :version
if "%~1"=="-v" goto :version

if not exist "%PI_CORE_CLI_PATH%" goto :no_build

rem Preserve the caller's CWD: node inherits it and Pi reads project resources from it.
node "%PI_CORE_CLI_PATH%" %*
exit /b %ERRORLEVEL%

:version
node -e "const fs=require('fs');let r;try{r=JSON.parse(fs.readFileSync(process.argv[1],'utf8'))}catch(e){console.error('[li] Li build receipt missing or unreadable: '+process.argv[1]);console.error('[li] Build Li first: node scripts/build-li.mjs');process.exit(1)};console.log('li '+(r.baseVersion||'?')+' (source '+(r.shortSha||'?')+')')" "%PI_PACKAGE_DIR%\dist\li-build-receipt.json"
exit /b %ERRORLEVEL%

:no_node
echo [li] node was not found on PATH. Install Node.js ^>=22.19 first. 1>&2
exit /b 1

:no_build
echo [li] Li CLI build not found: %PI_CORE_CLI_PATH% 1>&2
echo [li] Build Li first: cd /d "%LI_ROOT%" then: node scripts/build-li.mjs 1>&2
exit /b 1

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
