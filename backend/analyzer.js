const { TECH_TAXONOMY } = require('./resume_parser');

const SYNONYM_TAXONOMY = {
    "machine learning": ["tensorflow", "pytorch", "keras", "scikit-learn", "sklearn", "pandas", "numpy", "ml"],
    "deep learning": ["tensorflow", "pytorch", "keras", "neural networks", "cnn", "rnn", "transformers"],
    "artificial intelligence": ["tensorflow", "pytorch", "keras", "scikit-learn", "openai", "ai", "llm"],
    "frontend": ["react", "angular", "vue", "next.js", "nextjs", "typescript", "javascript", "tailwind", "css", "html", "webpack", "vite", "bootstrap"],
    "web development": ["react", "angular", "vue", "next.js", "nextjs", "typescript", "javascript", "html", "css", "django", "flask", "fastapi", "express"],
    "backend": ["django", "flask", "fastapi", "express", "spring", "laravel", "rails", "postgresql", "mysql", "mongodb", "sqlite", "graphql", "rest api", "sql", "node"],
    "devops": ["docker", "kubernetes", "k8s", "aws", "azure", "gcp", "terraform", "ansible", "jenkins", "git", "ci/cd", "github actions"],
    "cloud": ["aws", "azure", "gcp", "google cloud", "terraform", "s3", "ec2", "lambda"],
    "databases": ["postgresql", "postgres", "mysql", "sqlite", "mongodb", "redis", "sql", "dynamodb", "nosql"]
};

const VALID_CORE_TECH = new Set();
for (const cat in TECH_TAXONOMY) {
    for (const skill of TECH_TAXONOMY[cat]) {
        VALID_CORE_TECH.add(skill.toLowerCase().trim());
    }
}
for (const key in SYNONYM_TAXONOMY) {
    VALID_CORE_TECH.add(key.toLowerCase().trim());
    for (const syn of SYNONYM_TAXONOMY[key]) {
        VALID_CORE_TECH.add(syn.toLowerCase().trim());
    }
}

class ConsistencyAuditor {
    constructor() {
        this.currentYear = 2026;
    }

    _charNgramSimilarity(s1, s2) {
        const getBigrams = (s) => {
            const bigrams = new Set();
            for (let i = 0; i < s.length - 1; i++) {
                bigrams.add(s.substring(i, i + 2));
            }
            return bigrams;
        };
        const b1 = getBigrams(s1);
        const b2 = getBigrams(s2);
        if (b1.size === 0 || b2.size === 0) return 0.0;
        
        const intersection = new Set([...b1].filter(x => b2.has(x)));
        const union = new Set([...b1, ...b2]);
        return intersection.size / union.size;
    }

    computeSimilaritiesBatch(resumeSkills, githubTechs) {
        const similarities = {};
        for (const s of resumeSkills) {
            similarities[s] = {};
            for (const g of githubTechs) {
                const sClean = s.toLowerCase().trim();
                const gClean = g.toLowerCase().trim();
                
                if (sClean === gClean) {
                    similarities[s][g] = 1.0;
                } else if (SYNONYM_TAXONOMY[sClean] && SYNONYM_TAXONOMY[sClean].includes(gClean)) {
                    similarities[s][g] = 0.85; // Synonym weight
                } else {
                    similarities[s][g] = this._charNgramSimilarity(sClean, gClean);
                }
            }
        }
        return similarities;
    }

    calculateEvidenceStrength(tech, repos) {
        const matchedRepos = [];
        const proofSnippets = [];
        const techClean = tech.toLowerCase().trim();

        for (const repo of repos) {
            let inRepo = false;
            
            // Check language
            if (repo.language && repo.language.toLowerCase().trim() === techClean) {
                inRepo = true;
                proofSnippets.append = proofSnippets.push({
                    repo: repo.name,
                    file: "Language Statistics",
                    snippet: `Repository primary language is set to ${repo.language}.`,
                    type: "language"
                });
            }

            // Check evidence
            for (const ev of (repo.evidence || [])) {
                if (ev.tech.toLowerCase().trim() === techClean) {
                    inRepo = true;
                    proofSnippets.push({
                        repo: repo.name,
                        file: ev.file,
                        snippet: ev.snippet,
                        type: ev.type,
                        is_core: ev.is_core || false
                    });
                }
            }

            // Fallback config dependencies
            const cleanDeps = (repo.dependencies || []).map(d => d.toLowerCase().trim());
            if (!inRepo && cleanDeps.includes(techClean)) {
                inRepo = true;
                proofSnippets.push({
                    repo: repo.name,
                    file: "Configuration files",
                    snippet: `Detected in project dependencies config.`,
                    type: "dependency",
                    is_core: true
                });
            }

            if (inRepo) {
                matchedRepos.push(repo);
            }
        }

        if (matchedRepos.length === 0) {
            return { score: 0, repos: [], proofs: [], breakdown: {}, usage_type: "none" };
        }

        // 1. Repo Count Component (max 45 points)
        const repoCount = matchedRepos.length;
        let repoScore = 15;
        if (repoCount >= 3) repoScore = 45;
        else if (repoCount === 2) repoScore = 30;

        // 2. Recency Component (max 25 points)
        let latestPush = null;
        for (const repo of matchedRepos) {
            if (repo.pushed_at) {
                const pushedDate = new Date(repo.pushed_at);
                if (!latestPush || pushedDate > latestPush) {
                    latestPush = pushedDate;
                }
            }
        }

        let recencyScore = 5;
        if (latestPush) {
            const refDate = new Date(2026, 6, 9); // System ref date matching Python
            const diffTime = Math.abs(refDate - latestPush);
            const daysAgo = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
            if (daysAgo <= 30) recencyScore = 25;
            else if (daysAgo <= 90) recencyScore = 20;
            else if (daysAgo <= 180) recencyScore = 15;
            else if (daysAgo <= 365) recencyScore = 10;
        }

        // 3. Usage Type Component (max 20 points)
        let usageType = "mention";
        let hasCore = false;
        let hasIncidental = false;

        for (const p of proofSnippets) {
            if (p.type === "language" || p.type === "infra") {
                hasCore = true;
            } else if (p.type === "dependency") {
                if (p.is_core !== false) hasCore = true;
                else hasIncidental = true;
            } else if (p.type === "code" || p.type === "notebook") {
                hasIncidental = true;
            }
        }

        let usageScore = 5;
        if (hasCore) {
            usageScore = 20;
            usageType = "core";
        } else if (hasIncidental) {
            usageScore = 10;
            usageType = "incidental";
        }

        // 4. Activity / Quality Component (max 10 points)
        const totalUserCommits = matchedRepos.reduce((acc, r) => acc + (r.commits_by_user || 0), 0);
        const maxStars = Math.max(...matchedRepos.map(r => r.stars || 0), 0);
        
        let activityScore = 0;
        if (totalUserCommits >= 5) activityScore += 5;
        if (maxStars >= 1) activityScore += 5;

        const rawScore = repoScore + recencyScore + usageScore + activityScore;

        // Apply multipliers
        const allForks = matchedRepos.every(r => r.is_fork);
        const forksMultiplier = allForks ? 0.3 : 1.0;

        const allArchived = matchedRepos.every(r => r.is_archived);
        const archivedMultiplier = allArchived ? 0.5 : 1.0;

        let finalScore = Math.floor(rawScore * forksMultiplier * archivedMultiplier);
        finalScore = Math.min(Math.max(finalScore, 0), 100);

        return {
            score: finalScore,
            repos: matchedRepos.map(r => r.name),
            proofs: proofSnippets,
            breakdown: {
                repos: repoScore,
                recency: recencyScore,
                usage: usageScore,
                activity: activityScore,
                raw: rawScore,
                forks_multiplier: forksMultiplier,
                archived_multiplier: archivedMultiplier
            },
            usage_type: usageType
        };
    }

    audit(resumeData, githubData) {
        const resumeSkills = resumeData.skills || [];
        const resumeTimeline = resumeData.timeline || {};
        const quantifiableClaims = resumeData.quantifiable_claims || [];

        const repos = githubData.repositories || [];
        const prs = githubData.pull_requests || [];

        // Gather all technologies detected on GitHub
        const githubTechsSet = new Set();
        const AUDIT_BLOCKLIST = new Set([
            "warnings", "r", "bash", "shell", "makefile", "make", "markdown", "text", "txt", "html", "css"
        ]);

        for (const repo of repos) {
            if (repo.language) {
                const lang = repo.language.toLowerCase().trim();
                if (!AUDIT_BLOCKLIST.has(lang)) githubTechsSet.add(lang);
            }
            for (const dep of (repo.dependencies || [])) {
                const depLower = dep.toLowerCase().trim();
                if (!AUDIT_BLOCKLIST.has(depLower)) githubTechsSet.add(depLower);
            }
            for (const ev of (repo.evidence || [])) {
                const techLower = ev.tech.toLowerCase().trim();
                if (!AUDIT_BLOCKLIST.has(techLower)) githubTechsSet.add(techLower);
            }
        }

        const githubTechs = [...githubTechsSet].sort();

        // 1. Compute similarities
        const similarities = this.computeSimilaritiesBatch(resumeSkills, githubTechs);

        // 2. Compute evidence strength
        const techEvidenceStrength = {};
        for (const tech of githubTechs) {
            techEvidenceStrength[tech] = this.calculateEvidenceStrength(tech, repos);
        }

        const verifiedClaims = [];
        const unsupportedClaims = [];
        const claimMatchScores = [];

        // Evaluate Skills
        for (const skill of resumeSkills) {
            const skillLower = skill.toLowerCase().trim();

            // Special Case for "git"
            if (skillLower === "git" && repos.length > 0) {
                const gitYears = [];
                for (const r of repos) {
                    if (r.created_at) gitYears.push(new Date(r.created_at).getFullYear());
                    if (r.pushed_at) gitYears.push(new Date(r.pushed_at).getFullYear());
                }
                const gitStart = gitYears.length > 0 ? Math.min(...gitYears) : 2026;
                const gitEnd = gitYears.length > 0 ? Math.max(...gitYears) : 2026;
                const totalCommits = repos.reduce((acc, r) => acc + (r.commits_by_user || 0), 0);

                verifiedClaims.push({
                    skill: skill,
                    matched_tech: "git",
                    similarity: 1.0,
                    evidence_strength: 100,
                    total_commits: totalCommits,
                    active_period: `${gitStart} - ${gitEnd}`,
                    timeline_warning: null,
                    repos: repos.slice(0, 3).map(r => r.name),
                    proofs: repos.slice(0, 2).map(r => ({
                        repo: r.name,
                        file: "Git repository",
                        snippet: `Active public repository: ${r.name}`,
                        type: "git"
                    })),
                    breakdown: { repos: 45, recency: 25, usage: 20, activity: 10, raw: 100 }
                });
                claimMatchScores.push(1.0);
                continue;
            }

            // Special Case for HTML/CSS auto-verification
            if (["html", "css", "html5", "css3"].includes(skillLower)) {
                let webUiEvidence = false;
                let matchedWebTech = null;
                for (const tech of githubTechs) {
                    if (["javascript", "typescript", "react", "vue", "angular", "next.js", "nextjs"].includes(tech.toLowerCase().trim())) {
                        webUiEvidence = true;
                        matchedWebTech = tech.toLowerCase().trim();
                        break;
                    }
                }

                if (webUiEvidence && matchedWebTech) {
                    const evData = techEvidenceStrength[matchedWebTech];
                    const evStrength = evData.score;
                    const matchedRepos = repos.filter(r => evData.repos.includes(r.name));
                    const totalCommits = matchedRepos.reduce((acc, r) => acc + (r.commits_by_user || 0), 0);

                    const gitYears = [];
                    for (const r of matchedRepos) {
                        if (r.first_commit) gitYears.push(new Date(r.first_commit).getFullYear());
                        if (r.last_commit) gitYears.push(new Date(r.last_commit).getFullYear());
                    }
                    const gitStart = gitYears.length > 0 ? Math.min(...gitYears) : 2026;
                    const gitEnd = gitYears.length > 0 ? Math.max(...gitYears) : 2026;

                    verifiedClaims.push({
                        skill: skill,
                        matched_tech: matchedWebTech,
                        similarity: 1.0,
                        evidence_strength: evStrength,
                        total_commits: totalCommits,
                        active_period: `${gitStart} - ${gitEnd}`,
                        timeline_warning: null,
                        repos: evData.repos,
                        proofs: matchedRepos.slice(0, 2).map(r => ({
                            repo: r.name,
                            file: "Web UI project",
                            snippet: `Implicitly verified via ${matchedWebTech} code footprint.`,
                            type: "implicit"
                        })),
                        breakdown: evData.breakdown
                    });
                    claimMatchScores.push(1.0);
                    continue;
                }
            }

            let bestMatchTech = null;
            let bestSimilarity = 0.0;

            for (const tech of githubTechs) {
                const sim = similarities[skill][tech];
                if (sim > bestSimilarity) {
                    bestSimilarity = sim;
                    bestMatchTech = tech;
                }
            }

            const isMatched = bestSimilarity >= 0.40;

            if (isMatched && bestMatchTech) {
                const evData = techEvidenceStrength[bestMatchTech];
                const evStrength = evData.score;

                if (evStrength < 15) {
                    unsupportedClaims.push({
                        skill: skill,
                        reason: `Matches '${bestMatchTech}' (similarity: ${Math.round(bestSimilarity * 100)}%), but evidence is too weak (strength score: ${evStrength}%).`,
                        matched_tech: bestMatchTech,
                        similarity: Math.round(bestSimilarity * 100) / 100,
                        recommendation: `Contribute more code or commit configuration files using '${bestMatchTech}' in repositories.`
                    });
                    claimMatchScores.push(bestSimilarity * (evStrength / 100.0));
                    continue;
                }

                const matchedRepos = repos.filter(r => evData.repos.includes(r.name));
                const totalCommits = matchedRepos.reduce((acc, r) => acc + (r.commits_by_user || 0), 0);

                const gitYears = [];
                for (const r of matchedRepos) {
                    if (r.first_commit) gitYears.push(new Date(r.first_commit).getFullYear());
                    if (r.last_commit) gitYears.push(new Date(r.last_commit).getFullYear());
                }
                if (gitYears.length === 0) {
                    for (const r of matchedRepos) {
                        if (r.created_at) gitYears.push(new Date(r.created_at).getFullYear());
                        if (r.pushed_at) gitYears.push(new Date(r.pushed_at).getFullYear());
                    }
                }
                const gitStart = gitYears.length > 0 ? Math.min(...gitYears) : "Unknown";
                const gitEnd = gitYears.length > 0 ? Math.max(...gitYears) : "Unknown";

                let timelineWarning = null;
                const claimPeriod = resumeTimeline[skill];
                if (claimPeriod && gitEnd !== "Unknown") {
                    const resumeEnd = claimPeriod.end_year;
                    if (resumeEnd > gitEnd + 1) {
                        timelineWarning = `Timeline Mismatch: Resume claims usage until ${resumeEnd}, but last public GitHub commit was in ${gitEnd}.`;
                    }
                }

                verifiedClaims.push({
                    skill: skill,
                    matched_tech: bestMatchTech,
                    similarity: Math.round(bestSimilarity * 100) / 100,
                    evidence_strength: evStrength,
                    total_commits: totalCommits,
                    active_period: gitStart !== "Unknown" ? `${gitStart} - ${gitEnd}` : "Unknown",
                    timeline_warning: timelineWarning,
                    repos: evData.repos,
                    proofs: [],
                    breakdown: evData.breakdown
                });
                claimMatchScores.push(1.0);
            } else {
                unsupportedClaims.push({
                    skill: skill,
                    reason: "No semantically matching technologies found in scanned repositories.",
                    similarity: 0.0,
                    recommendation: `Add a public project using '${skill}' to your GitHub profile to back up this claim.`
                });
                claimMatchScores.push(0.0);
            }
        }

        // 3. Extract Unlisted Strengths
        const unlistedStrengths = [];
        for (const tech of githubTechs) {
            if (!VALID_CORE_TECH.has(tech.toLowerCase().trim())) continue;

            const evData = techEvidenceStrength[tech];
            const evStrength = evData.score;

            if (evStrength >= 40) {
                let isListed = false;
                for (const skill of resumeSkills) {
                    if (similarities[skill][tech] >= 0.40) {
                        isListed = true;
                        break;
                    }
                }

                if (!isListed) {
                    const matchedRepos = repos.filter(r => evData.repos.includes(r.name));
                    const totalCommits = matchedRepos.reduce((acc, r) => acc + (r.commits_by_user || 0), 0);
                    const maxStars = Math.max(...matchedRepos.map(r => r.stars || 0), 0);

                    const gitYears = [];
                    for (const r of matchedRepos) {
                        if (r.first_commit) gitYears.push(new Date(r.first_commit).getFullYear());
                        if (r.last_commit) gitYears.push(new Date(r.last_commit).getFullYear());
                    }
                    const gitStart = gitYears.length > 0 ? Math.min(...gitYears) : "Unknown";
                    const gitEnd = gitYears.length > 0 ? Math.max(...gitYears) : "Unknown";

                    unlistedStrengths.push({
                        technology: tech,
                        evidence_strength: evStrength,
                        total_commits: totalCommits,
                        stars: maxStars,
                        active_period: gitStart !== "Unknown" ? `${gitStart} - ${gitEnd}` : "Unknown",
                        repos: evData.repos,
                        proofs: []
                    });
                }
            }
        }

        unlistedStrengths.sort((a, b) => b.evidence_strength - a.evidence_strength);

        // Calculate overall score
        const activeVerifiedCount = verifiedClaims.filter(c => c.similarity >= 0.40).length;
        const totalSkillsCount = resumeSkills.length || 1;
        const consistencyIndex = Math.round((activeVerifiedCount / totalSkillsCount) * 100);

        return {
            consistency_index: consistencyIndex,
            verified_claims: verifiedClaims,
            unsupported_claims: unsupportedClaims,
            unlisted_strengths: unlistedStrengths,
            quantifiable_claims: quantifiableClaims.map(c => ({ claim: c, status: "No GitHub Evidence", evidence: [] }))
        };
    }
}

module.exports = { ConsistencyAuditor };
