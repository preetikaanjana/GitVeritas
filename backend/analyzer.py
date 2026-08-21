import os
import re
import ssl
from datetime import datetime
from typing import List, Dict, Any, Tuple, Set

# Bypass SSL verification issues for downloading model
os.environ["HF_HUB_DISABLE_SSL"] = "1"
os.environ["CURL_CA_BUNDLE"] = ""
os.environ["REQUESTS_CA_BUNDLE"] = ""
os.environ["PYTHONHTTPSVERIFY"] = "0"

try:
    ssl._create_default_https_context = ssl._create_unverified_context
except Exception:
    pass

# Monkey-patch requests to disable SSL verification globally
try:
    import requests
    original_request = requests.Session.request
    def patched_request(self, method, url, *args, **kwargs):
        kwargs['verify'] = False
        return original_request(self, method, url, *args, **kwargs)
    requests.Session.request = patched_request
    
    import urllib3
    urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
except Exception:
    pass

# Monkey-patch httpx to disable SSL verification globally
try:
    import httpx
    orig_client_init = httpx.Client.__init__
    def patched_client_init(self, *args, **kwargs):
        kwargs['verify'] = False
        orig_client_init(self, *args, **kwargs)
    httpx.Client.__init__ = patched_client_init
    
    orig_async_client_init = httpx.AsyncClient.__init__
    def patched_async_client_init(self, *args, **kwargs):
        kwargs['verify'] = False
        orig_async_client_init(self, *args, **kwargs)
    httpx.AsyncClient.__init__ = patched_async_client_init
except Exception:
    pass

# Fallback semantic dictionary to verify matches without transformers
SYNONYM_TAXONOMY = {
    "machine learning": ["tensorflow", "pytorch", "keras", "scikit-learn", "sklearn", "pandas", "numpy", "ml"],
    "deep learning": ["tensorflow", "pytorch", "keras", "neural networks", "cnn", "rnn", "transformers"],
    "artificial intelligence": ["tensorflow", "pytorch", "keras", "scikit-learn", "openai", "ai", "llm"],
    "frontend": ["react", "angular", "vue", "next.js", "nextjs", "typescript", "javascript", "tailwind", "css", "html", "webpack", "vite", "bootstrap"],
    "web development": ["react", "angular", "vue", "next.js", "nextjs", "typescript", "javascript", "html", "css", "django", "flask", "fastapi", "express"],
    "backend": ["django", "flask", "fastapi", "express", "spring", "laravel", "rails", "postgresql", "mysql", "mongodb", "sqlite", "graphql", "rest api", "sql", "node"],
    "devops": ["docker", "kubernetes", "k8s", "aws", "azure", "gcp", "terraform", "ansible", "jenkins", "git", "ci/cd", "github actions"],
    "cloud": ["aws", "azure", "gcp", "google cloud", "terraform", "s3", "ec2", "lambda"],
    "databases": ["postgresql", "postgres", "mysql", "sqlite", "mongodb", "redis", "sql", "dynamodb", "nosql"]
}

from backend.resume_parser import TECH_TAXONOMY

VALID_CORE_TECH = set()
for category, skills in TECH_TAXONOMY.items():
    for skill in skills:
        VALID_CORE_TECH.add(skill.lower().strip())
for key, synonyms in SYNONYM_TAXONOMY.items():
    VALID_CORE_TECH.add(key.lower().strip())
    for syn in synonyms:
        VALID_CORE_TECH.add(syn.lower().strip())

# Try loading SentenceTransformers, fallback to rule-based matching if failed/not installed/disabled
HAS_TRANSFORMERS = False
model = None

if os.environ.get("DISABLE_TRANSFORMERS") != "1":
    try:
        from sentence_transformers import SentenceTransformer, util
        HAS_TRANSFORMERS = True
    except Exception as e:
        print(f"SentenceTransformers load failed/skipped. Using fallback semantic matching: {e}")

class ConsistencyAuditor:
    def __init__(self):
        self.current_year = 2026

    def _get_model(self):
        global model
        if os.environ.get("DISABLE_TRANSFORMERS") == "1":
            return None
        if HAS_TRANSFORMERS and model is None:
            try:
                # Limit PyTorch CPU threads to reduce memory overhead
                try:
                    import torch
                    torch.set_num_threads(1)
                    torch.set_grad_enabled(False)
                except Exception:
                    pass
                # Lightweight sentence-transformers model
                model = SentenceTransformer('all-MiniLM-L6-v2')
            except Exception as e:
                print(f"Error initializing SentenceTransformer model: {e}")
        return model

    def normalize_term(self, term: str) -> str:
        t = term.lower().strip()
        # Remove common technical noise suffixes
        t = re.sub(r'\s+(?:development|developer|programming|design|skills|framework|library|libraries|tools|tool)$', '', t)
        if t == "database":
            t = "databases"
        return t.strip()

    def compute_similarity(self, term1: str, term2: str) -> float:
        """Computes similarity between two terms using local embeddings or taxonomy fallback."""
        term1_clean = term1.lower().strip()
        term2_clean = term2.lower().strip()
        
        if term1_clean == term2_clean:
            return 1.0
            
        term1_norm = self.normalize_term(term1)
        term2_norm = self.normalize_term(term2)
        
        if term1_norm == term2_norm:
            return 0.95
            
        for key, synonyms in SYNONYM_TAXONOMY.items():
            if term1_norm == key and term2_norm in synonyms:
                return 0.85
            if term2_norm == key and term1_norm in synonyms:
                return 0.85
        
        transformer_model = self._get_model()
        if transformer_model is not None:
            try:
                emb1 = transformer_model.encode(term1_clean, convert_to_tensor=True)
                emb2 = transformer_model.encode(term2_clean, convert_to_tensor=True)
                cos_sim = util.cos_sim(emb1, emb2).item()
                return cos_sim
            except Exception:
                pass
                
        return self._char_ngram_similarity(term1_clean, term2_clean)

    def _char_ngram_similarity(self, s1: str, s2: str) -> float:
        """Simple fallback string similarity metric (Jaccard similarity of bigrams)."""
        def get_bigrams(s):
            return {s[i:i+2] for i in range(len(s)-1)}
        b1, b2 = get_bigrams(s1), get_bigrams(s2)
        if not b1 or not b2:
            return 0.0
        return len(b1.intersection(b2)) / len(b1.union(b2))

    def compute_similarities_batch(self, resume_skills: List[str], github_techs: List[str]) -> Dict[str, Dict[str, float]]:
        """Computes pairwise SBERT similarities in a single batch for speed."""
        similarities = {s: {g: 0.0 for g in github_techs} for s in resume_skills}
        
        for s in resume_skills:
            for g in github_techs:
                if s.lower().strip() == g.lower().strip():
                    similarities[s][g] = 1.0
                    
        transformer_model = self._get_model()
        if transformer_model is not None and resume_skills and github_techs:
            try:
                res_embeddings = transformer_model.encode([s.lower().strip() for s in resume_skills], convert_to_tensor=True)
                git_embeddings = transformer_model.encode([g.lower().strip() for g in github_techs], convert_to_tensor=True)
                
                cos_sim_matrix = util.cos_sim(res_embeddings, git_embeddings)
                
                for idx_s, s in enumerate(resume_skills):
                    for idx_g, g in enumerate(github_techs):
                        val = cos_sim_matrix[idx_s][idx_g].item()
                        similarities[s][g] = max(similarities[s][g], val)
            except Exception as e:
                print(f"Batch embedding failed: {e}. Falling back to pairwise calculations.")
                
        # Fallback to taxonomy or bigrams
        for s in resume_skills:
            s_norm = self.normalize_term(s)
            for g in github_techs:
                g_norm = self.normalize_term(g)
                
                if s_norm == g_norm:
                    similarities[s][g] = max(similarities[s][g], 0.95)
                    
                if similarities[s][g] < 0.85:
                    taxonomy_match = False
                    for key, synonyms in SYNONYM_TAXONOMY.items():
                        if s_norm == key and g_norm in synonyms:
                            similarities[s][g] = max(similarities[s][g], 0.85)
                            taxonomy_match = True
                            break
                        if g_norm == key and s_norm in synonyms:
                            similarities[s][g] = max(similarities[s][g], 0.85)
                            taxonomy_match = True
                            break
                    if not taxonomy_match and similarities[s][g] == 0.0:
                        similarities[s][g] = self._char_ngram_similarity(s.lower().strip(), g.lower().strip())
                        
        return similarities

    def calculate_evidence_strength(self, tech: str, repos: List[Dict[str, Any]]) -> Dict[str, Any]:
        """Calculates evidence strength (0-100) and extracts proof snippets for a technology."""
        matched_repos = []
        proof_snippets = []
        
        for repo in repos:
            in_repo = False
            
            # Check primary language stats
            if repo.get("language") and repo["language"].lower().strip() == tech.lower().strip():
                in_repo = True
                proof_snippets.append({
                    "repo": repo["name"],
                    "file": "Language Statistics",
                    "snippet": f"Repository primary language is set to {repo['language']}.",
                    "type": "language"
                })
                
            # Check dependencies/evidence
            for ev in repo.get("evidence", []):
                if ev["tech"].lower().strip() == tech.lower().strip():
                    in_repo = True
                    proof_snippets.append({
                        "repo": repo["name"],
                        "file": ev["file"],
                        "snippet": ev["snippet"],
                        "type": ev["type"],
                        "is_core": ev.get("is_core", False)
                    })
                    
            # Fallback checks (in case it is in dependencies list but not detailed evidence)
            if not in_repo and tech.lower().strip() in [d.lower().strip() for d in repo.get("dependencies", [])]:
                in_repo = True
                proof_snippets.append({
                    "repo": repo["name"],
                    "file": "Configuration files",
                    "snippet": f"Detected in project dependencies config.",
                    "type": "dependency",
                    "is_core": True
                })
                
            if in_repo:
                matched_repos.append(repo)
                
        if not matched_repos:
            return {"score": 0, "repos": [], "proofs": [], "breakdown": {}, "usage_type": "none"}
            
        # 1. Repo Count Component (max 45 points)
        repo_count = len(matched_repos)
        if repo_count >= 3:
            repo_score = 45
        elif repo_count == 2:
            repo_score = 30
        else:
            repo_score = 15
            
        # 2. Recency Component (max 25 points)
        latest_push = None
        for repo in matched_repos:
            pushed_str = repo.get("pushed_at")
            if pushed_str:
                try:
                    pushed_date = datetime.fromisoformat(pushed_str.replace("Z", ""))
                    if latest_push is None or pushed_date > latest_push:
                        latest_push = pushed_date
                except Exception:
                    pass
                    
        recency_score = 5
        if latest_push:
            ref_date = datetime(2026, 7, 9) # System time is 2026-07-09
            days_ago = (ref_date - latest_push).days
            if days_ago <= 30:
                recency_score = 25
            elif days_ago <= 90:
                recency_score = 20
            elif days_ago <= 180:
                recency_score = 15
            elif days_ago <= 365:
                recency_score = 10
            else:
                recency_score = 5
                
        # 3. Usage Type Component (max 20 points)
        usage_type = "mention"
        has_core = False
        has_incidental = False
        
        for p in proof_snippets:
            if p["type"] in ["language", "infra"]:
                has_core = True
            elif p["type"] == "dependency":
                if p.get("is_core", True):
                    has_core = True
                else:
                    has_incidental = True
            elif p["type"] in ["code", "notebook"]:
                has_incidental = True
                
        if has_core:
            usage_score = 20
            usage_type = "core"
        elif has_incidental:
            usage_score = 10
            usage_type = "incidental"
        else:
            usage_score = 5
            usage_type = "mention"
            
        # 4. Activity / Quality Component (max 10 points)
        total_user_commits = sum(repo.get("commits_by_user", 0) for repo in matched_repos)
        max_stars = max(repo.get("stars", 0) for repo in matched_repos)
        
        activity_score = 0
        if total_user_commits >= 5:
            activity_score += 5
        if max_stars >= 1:
            activity_score += 5
            
        raw_score = repo_score + recency_score + usage_score + activity_score
        
        # Apply multipliers
        all_forks = all(repo.get("is_fork", False) for repo in matched_repos)
        forks_multiplier = 0.3 if all_forks else 1.0
        
        all_archived = all(repo.get("is_archived", False) for repo in matched_repos)
        archived_multiplier = 0.5 if all_archived else 1.0
        
        final_score = int(raw_score * forks_multiplier * archived_multiplier)
        final_score = min(max(final_score, 0), 100)
        
        return {
            "score": final_score,
            "repos": [repo["name"] for repo in matched_repos],
            "proofs": proof_snippets,
            "breakdown": {
                "repos": repo_score,
                "recency": recency_score,
                "usage": usage_score,
                "activity": activity_score,
                "raw": raw_score,
                "forks_multiplier": forks_multiplier,
                "archived_multiplier": archived_multiplier
            },
            "usage_type": usage_type
        }

    def audit(self, resume_data: Dict[str, Any], github_data: Dict[str, Any]) -> Dict[str, Any]:
        """
        Auditing engine using SBERT embeddings, weighted evidence scores, and proof snippet extraction.
        """
        resume_skills = resume_data.get("skills", [])
        resume_timeline = resume_data.get("timeline", {})
        quantifiable_claims = resume_data.get("quantifiable_claims", [])
        
        repos = github_data.get("repositories", [])
        prs = github_data.get("pull_requests", [])
        
        # Gather all technologies detected on GitHub
        github_techs_set = set()
        AUDIT_BLOCKLIST = {
            "warnings", "r", "bash", "shell", "makefile", "make", "markdown", "text", "txt", "html", "css"
        }
        
        for repo in repos:
            if repo.get("language"):
                lang = repo["language"].lower().strip()
                if lang not in AUDIT_BLOCKLIST:
                    github_techs_set.add(lang)
            for dep in repo.get("dependencies", []):
                dep_lower = dep.lower().strip()
                if dep_lower not in AUDIT_BLOCKLIST:
                    github_techs_set.add(dep_lower)
            for ev in repo.get("evidence", []):
                tech_lower = ev["tech"].lower().strip()
                if tech_lower not in AUDIT_BLOCKLIST:
                    github_techs_set.add(tech_lower)
                    
        github_techs = sorted(list(github_techs_set))
        
        # 1. Batch Compute SBERT Similarities
        similarities = self.compute_similarities_batch(resume_skills, github_techs)
        
        # 2. Compute Evidence Strength for all detected GitHub technologies
        tech_evidence_strength = {}
        for tech in github_techs:
            tech_evidence_strength[tech] = self.calculate_evidence_strength(tech, repos)
            
        verified_claims = []
        unsupported_claims = []
        
        claim_match_scores = []
        
        # Evaluate Resume Skills
        for skill in resume_skills:
            skill_lower = skill.lower()
            
            # Special case for "git"
            if skill_lower == "git" and len(repos) > 0:
                git_years = []
                for r in repos:
                    if r.get("created_at"):
                        try:
                            git_years.append(datetime.fromisoformat(r["created_at"].replace("Z", "")).year)
                        except Exception:
                            pass
                    if r.get("pushed_at"):
                        try:
                            git_years.append(datetime.fromisoformat(r["pushed_at"].replace("Z", "")).year)
                        except Exception:
                            pass
                git_start = min(git_years) if git_years else 2026
                git_end = max(git_years) if git_years else 2026
                total_commits = sum(r.get("commits_by_user", 0) for r in repos)
                
                # Git is always 100% verified if user has active repos
                verified_claims.append({
                    "skill": skill,
                    "matched_tech": "git",
                    "similarity": 1.0,
                    "evidence_strength": 100,
                    "total_commits": total_commits,
                    "active_period": f"{git_start} - {git_end}",
                    "timeline_warning": None,
                    "repos": [r["name"] for r in repos[:3]],
                    "proofs": [{
                        "repo": r["name"],
                        "file": "Git repository",
                        "snippet": f"Active public repository: {r['name']}",
                        "type": "git"
                    } for r in repos[:2]],
                    "breakdown": {"repos": 45, "recency": 25, "usage": 20, "activity": 10, "raw": 100}
                })
                claim_match_scores.append(1.0)
                continue

            # Special case for HTML/CSS auto-verification if JS/React/TS/Vue/Angular/NextJS is present
            if skill_lower in ["html", "css", "html5", "css3"]:
                web_ui_evidence = False
                matched_web_tech = None
                for tech in github_techs:
                    if tech.lower().strip() in ["javascript", "typescript", "react", "vue", "angular", "next.js", "nextjs"]:
                        web_ui_evidence = True
                        matched_web_tech = tech.lower().strip()
                        break
                
                if web_ui_evidence and matched_web_tech:
                    ev_data = tech_evidence_strength[matched_web_tech]
                    ev_strength = ev_data["score"]
                    matched_repos = [r for r in repos if r["name"] in ev_data["repos"]]
                    total_commits = sum(r.get("commits_by_user", 0) for r in matched_repos)
                    
                    git_years = []
                    for r in matched_repos:
                        if r.get("first_commit"):
                            try:
                                git_years.append(datetime.fromisoformat(r["first_commit"].replace("Z", "")).year)
                            except Exception:
                                pass
                        if r.get("last_commit"):
                            try:
                                git_years.append(datetime.fromisoformat(r["last_commit"].replace("Z", "")).year)
                            except Exception:
                                pass
                    git_start = min(git_years) if git_years else 2026
                    git_end = max(git_years) if git_years else 2026

                    verified_claims.append({
                        "skill": skill,
                        "matched_tech": matched_web_tech,
                        "similarity": 1.0,
                        "evidence_strength": ev_strength,
                        "total_commits": total_commits,
                        "active_period": f"{git_start} - {git_end}" if git_start else "Unknown",
                        "timeline_warning": None,
                        "repos": ev_data["repos"],
                        "proofs": [{
                            "repo": r["name"],
                            "file": "Web UI project",
                            "snippet": f"Implicitly verified via {matched_web_tech} code footprint.",
                            "type": "implicit"
                        } for r in matched_repos[:2]],
                        "breakdown": ev_data["breakdown"]
                    })
                    claim_match_scores.append(1.0)
                    continue

            best_match_tech = None
            best_similarity = 0.0
            
            for tech in github_techs:
                sim = similarities[skill][tech]
                if sim > best_similarity:
                    best_similarity = sim
                    best_match_tech = tech
                    
            # Semantic match threshold
            is_matched = best_similarity >= 0.40
            
            if is_matched and best_match_tech:
                ev_data = tech_evidence_strength[best_match_tech]
                ev_strength = ev_data["score"]
                
                # Check for low evidence strength (threshold: 15)
                if ev_strength < 15:
                    unsupported_claims.append({
                        "skill": skill,
                        "reason": f"Matches '{best_match_tech}' (similarity: {round(best_similarity*100)}%), but evidence is too weak (strength score: {ev_strength}%).",
                        "matched_tech": best_match_tech,
                        "similarity": round(best_similarity, 2),
                        "recommendation": f"Contribute more code or commit configuration files using '{best_match_tech}' in original repositories."
                    })
                    claim_match_scores.append(best_similarity * (ev_strength / 100.0))
                    continue
                    
                matched_repos = [r for r in repos if r["name"] in ev_data["repos"]]
                total_commits = sum(r.get("commits_by_user", 0) for r in matched_repos)
                
                git_years = []
                for r in matched_repos:
                    if r.get("first_commit"):
                        try:
                            git_years.append(datetime.fromisoformat(r["first_commit"].replace("Z", "")).year)
                        except Exception:
                            pass
                    if r.get("last_commit"):
                        try:
                            git_years.append(datetime.fromisoformat(r["last_commit"].replace("Z", "")).year)
                        except Exception:
                            pass
                            
                # Fallback to repo dates if no commit dates
                if not git_years:
                    for r in matched_repos:
                        if r.get("created_at"):
                            try:
                                git_years.append(datetime.fromisoformat(r["created_at"].replace("Z", "")).year)
                            except Exception:
                                pass
                        if r.get("pushed_at"):
                            try:
                                git_years.append(datetime.fromisoformat(r["pushed_at"].replace("Z", "")).year)
                            except Exception:
                                pass
                                
                git_start = min(git_years) if git_years else None
                git_end = max(git_years) if git_years else None
                
                timeline_warning = None
                claim_period = resume_timeline.get(skill)
                if claim_period and git_end:
                    resume_end = claim_period["end_year"]
                    if resume_end > git_end + 1:
                        timeline_warning = f"Timeline Mismatch: Resume claims usage until {resume_end}, but last public GitHub commit was in {git_end}."
                
                verified_claims.append({
                    "skill": skill,
                    "matched_tech": best_match_tech,
                    "similarity": round(best_similarity, 2),
                    "evidence_strength": ev_strength,
                    "total_commits": total_commits,
                    "active_period": f"{git_start} - {git_end}" if git_start else "Unknown",
                    "timeline_warning": timeline_warning,
                    "repos": ev_data["repos"],
                    "proofs": [],
                    "breakdown": ev_data["breakdown"]
                })
                
                # Simple technology match based score
                claim_match_scores.append(1.0)
            else:
                unsupported_claims.append({
                    "skill": skill,
                    "reason": "No semantically matching technologies found in scanned repositories.",
                    "similarity": 0.0,
                    "recommendation": f"Add a public project using '{skill}' to your GitHub profile to back up this claim."
                })
                claim_match_scores.append(0.0)
                
        # 3. Extract Unlisted Strengths
        unlisted_strengths = []
        for tech in github_techs:
            # Skip if technology is not part of core developer skills taxonomy
            if tech.lower().strip() not in VALID_CORE_TECH:
                continue
                
            ev_data = tech_evidence_strength[tech]
            ev_strength = ev_data["score"]
            
            # High evidence strength but not listed on resume
            if ev_strength >= 40:
                is_listed = False
                for skill in resume_skills:
                    if similarities[skill][tech] >= 0.40:
                        is_listed = True
                        break
                        
                if not is_listed:
                    matched_repos = [r for r in repos if r["name"] in ev_data["repos"]]
                    total_commits = sum(r.get("commits_by_user", 0) for r in matched_repos)
                    max_stars = max(r.get("stars", 0) for r in matched_repos)
                    
                    git_years = []
                    for r in matched_repos:
                        if r.get("first_commit"):
                            try:
                                git_years.append(datetime.fromisoformat(r["first_commit"].replace("Z", "")).year)
                            except Exception:
                                pass
                        if r.get("last_commit"):
                            try:
                                git_years.append(datetime.fromisoformat(r["last_commit"].replace("Z", "")).year)
                            except Exception:
                                pass
                                
                    git_start = min(git_years) if git_years else None
                    git_end = max(git_years) if git_years else None
                    
                    unlisted_strengths.append({
                        "technology": tech,
                        "evidence_strength": ev_strength,
                        "total_commits": total_commits,
                        "stars": max_stars,
                        "active_period": f"{git_start} - {git_end}" if git_start else "Unknown",
                        "repos": ev_data["repos"],
                        "proofs": []
                    })
                    
        unlisted_strengths.sort(key=lambda x: x["evidence_strength"], reverse=True)
        
        # 4. Calculate Quantifiable Claims
        evaluated_claims = []
        collab_prs = [pr for pr in prs if pr["is_collaborative"]]
        
        for claim in quantifiable_claims:
            claim_lower = claim.lower()
            evidence = []
            status = "No GitHub Evidence"
            
            if any(w in claim_lower for w in ["lead", "led", "manage", "managed", "team", "collaborat"]):
                if len(collab_prs) > 0:
                    status = "Evidence Found"
                    evidence.append(f"Collaborated on {len(collab_prs)} external repository pull request(s).")
                if len(prs) > len(collab_prs):
                    status = "Evidence Found"
                    evidence.append(f"Created {len(prs) - len(collab_prs)} pull request(s) on owned repositories.")
            elif any(w in claim_lower for w in ["user", "traffic", "scale", "performance", "optimize"]):
                total_stars = sum(r.get("stars", 0) for r in repos)
                if total_stars > 0:
                    status = "Evidence Found"
                    evidence.append(f"Public repositories have accumulated {total_stars} stars.")
                    
            for tech in github_techs:
                # Check similarity between claim and tech
                sim = self.compute_similarity(claim_lower, tech)
                if sim >= 0.50 or tech in claim_lower:
                    status = "Evidence Found"
                    tech_repos = tech_evidence_strength[tech]["repos"]
                    evidence.append(f"Active codebase in '{tech}' detected in repositories: {', '.join(tech_repos)}.")
                    
            evaluated_claims.append({
                "claim": claim,
                "status": status,
                "evidence": " ".join(evidence) if evidence else "No corresponding codebase metrics or public contributions found on GitHub."
            })
            
        # 5. Overall Resume Credibility Score
        total_resume_skills = len(resume_skills)
        credibility_score = 0
        if total_resume_skills > 0:
            credibility_score = int((sum(claim_match_scores) / total_resume_skills) * 100)
            
        return {
            "score": credibility_score,
            "verified_claims": verified_claims,
            "unsupported_claims": unsupported_claims,
            "unlisted_strengths": unlisted_strengths,
            "evaluated_claims": evaluated_claims
        }

