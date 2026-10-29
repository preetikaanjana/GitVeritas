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
const { generateRecruiterKit, answerRecruiterCodeQuery } = require('./ai_engine');
const { indexCandidateCodebase, searchCodebase } = require('./code_retriever');
const { getCachedCodeChunks } = require('./cache');

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

        // 4. Code RAG: Ingest & Retrieve source code snippets for verified skills
        let codeEvidence = [];
        try {
            await indexCandidateCodebase(client, githubUsername, githubData.repositories || []);
            const verifiedSkills = (auditResults.verified_claims || []).slice(0, 3).map(v => v.skill);
            for (const skill of verifiedSkills) {
                const chunks = await searchCodebase(githubUsername, `${skill} implementation`, 2);
                codeEvidence.push(...chunks);
            }
            // Deduplicate chunks by id
            const uniqueChunks = [];
            const seenIds = new Set();
            for (const c of codeEvidence) {
                if (!seenIds.has(c.id)) {
                    seenIds.add(c.id);
                    uniqueChunks.push(c);
                }
            }
            codeEvidence = uniqueChunks.slice(0, 5);
        } catch (ragErr) {
            console.warn("Non-blocking Code RAG indexing error in audit:", ragErr.message);
        }

        // 5. Generate AI Recruiter Intelligence & Grounded Interview Questions
        const candidateName = githubData.profile.name || githubUsername;
        const aiRecruiterKit = await generateRecruiterKit(candidateName, auditResults, codeEvidence);

        // 6. Return formatted response
        return res.json({
            success: true,
            username: githubUsername,
            profile: {
                name: candidateName,
                avatar_url: githubData.profile.avatar_url,
                bio: githubData.profile.bio,
                public_repos: githubData.profile.public_repos || 0,
                followers: githubData.profile.followers || 0,
                created_at: githubData.profile.created_at,
            },
            audit: auditResults,
            ai_recruiter_kit: aiRecruiterKit,
            code_evidence: codeEvidence,
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

// Recruiter Codebase Copilot Chat Endpoint
app.post('/api/code-chat', async (req, res) => {
    const { username, repo, question, github_token } = req.body;

    if (!username || typeof username !== 'string' || !username.trim()) {
        return res.status(400).json({ error: "Missing or invalid 'username' parameter." });
    }
    if (!question || typeof question !== 'string' || !question.trim()) {
        return res.status(400).json({ error: "Missing or invalid 'question' parameter." });
    }

    // Limit question length to prevent prompt exploitation
    const cleanQuestion = question.trim().substring(0, 500);
    const cleanUsername = username.trim().toLowerCase();
    const cleanRepo = repo && typeof repo === 'string' ? repo.trim() : null;

    try {
        const client = new GitHubClient(github_token || null);

        // Check if candidate chunks exist in SQLite cache
        let cachedChunks = await getCachedCodeChunks(cleanUsername, cleanRepo);
        if (cachedChunks.length === 0) {
            // Lazy indexing on-demand if not indexed yet
            try {
                const userRepos = await client.getRequest(`${client.baseUrl}/users/${cleanUsername}/repos?per_page=15&type=all`);
                await indexCandidateCodebase(client, cleanUsername, userRepos || []);
            } catch (fetchErr) {
                console.warn(`Failed lazy repos fetch for ${cleanUsername}:`, fetchErr.message);
            }
        }

        // Semantic vector search over candidate codebase
        const retrievedChunks = await searchCodebase(cleanUsername, cleanQuestion, 4, cleanRepo);

        // Synthesize grounded answer
        const responseData = await answerRecruiterCodeQuery({
            question: cleanQuestion,
            retrievedChunks,
            username: cleanUsername,
            repo: cleanRepo
        });

        return res.json({
            success: true,
            username: cleanUsername,
            repo: cleanRepo || "all",
            question: cleanQuestion,
            ...responseData
        });
    } catch (err) {
        console.error("Code chat endpoint error:", err);
        return res.status(500).json({
            error: "Failed to process recruiter codebase query. Please try again.",
            details: err.message
        });
    }
});

// Serve frontend static files
app.use(express.static(path.join(__dirname, '../frontend')));

// Handle SPA route fallback
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is running on port ${PORT}`);
});
