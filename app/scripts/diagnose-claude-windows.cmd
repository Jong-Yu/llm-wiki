@echo off
setlocal DisableDelayedExpansion
set "DIAGNOSTIC_ROOT=%~dp0"
set "DIAGNOSTIC_PYTHON=%~dp0resources\personal-runtime\python\python.exe"
set "DIAGNOSTIC_RUNTIME=%~dp0resources\personal-runtime"
if not exist "%DIAGNOSTIC_PYTHON%" goto missing
if not exist "%DIAGNOSTIC_ROOT%claude_call_diagnostic.py" goto missing
"%DIAGNOSTIC_PYTHON%" -B "%DIAGNOSTIC_ROOT%claude_call_diagnostic.py" --runtime "%DIAGNOSTIC_RUNTIME%" --output "%DIAGNOSTIC_ROOT%claude-connection-report.txt" --test --open-report
if errorlevel 2 goto failed
exit /b
:missing
echo Place both diagnostic files beside LLM Wiki.exe, then try again.
pause
exit /b 2
:failed
echo The report could not be created. Please keep this window open.
pause
exit /b 2
