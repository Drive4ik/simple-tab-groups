@echo off
call "rsvars.bat"
msbuild "%~dp0STGHost.dproj" /t:Build /p:Config=Release /p:Platform=Win32
