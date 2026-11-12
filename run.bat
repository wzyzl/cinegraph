@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "PY=python"
set "DSHPY=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe"
if exist "%DSHPY%" set "PY=%DSHPY%"

echo ============================================
echo   帧鉴 · Cinegraph
echo   浏览器:  http://127.0.0.1:7788
echo   python:  %PY%
echo ============================================
echo.

start "" http://127.0.0.1:7788
"%PY%" server.py

echo.
echo 服务已停止。
pause
