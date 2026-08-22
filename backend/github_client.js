const axios = require('axios');
const { getCachedProfile, getCachedRepos, saveProfileCache, saveReposCache } = require('./cache');

const BUILTIN_BLOCKLIST = new Set([
    // Node/Frontend
    "eslint", "prettier", "webpack", "babel", "jest", "eslint-plugin-react", "postcss", "typescript-eslint",
    "lodash", "axios", "dotenv", "cross-env", "concurrently", "nodemon", "ts-node", "uuid", "chalk",
    // Python helpers
    "pip", "setuptools", "wheel", "virtualenv", "pipenv", "tox", "pytest", "black", "flake8", "mypy",
    // Common JS utils
    "classnames", "prop-types", "react-dom", "react-router-dom", "sass", "less", "css-loader", "style-loader",
    "file-loader", "url-loader", "html-webpack-plugin", "clean-webpack-plugin", "mini-css-extract-plugin",
    // Python core utility libs (cross-env, cv2, joblib, etc.)
    "cv2", "joblib", "zoblib", "werkzeug", "mime-types", "date-fns", "negotiator", "tss", "ss",
    "os", "sys", "json", "math", "time", "datetime", "random", "re", "collections", "itertools", "functools",
    "urllib", "requests", "logging", "argparse", "subprocess", "shutil", "tempfile", "pathlib", "hashlib"
]);

class GitHubClient {
    constructor(token = null) {
        this.token = token || process.env.GITHUB_TOKEN || process.env.GITHUB_PAT || null;
        this.baseUrl = "https://api.github.com";
        this.headers = {
            "Accept": "application/vnd.github.v3+json",
            "User-Agent": "GitVeritas-Scraper"
        };
        if (this.token) {
            this.headers["Authorization"] = `token ${this.token}`;
        }
    }

    async getRequest(url) {
        try {
            const response = await axios.get(url, { headers: this.headers });
            return response.data;
        } catch (error) {
            if (error.response && error.response.status === 403) {
                const rateLimitRemaining = error.response.headers['x-ratelimit-remaining'];
                if (rateLimitRemaining === '0') {
                    throw new Error("GitHub API rate limit exceeded. Please configure a GitHub Token to proceed.");
                }
            }
            throw error;
        }
    }

    // Helper to get raw file contents from GitHub
    async getRawFileContent(owner, repo, filepath) {
        const url = `https://raw.githubusercontent.com/${owner}/${repo}/main/${filepath}`;
        try {
            const response = await axios.get(url);
            return response.data;
        } catch (e) {
            // Try master branch as fallback
            try {
                const fallbackUrl = `https://raw.githubusercontent.com/${owner}/${repo}/master/${filepath}`;
                const fallbackRes = await axios.get(fallbackUrl);
                return fallbackRes.data;
            } catch (err) {
                return null;
            }
        }
    }

    async fetchUserPullRequests(username) {
        try {
            const data = await this.getRequest(`${this.baseUrl}/search/issues?q=author:${username}+type:pr&per_page=50`);
            const items = data.items || [];
            const prs = [];
            for (const item of items) {
                const repoUrl = item.repository_url || "";
                const parts = repoUrl.split("/");
                const repoFullName = parts.slice(-2).join("/");
                const owner = parts[parts.length - 2] || "";
                const isCollab = owner.toLowerCase() !== username.toLowerCase();
                prs.push({
                    title: item.title,
                    repo: repoFullName,
                    state: item.state,
                    created_at: item.created_at,
                    is_collaborative: isCollab
                });
            }
            return prs;
        } catch (e) {
            console.error(`Error fetching PRs for ${username}: ${e.message}`);
            return [];
        }
    }

    async analyzeUser(username) {
        const usernameLower = username.toLowerCase().trim();
        
        // 1. Fetch Pull Requests dynamically
        const prs = await this.fetchUserPullRequests(usernameLower);
        const collabPrsCount = prs.filter(pr => pr.is_collaborative).length;

        // 2. Check SQLite Cache first
        const cachedProfile = await getCachedProfile(usernameLower);
        const cachedRepos = await getCachedRepos(usernameLower);
        if (cachedProfile && cachedRepos) {
            return { 
                profile: cachedProfile, 
                repositories: cachedRepos,
                pull_requests: prs,
                collaborative_prs_count: collabPrsCount
            };
        }

        // 3. Fetch User Profile
        let profileData;
        try {
            profileData = await this.getRequest(`${this.baseUrl}/users/${usernameLower}`);
        } catch (e) {
            throw new Error(`Failed to fetch GitHub profile for '${usernameLower}': ${e.message}`);
        }

        const profile = {
            username: profileData.login,
            name: profileData.name || profileData.login,
            avatar_url: profileData.avatar_url,
            bio: profileData.bio || "",
            public_repos: profileData.public_repos,
            followers: profileData.followers,
            created_at: profileData.created_at
        };

        // 4. Fetch Repositories
        let rawRepos = [];
        try {
            rawRepos = await this.getRequest(`${this.baseUrl}/users/${usernameLower}/repos?per_page=50&type=all`);
        } catch (e) {
            console.error(`Error fetching repos: ${e.message}`);
        }

        // Limit to 20 active public repositories to fit rates and latency budget
        const sortedRepos = rawRepos
            .filter(r => !r.fork) // ignore forks initially
            .sort((a, b) => new Date(b.pushed_at) - new Date(a.pushed_at))
            .slice(0, 20);

        const analyzedRepos = [];

        // 5. Concurrently analyze each repository
        const repoAnalysisPromises = sortedRepos.map(async (repo) => {
            const owner = repo.owner.login;
            const repoName = repo.name;
            const techList = new Set();
            const evidence = [];

            // Core languages from repo metadata
            if (repo.language) {
                const lang = repo.language.toLowerCase();
                if (!BUILTIN_BLOCKLIST.has(lang)) {
                    techList.add(lang);
                }
            }

            // Fetch package dependencies
            const packageJsonStr = await this.getRawFileContent(owner, repoName, "package.json");
            if (packageJsonStr) {
                try {
                    const pkg = typeof packageJsonStr === 'object' ? packageJsonStr : JSON.parse(packageJsonStr);
                    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
                    for (const dep in deps) {
                        const depClean = dep.toLowerCase().trim();
                        if (!BUILTIN_BLOCKLIST.has(depClean)) {
                            techList.add(depClean);
                        }
                    }
                } catch (e) {}
            }

            // Fetch requirements.txt
            const reqTxt = await this.getRawFileContent(owner, repoName, "requirements.txt");
            if (reqTxt && typeof reqTxt === 'string') {
                const lines = reqTxt.split('\n');
                for (const line of lines) {
                    const cleanLine = line.split('#')[0].split('==')[0].split('>')[0].split('<')[0].trim().toLowerCase();
                    if (cleanLine && !BUILTIN_BLOCKLIST.has(cleanLine)) {
                        techList.add(cleanLine);
                    }
                }
            }

            // Check for Dockerfile
            const dockerfile = await this.getRawFileContent(owner, repoName, "Dockerfile");
            if (dockerfile) {
                techList.add("docker");
                evidence.push({ tech: "docker", file: "Dockerfile", snippet: "Dockerfile present in root." });
            }

            // Check imports in code files (recursive scan or file list via API)
            try {
                const treeUrl = `${this.baseUrl}/repos/${owner}/${repoName}/git/trees/main?recursive=1`;
                let treeData;
                try {
                    treeData = await this.getRequest(treeUrl);
                } catch (err) {
                    const fallbackTreeUrl = `${this.baseUrl}/repos/${owner}/${repoName}/git/trees/master?recursive=1`;
                    treeData = await this.getRequest(fallbackTreeUrl);
                }

                if (treeData && treeData.tree) {
                    const files = treeData.tree.filter(item => {
                        const ext = item.path.split('.').pop().toLowerCase();
                        return item.type === "blob" && ["py", "js", "ts", "jsx", "tsx"].includes(ext);
                    }).slice(0, 15); // scan max 15 code files to preserve token rates

                    for (const file of files) {
                        const rawContent = await this.getRawFileContent(owner, repoName, file.path);
                        if (rawContent && typeof rawContent === 'string') {
                            const ext = file.path.split('.').pop().toLowerCase();
                            if (ext === 'py') {
                                // Match python imports: import X, from X import Y
                                const importRegex = /(?:^|\n)\s*(?:import\s+([a-zA-Z0-9_\s,]+)|from\s+([a-zA-Z0-9_]+)\s+import)/g;
                                let match;
                                while ((match = importRegex.exec(rawContent)) !== null) {
                                    const rawImport = match[1] || match[2];
                                    if (rawImport) {
                                        const cleanImports = rawImport.split(',').map(i => i.trim().split(/\s+/)[0].toLowerCase());
                                        for (const imp of cleanImports) {
                                            if (imp && !BUILTIN_BLOCKLIST.has(imp)) {
                                                techList.add(imp);
                                                evidence.push({ tech: imp, file: file.path, snippet: `import ${imp}` });
                                            }
                                        }
                                    }
                                }
                            } else {
                                // Match Javascript imports: require('x'), import x from 'y'
                                const requireRegex = /require\(['"]([^'"]+)['"]\)/g;
                                const importRegex = /import\s+.*?\s+from\s+['"]([^'"]+)['"]/g;
                                let match;
                                while ((match = requireRegex.exec(rawContent)) !== null) {
                                    const imp = match[1].toLowerCase().split('/')[0];
                                    if (imp && !BUILTIN_BLOCKLIST.has(imp)) {
                                        techList.add(imp);
                                        evidence.push({ tech: imp, file: file.path, snippet: `require('${imp}')` });
                                    }
                                }
                                while ((match = importRegex.exec(rawContent)) !== null) {
                                    const imp = match[1].toLowerCase().split('/')[0];
                                    if (imp && !BUILTIN_BLOCKLIST.has(imp)) {
                                        techList.add(imp);
                                        evidence.push({ tech: imp, file: file.path, snippet: `import from '${imp}'` });
                                    }
                                }
                            }
                        }
                    }
                }
            } catch (e) {}

            // Fetch User Commits
            let commitsCount = 0;
            let firstCommit = null;
            let lastCommit = null;
            try {
                const commits = await this.getRequest(
                    `${this.baseUrl}/repos/${owner}/${repoName}/commits?author=${usernameLower}&per_page=20`
                );
                if (commits && commits.length > 0) {
                    commitsCount = commits.length;
                    lastCommit = commits[0].commit.author.date;
                    firstCommit = commits[commits.length - 1].commit.author.date;
                }
            } catch (e) {}

            analyzedRepos.push({
                name: repoName,
                owner: owner,
                stars: repo.stargazers_count,
                forks: repo.forks_count,
                archived: repo.archived,
                created_at: repo.created_at,
                pushed_at: repo.pushed_at,
                commits_by_user: commitsCount,
                first_commit: firstCommit,
                last_commit: lastCommit,
                language: repo.language,
                dependencies: Array.from(techList),
                evidence: evidence.slice(0, 10)
            });
        });

        await Promise.all(repoAnalysisPromises);

        // 6. Store Cache
        await saveProfileCache(usernameLower, profile);
        await saveReposCache(usernameLower, analyzedRepos);

        return { 
            profile, 
            repositories: analyzedRepos,
            pull_requests: prs,
            collaborative_prs_count: collabPrsCount
        };
    }
}

module.exports = { GitHubClient };
