@echo off
rem Double-click launcher for dictation mode: press ctrl+alt+space to start/stop recording and the
rem recognized text is pasted into whatever window has focus. Keep this window open while dictating;
rem closing it (or ctrl+c) stops the tool.
chcp 65001 >nul
cd /d "%~dp0"
title Voice to Text - dictate (ctrl+alt+space)
node "%~dp0bin\vtt.mjs" dictate %*
echo.
echo Dictation stopped. Press any key to close this window.
pause >nul
