@echo off
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
if errorlevel 1 (echo VCVARS FAILED & exit /b 1)
set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
cd /d "C:\Users\enzot\smtc-bridge"
call pnpm run build
exit /b %ERRORLEVEL%
