@echo off
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvarsall.bat" x86
if errorlevel 1 (echo VCVARS FAILED & exit /b 1)
set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
cd /d "C:\Users\enzot\smtc-bridge"
call pnpm exec napi build --platform --release --target i686-pc-windows-msvc
exit /b %ERRORLEVEL%
