@echo off
rem Windows: run bin\wh from cmd.exe or PowerShell (`bin\wh.cmd ...`). Git Bash and Claude sessions use bin/wh itself.
node --no-warnings "%~dp0..\scripts\wh.ts" %*
