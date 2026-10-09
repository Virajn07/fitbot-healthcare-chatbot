@echo off
setlocal EnableExtensions

set "PROJECT=%~dp0"
set "OLLAMA_URL=http://127.0.0.1:11434/api/tags"
set "FITBOT_URL=http://127.0.0.1:5000/api/version"
set "FITBOT_BUILD=fitbot-chat-ui-v7"
set "MODEL_TAG=qwen3:8b"

if not exist "%PROJECT%app.py" (
    echo FitBot app.py was not found beside this launcher.
    exit /b 1
)

rem Detect the known custom model folder, then the standard Ollama location.
if not defined OLLAMA_MODELS if exist "D:\AI\Models\manifests\registry.ollama.ai\library\qwen3\8b" set "OLLAMA_MODELS=D:\AI\Models"
if not defined OLLAMA_MODELS if exist "%USERPROFILE%\.ollama\models\manifests\registry.ollama.ai\library\qwen3\8b" set "OLLAMA_MODELS=%USERPROFILE%\.ollama\models"

if defined OLLAMA_MODELS if exist "%OLLAMA_MODELS%\manifests\registry.ollama.ai\library\qwen3\8b" goto model_files_found
echo Ollama model files were not detected; continuing without the local backup.
goto start_fitbot

:model_files_found
curl.exe --silent --fail --max-time 2 "%OLLAMA_URL%" 2>nul | findstr.exe /c:"%MODEL_TAG%" >nul
if not errorlevel 1 goto ollama_ready

curl.exe --silent --fail --max-time 2 "%OLLAMA_URL%" >nul 2>&1
if not errorlevel 1 goto ollama_running_without_model

where ollama.exe >nul 2>&1
if errorlevel 1 goto ollama_not_installed
echo Starting Ollama in the background...
start "FitBot local Ollama" /min cmd.exe /c "set OLLAMA_MODELS=%OLLAMA_MODELS%&& ollama serve"
for /l %%i in (1,1,15) do (
    timeout /t 1 /nobreak >nul
    curl.exe --silent --fail --max-time 2 "%OLLAMA_URL%" 2>nul | findstr.exe /c:"%MODEL_TAG%" >nul
    if not errorlevel 1 goto ollama_ready
)
echo Ollama is still starting. FitBot will continue; check its model status in the app.
goto start_fitbot

:ollama_ready
echo Ollama is ready with %MODEL_TAG%.
goto start_fitbot

:ollama_running_without_model
echo Ollama is already running but %MODEL_TAG% is not available from that service.
echo Restart it with OLLAMA_MODELS set to your model folder to enable local replies.
goto start_fitbot

:ollama_not_installed
echo Ollama was not found. FitBot will start without its local backup.
goto start_fitbot

:start_fitbot
curl.exe --silent --fail --max-time 2 "%FITBOT_URL%" 2>nul | findstr.exe /c:"%FITBOT_BUILD%" >nul
if not errorlevel 1 goto fitbot_ready
curl.exe --silent --fail --max-time 2 "http://127.0.0.1:5000/login" >nul 2>&1
if not errorlevel 1 goto older_fitbot_running

if exist "%PROJECT%.venv\Scripts\python.exe" (
    set "PYTHON_EXE=%PROJECT%.venv\Scripts\python.exe"
) else (
    where python.exe >nul 2>&1
    if errorlevel 1 goto python_missing
    set "PYTHON_EXE=python"
)

echo Starting FitBot Health...
start "FitBot Health" /min /D "%PROJECT%" "%PYTHON_EXE%" app.py
for /l %%i in (1,1,45) do (
    timeout /t 1 /nobreak >nul
    curl.exe --silent --fail --max-time 2 "%FITBOT_URL%" 2>nul | findstr.exe /c:"%FITBOT_BUILD%" >nul
    if not errorlevel 1 goto fitbot_ready
)
echo FitBot did not become ready. Check Python dependencies or port 5000.
exit /b 1

:fitbot_ready
echo FitBot is ready at http://127.0.0.1:5000
start "" "http://127.0.0.1:5000"
exit /b 0

:older_fitbot_running
echo A FitBot server is already running on port 5000 with a different build.
echo Stop the existing server, then run this launcher again.
exit /b 1

:python_missing
echo Python was not found. Install Python 3.10 or newer and its dependencies first.
exit /b 1
