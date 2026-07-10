# PowerShell startup script for GitVeritas Consistency Auditor
Write-Host "[GitVeritas] Starting Resume vs GitHub Consistency Auditor..." -ForegroundColor Cyan

# Check if .venv exists
if (-not (Test-Path ".\.venv")) {
    Write-Host "Creating python virtual environment..." -ForegroundColor Yellow
    python -m venv .venv
}

# Activate virtual environment
Write-Host "Activating virtual environment..." -ForegroundColor Yellow
& .\.venv\Scripts\Activate.ps1

# Check if dependencies are already installed
& python -c "import fastapi, uvicorn, pypdf, docx, httpx" 2>$null
if ($LastExitCode -ne 0) {
    Write-Host "Dependencies missing or incomplete. Installing dependencies..." -ForegroundColor Yellow
    python -m pip install --upgrade pip --timeout 10
    pip install -r backend/requirements.txt --timeout 15
} else {
    Write-Host "[OK] Dependencies are already satisfied. Skipping online checks." -ForegroundColor Green
}

# Start the uvicorn server
Write-Host "[SERVER] Launching FastAPI server..." -ForegroundColor Green
Write-Host "Open your browser at: http://127.0.0.1:8000" -ForegroundColor Cyan
uvicorn backend.app:app --host 127.0.0.1 --port 8000 --reload
