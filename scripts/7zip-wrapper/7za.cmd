@echo off
"F:\Projects\Agents\jarvis-agent-test\node_modules\7zip-bin\win\x64\7za.exe" %*
set E=%ERRORLEVEL%
if %E% EQU 0 exit /b 0
if %E% EQU 2 exit /b 0
exit /b %E%
