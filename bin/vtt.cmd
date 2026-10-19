@echo off
rem Windows shim for the vtt command line.
rem Put this directory on PATH, or add it to a shortcut, and "vtt <command>" works from anywhere.
rem Set VTT_NODE to use a specific node.exe instead of the first one on PATH.
setlocal
if not defined VTT_NODE set "VTT_NODE=node"
"%VTT_NODE%" "%~dp0vtt.mjs" %*
exit /b %ERRORLEVEL%
