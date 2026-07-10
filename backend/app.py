import os
import shutil
import tempfile
from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from typing import Optional

from backend.resume_parser import ResumeParser
from backend.github_client import GitHubClient
from backend.analyzer import ConsistencyAuditor

app = FastAPI(
    title="Resume vs GitHub Consistency Auditor API",
    description="Backend API to parse resumes, scrape GitHub, and perform semantic/temporal audits.",
    version="1.0.0"
)

# Enable CORS for local development
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Initialize components
resume_parser = ResumeParser()
auditor = ConsistencyAuditor()

@app.post("/api/audit")
async def run_audit(
    resume: UploadFile = File(...),
    github_username: str = Form(...),
    github_token: Optional[str] = Form(None)
):
    """
    Parses the uploaded resume, fetches GitHub details,
    and returns consistency analysis.
    """
    if not github_username.strip():
        raise HTTPException(status_code=400, detail="GitHub username is required.")
        
    filename = resume.filename
    ext = os.path.splitext(filename)[1].lower()
    if ext not in [".pdf", ".docx"]:
        raise HTTPException(status_code=400, detail="Unsupported file format. Please upload PDF or DOCX.")

    # Create a temporary file to save the uploaded resume
    with tempfile.NamedTemporaryFile(delete=False, suffix=ext) as temp_file:
        shutil.copyfileobj(resume.file, temp_file)
        temp_path = temp_file.name

    try:
        # 1. Parse Resume
        print(f"Parsing resume: {filename}")
        resume_data = resume_parser.parse(temp_path)
        
        # 2. Analyze GitHub
        print(f"Analyzing GitHub profile for: {github_username}")
        github_client = GitHubClient(token=github_token)
        github_data = await github_client.analyze_user(github_username)
        
        # 3. Perform Audit
        print("Auditing consistency...")
        audit_results = auditor.audit(resume_data, github_data)
        
        # 4. Construct response
        return {
            "success": True,
            "username": github_username,
            "profile": {
                "name": github_data["profile"].get("name") or github_username,
                "avatar_url": github_data["profile"].get("avatar_url"),
                "bio": github_data["profile"].get("bio"),
                "public_repos": github_data["profile"].get("public_repos", 0),
                "followers": github_data["profile"].get("followers", 0),
                "created_at": github_data["profile"].get("created_at"),
            },
            "audit": audit_results,
            "repositories_scanned": len(github_data["repositories"]),
            "collaborative_prs_count": github_data["collaborative_prs_count"]
        }

    except ValueError as ve:
        raise HTTPException(status_code=400, detail=str(ve))
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Auditing failed: {str(e)}")
    finally:
        # Clean up temporary file
        if os.path.exists(temp_path):
            os.remove(temp_path)
# Serve Frontend static files if directory exists
FRONTEND_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "frontend")
if os.path.exists(FRONTEND_DIR):
    # Route for serving the landing page
    @app.get("/")
    async def serve_home():
        index_path = os.path.join(FRONTEND_DIR, "index.html")
        if os.path.exists(index_path):
            return FileResponse(index_path)
        return {"message": "Backend is running. Frontend index.html not found."}
        
    # Mount frontend files at root (styles.css, app.js etc.)
    app.mount("/", StaticFiles(directory=FRONTEND_DIR), name="frontend")
else:
    @app.get("/")
    async def home_fallback():
        return {"message": "Backend API is running. Frontend static directory not found."}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host="127.0.0.1", port=8000, reload=True)
