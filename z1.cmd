@echo off
setlocal
if defined Z1_NODE (
  set "NODE=%Z1_NODE%"
) else (
  set "NODE=node"
)
"%NODE%" "%~dp0z1.mjs" %*
exit /b %ERRORLEVEL%
