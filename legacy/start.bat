@echo off
setlocal
cd /d "%~dp0"
title MistWalk - local exploration system
where python >nul 2>nul
if %errorlevel%==0 (
  python server.py --open
  goto :done
)
where py >nul 2>nul
if %errorlevel%==0 (
  py -3 server.py --open
  goto :done
)
echo.
echo Python 3 was not found.
echo Install Python from https://www.python.org/downloads/ and run this file again.
echo.
pause
:done
endlocal
