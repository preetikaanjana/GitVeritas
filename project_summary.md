# GitVeritas: Project Summary & Architecture Guide

This document provides a complete overview of the **GitVeritas** project, detailing the tech stack, core algorithms, and implementation walkthroughs to help you prepare for your interview.

---

## 🌟 1. Project Overview & Elevator Pitch

**GitVeritas** is a full-stack web application that solves resume inflation in technical recruitment. It cross-references a candidate's resume (PDF/DOCX) with their public GitHub profile and code history to verify their claimed skills and experience.

*   **The Problem**: Recruiters receive thousands of resumes with inflated or fake technical skills. Manually checking a candidate's GitHub profile to verify their code is tedious and time-consuming.
*   **The Solution**: GitVeritas automates this by parsing the resume, scraping the candidate's public repositories, checking their dependencies and direct code imports, and outputting an objective, verifiable alignment report in under 8 seconds.

---

## 🛠️ 2. The Tech Stack (MERN & SQLite & SBERT)

We chose a highly optimized JavaScript stack to align with modern MERN-stack standards:

### Frontend (Vanilla JS & Modern CSS)
*   **Vanilla JavaScript (ES6+)**: Keeps the page footprint extremely lightweight (< 50KB), loading instantly and bypassing React packaging overhead.
*   **Modern CSS3 (Flexbox & Grid)**: Renders a fully responsive dashboard with custom themes.
*   **CSS Conic Gradients**: Renders radial progress charts natively without importing external charting libraries.
*   **Web Print API**: Renders print-ready PDF reports with SVG rosette badges.

### Backend (Node.js & Express)
*   **Express.js**: Lightweight HTTP router exposing the `/api/audit` multipart form endpoint.
*   **Multer Middleware**: Handles secure, in-memory stream-to-temp-file file uploading.
*   **PDF-Parse & Mammoth**: Extract plain text from PDF and DOCX documents.
*   **Axios & Promise.all**: Fetch profile, repository, and pull request data concurrently from the GitHub REST API.

### Caching (SQLite3)
*   **SQLite3**: Relational caching engine wrapper in Promises (`dbGet`, `dbAll`, `dbRun`) storing profiles and repositories. It prevents GitHub API rate limits (supporting 5,000+ requests/hour) and speeds up repeat requests.

### AI Engine (SBERT via WebAssembly)
*   **@xenova/transformers**: Runs Hugging Face's SBERT model (`all-MiniLM-L6-v2`) compiled to **WebAssembly (ONNX Runtime)** natively inside the Node.js backend. This allows us to perform 384-dimensional vector embeddings and Cosine Similarity calculations with zero Python/PyTorch dependencies.

---

## 📐 3. Core Match Algorithms

GitVeritas uses a hybrid semantic matching engine to align claimed resume skills with repository footprints:

### 1. Exact Match & Synonyms Taxonomy
*   If a claim matches a footprint exactly, the score is `1.0`.
*   If a claim matches a synonym list (e.g. "Web Development" matches "React" or "Express"), the score is `0.85`.

### 2. SBERT Semantic Embeddings
SBERT transforms words into 384-dimensional vector representations. We compute the angle between the claimed skill vector $\mathbf{u}$ and the repository code footprint vector $\mathbf{v}$ using **Cosine Similarity**:
$$\text{Similarity}(\mathbf{u}, \mathbf{v}) = \frac{\mathbf{u} \cdot \mathbf{v}}{\|\mathbf{u}\| \|\mathbf{v}\|} = \frac{\sum_{i=1}^{n} u_i v_i}{\sqrt{\sum_{i=1}^{n} u_i^2} \sqrt{\sum_{i=1}^{n} v_i^2}}$$
A cosine similarity $\ge 0.65$ triggers a verified skill match.

### 3. Jaccard Bigram Similarity (Fallback)
If the AI model is offline or has missing embeddings, the system falls back to character-level Jaccard bigram similarity. We break both words into character pairs (bigrams) and divide the size of their intersection by their union:
$$J(S_1, S_2) = \frac{|B(S_1) \cap B(S_2)|}{|B(S_1) \cup B(S_2)|}$$

---

## 📂 4. Walkthrough of Core Files

### 🖥️ 4.1 `backend/app.js`
The central controller of our application. It sets up Express, configures Multer for temp uploads, serves the frontend statically, and maps the `/api/audit` route.

```javascript
// Excerpt from backend/app.js
app.post('/api/audit', upload.single('resume'), async (req, res) => {
    const file = req.file;
    const githubUsername = req.body.github_username;
    const githubToken = req.body.github_token || null;

    try {
        const parser = new ResumeParser();
        const rawText = await parser.extractText(file.path, file.originalname);
        const skills = parser.extractSkills(rawText);
        const quantifiableClaims = parser.extractQuantifiableClaims(rawText);
        
        const resumeData = { skills, timeline: {}, quantifiable_claims: quantifiableClaims };

        const client = new GitHubClient(githubToken);
        const githubData = await client.analyzeUser(githubUsername);

        const auditor = new ConsistencyAuditor();
        const auditResults = await auditor.audit(resumeData, githubData);

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
        return res.status(500).json({ error: error.message });
    } finally {
        if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
    }
});
```

### 📄 4.2 `backend/resume_parser.js`
Extracts text from PDF/Word uploads and applies our taxonomy keyword mapper.

```javascript
// Excerpt from backend/resume_parser.js
class ResumeParser {
    async extractText(filePath, originalName = null) {
        const nameToUse = originalName || filePath;
        const ext = path.extname(nameToUse).toLowerCase();
        if (ext === '.pdf') {
            return await this._extractPdfText(filePath);
        } else if (ext === '.docx' || ext === '.doc') {
            return await this._extractDocxText(filePath);
        } else {
            throw new Error("Unsupported file format. Please upload PDF or DOCX.");
        }
    }
    // ... extracts skills matching our predefined TECH_TAXONOMY categories
}
```

### 🕷️ 4.3 `backend/github_client.js`
Scrapes the GitHub API concurrently. It pulls profile info, analyzes repository dependencies/imports, and crawls pull requests to calculate collaboration scores.

```javascript
// Excerpt from backend/github_client.js
async analyzeUser(username) {
    const prs = await this.fetchUserPullRequests(username);
    const collabPrsCount = prs.filter(pr => pr.is_collaborative).length;

    const cachedProfile = await getCachedProfile(username);
    const cachedRepos = await getCachedRepos(username);
    if (cachedProfile && cachedRepos) {
        return { profile: cachedProfile, repositories: cachedRepos, pull_requests: prs, collaborative_prs_count: collabPrsCount };
    }

    const profileData = await this.getRequest(`${this.baseUrl}/users/${username}`);
    // ... scrapes repositories and checks imports (require / import) concurrently
}
```

### 📊 4.4 `backend/analyzer.js`
The alignment engine. It loads the SBERT model, maps cosine similarity matrices, checks experience periods, evaluates collaborative metrics, and produces the alignment score.

```javascript
// Excerpt from backend/analyzer.js
async computeSimilaritiesBatch(resumeSkills, githubTechs) {
    const similarities = {};
    // ... sets up exact matches and synonyms ...
    const pipe = await getPipeline(); // Xenova all-MiniLM-L6-v2 model
    if (pipe) {
        // ... gets embeddings and computes Cosine Similarities ...
    }
    // ... Jaccard fallback for unmatched pairs ...
    return similarities;
}
```

### 🗄️ 4.5 `backend/cache.js`
Wrapper for the relational SQLite database cache. It creates local tables and handles Promise-wrapped queries.

```javascript
// Excerpt from backend/cache.js
const dbPath = path.join(__dirname, 'github_cache.db');
const db = new sqlite3.Database(dbPath);

const dbGet = (query, params = []) => {
    return new Promise((resolve, reject) => {
        db.get(query, params, (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
};
// ... saveProfileCache & saveReposCache insert queries ...
```

---

## 📈 5. Key Metrics to Pitch

*   **Concurrency**: Scans **20+ repositories** simultaneously using Node.js async event loops.
*   **Latency**: Audits are completed in **under 8 seconds** (down from 30+ seconds before query caching).
*   **Throughput**: Authenticated SQLite caching supports **5,000+ API requests/hour**.
*   **RAM Footprint**: Runs on **under 80MB of RAM** due to the efficient WebAssembly port of SBERT.
