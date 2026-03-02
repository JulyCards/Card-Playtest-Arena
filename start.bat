@echo off
echo.
echo ============================================
echo   MTG Commander Arena
echo ============================================
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do (
    set IP=%%a
)
set IP=%IP: =%
echo   Local:   http://localhost:2222
echo   Network: http://%IP%:2222
echo ============================================
echo.
start http://localhost:2222
node server.js
