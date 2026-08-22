const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');

dotenv.config();

const { ResumeParser } = require('./resume_parser');
const { GitHubClient } = require('./github_client');
const { ConsistencyAuditor } = require('./analyzer');

const app = express();
const PORT = process.env.PORT || 8000;

app.use(cors());
app.use(express.json());

// Setup Multer for secure disk storage
const uploadDir = path.join(__dirname, 'temp_uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir);
}
const upload = multer({ dest: uploadDir });

// Main /api/audit endpoint
app.post('/api/audit', upload.single('resume'), async (req, res) => {
    const file = req.file;
    const githubUsername = req.body.github_username;
    const githubToken = req.body.github_token || null;

    if (!file) {
        return res.status(400).json({ error: "Missing uploaded resume file." });
    }
    if (!githubUsername) {
        // Clean up temp file
        if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
        return res.status(400).json({ error: "Missing GitHub username." });
    }

    try {
        // 1. Initialize and Parse Resume
        const parser = new ResumeParser();
        const rawText = await parser.extractText(file.path, file.originalname);
        const skills = parser.extractSkills(rawText);
        const quantifiableClaims = parser.extractQuantifiableClaims(rawText);
        
        const resumeData = {
            skills,
            timeline: {}, // Default empty, populated on demand
            quantifiable_claims: quantifiableClaims
        };

        // 2. Fetch/Scrape GitHub Profile and Code Evidence
        const client = new GitHubClient(githubToken);
        const githubData = await client.analyzeUser(githubUsername);

        // 3. Perform Alignment Consistency Audit
        const auditor = new ConsistencyAuditor();
        const auditResults = await auditor.audit(resumeData, githubData);

        // 4. Return formatted response
        return res.json({
            success: true,
            username: githubUsername,
            profile: {
                name: githubData.profile.name || githubUsername,
                avatar_url: githubData.profile.avatar_url,
                bio: githubData.profile.bio,
                public_repos: githubData.profile.public_repos || 0,
                followers: githubData.profile.followers || 0,
                created_at: githubData.profile.created_at,
            },
            audit: auditResults,
            repositories_scanned: githubData.repositories.length,
            collaborative_prs_count: githubData.collaborative_prs_count
        });
    } catch (error) {
        console.error("Audit processing failed", error);
        return res.status(500).json({ error: error.message || "Internal server audit execution error." });
    } finally {
        // Safe file deletion block
        try {
            if (fs.existsSync(file.path)) {
                fs.unlinkSync(file.path);
            }
        } catch (e) {
            console.error("Failed to delete temp file", e);
        }
    }
});

// Serve frontend static files
app.use(express.static(path.join(__dirname, '../frontend')));

// Handle SPA route fallback
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

app.listen(PORT, '127.0.0.1', () => {
    console.log(`Server is running on http://127.0.0.1:${PORT}`);
});
