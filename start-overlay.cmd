@echo off
rem start-overlay.cmd - the floating microphone button, with a console window that shows the log.
rem Use this one to watch what the button does; use start-overlay.vbs to run it without a window.
chcp 65001 >nul
cd /d "%~dp0"
title Voice to Text - floating button
if "%VTT_NODE%"=="" (set "NODE=node") else (set "NODE=%VTT_NODE%")
"%NODE%" "%~dp0bin\vtt.mjs" overlay --log %*
pause
