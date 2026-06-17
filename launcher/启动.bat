@echo off
setlocal
chcp 65001 >nul
title designforge

rem ===== designforge 启动器 =====
rem 解压后双击本文件即可。无需安装 Node 或下载浏览器。
set "ROOT=%~dp0"
set "NODE=%ROOT%runtime\node.exe"
set "APP=%ROOT%app\dist\cli.js"
set "PLAYWRIGHT_BROWSERS_PATH=%ROOT%browser"

if not exist "%NODE%" (
  echo [!] 未找到内置 Node 运行时: %NODE%
  echo     请确认已完整解压压缩包。
  pause
  exit /b 1
)

echo.
echo   正在启动 designforge 本地服务...
echo   稍候将自动打开浏览器界面。关闭此窗口即可停止。
echo.

"%NODE%" "%APP%" serve

echo.
echo   designforge 已停止。
pause
