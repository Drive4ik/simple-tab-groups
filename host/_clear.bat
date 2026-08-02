@echo off
del *.res
del /s /q *.dcu 2>nul
del /s /q *.bak 2>nul
del /s /q *.old 2>nul
del /s /q *.ddp 2>nul
del /s /q *.rsm 2>nul
del *.drc
del *.vlb
del *.dproj.local
del *.identcache
rd /s /q cache 2>nul
