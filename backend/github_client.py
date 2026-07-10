import httpx
import asyncio
import os
import re
import json
from datetime import datetime
from typing import List, Dict, Any, Optional, Tuple
from backend.cache import get_cached_profile, set_cached_profile, get_cached_repos, set_cached_repos
from backend.resume_parser import TECH_TAXONOMY

# Flatten taxonomy for easy lookup in README.md files
FLAT_TAXONOMY = []
for category, skills in TECH_TAXONOMY.items():
    FLAT_TAXONOMY.extend(skills)
FLAT_TAXONOMY = list(set(FLAT_TAXONOMY))

BUILTIN_BLOCKLIST = {
    # Python built-ins
    "os", "sys", "re", "json", "math", "time", "datetime", "random", "warnings", "collections", 
    "itertools", "functools", "typing", "pathlib", "shutil", "tempfile", "subprocess", "urllib", 
    "hashlib", "socket", "threading", "multiprocessing", "argparse", "logging", "pickle", "uuid", 
    "copy", "csv", "glob", "xml", "ast", "inspect", "traceback", "ctypes", "select", "asyncio", 
    "gc", "weakref", "base64", "abc", "contextlib", "io", "pdb", "statistics", "string", 
    "unittest", "mock", "pprint",
    
    # Node.js built-ins
    "path", "fs", "http", "https", "crypto", "stream", "buffer", "events", "util", "url", 
    "querystring", "zlib", "child_process", "cluster", "dns", "net", "tls", "dgram", "readline", "vm"
}

GITHUB_API_URL = "https://api.github.com"
MAX_REPOS_TO_SCAN = 20

class GitHubClient:
    def __init__(self, token: Optional[str] = None):
        self.token = token
        self.headers = {
            "Accept": "application/vnd.github+json",
            "User-Agent": "Resume-GitHub-Auditor"
        }
        if token:
            self.headers["Authorization"] = f"token {token}"
            
    async def fetch_profile(self, username: str) -> Dict[str, Any]:
        """Fetches the user's general GitHub profile info."""
        cached = get_cached_profile(username)
        if cached:
            return cached

        async with httpx.AsyncClient(headers=self.headers, timeout=10.0) as client:
            resp = await client.get(f"{GITHUB_API_URL}/users/{username}")
            if resp.status_code == 404:
                raise ValueError(f"GitHub user '{username}' not found.")
            resp.raise_for_status()
            profile_data = resp.json()
            set_cached_profile(username, profile_data)
            return profile_data

    async def fetch_user_repos(self, username: str) -> List[Dict[str, Any]]:
        """Fetches all public repositories for the user."""
        async with httpx.AsyncClient(headers=self.headers, timeout=15.0) as client:
            repos = []
            page = 1
            while True:
                resp = await client.get(f"{GITHUB_API_URL}/users/{username}/repos?per_page=100&page={page}")
                resp.raise_for_status()
                page_repos = resp.json()
                if not page_repos:
                    break
                repos.extend(page_repos)
                if len(page_repos) < 100:
                    break
                page += 1
            return repos

    async def fetch_user_commits_in_repo(self, client: httpx.AsyncClient, owner: str, repo_name: str, username: str) -> Tuple[int, Optional[str], Optional[str]]:
        """
        Fetches commit count and active date range of the user in a specific repo.
        Returns: (commit_count, first_commit_date, last_commit_date)
        """
        try:
            # We request commits with author filter
            resp = await client.get(f"{GITHUB_API_URL}/repos/{owner}/{repo_name}/commits?author={username}&per_page=100")
            if resp.status_code == 200:
                commits = resp.json()
                if not commits:
                    return 0, None, None
                
                commit_count = len(commits)
                # GitHub returns newest first
                last_commit_date = commits[0]["commit"]["author"]["date"]
                first_commit_date = commits[-1]["commit"]["author"]["date"]
                
                # Check pagination header to get total count if it exceeds 100
                if "Link" in resp.headers:
                    # Very simple pagination check: if there is a 'last' page, estimate total
                    link_header = resp.headers["Link"]
                    last_match = re.search(r'page=(\d+)>; rel="last"', link_header)
                    if last_match:
                        last_page = int(last_match.group(1))
                        # We approximate total count
                        commit_count = last_page * 100
                
                return commit_count, first_commit_date, last_commit_date
        except Exception as e:
            print(f"Error fetching commits for {owner}/{repo_name}: {e}")
        return 0, None, None

    async def fetch_file_content(self, client: httpx.AsyncClient, owner: str, repo_name: str, file_path: str) -> Optional[str]:
        """Fetches the content of a file in the repo."""
        try:
            resp = await client.get(f"{GITHUB_API_URL}/repos/{owner}/{repo_name}/contents/{file_path}")
            if resp.status_code == 200:
                data = resp.json()
                if data.get("encoding") == "base64" and data.get("content"):
                    import base64
                    try:
                        return base64.b64decode(data["content"]).decode("utf-8")
                    except Exception:
                        pass
        except Exception as e:
            pass
        return None

    def _extract_evidence_from_file(self, file_path: str, content: str) -> List[Dict[str, Any]]:
        evidence = []
        if not content:
            return evidence
            
        file_path_lower = file_path.lower()
        basename = os.path.basename(file_path_lower)
        
        try:
            # 1. package.json
            if basename == "package.json":
                data = json.loads(content)
                for dep_type in ["dependencies", "devDependencies"]:
                    if dep_type in data and isinstance(data[dep_type], dict):
                        for dep_name in data[dep_type].keys():
                            dep_clean = dep_name.lower().strip()
                            if dep_clean not in BUILTIN_BLOCKLIST:
                                snippet = ""
                                for line in content.split('\n'):
                                    if f'"{dep_name}"' in line:
                                        snippet = line.strip()
                                        break
                                evidence.append({
                                    "tech": dep_clean,
                                    "file": file_path,
                                    "snippet": snippet or f'"{dep_name}": ...',
                                    "type": "dependency",
                                    "is_core": dep_type == "dependencies"
                                })
            
            # 2. requirements.txt
            elif basename == "requirements.txt":
                for line in content.split("\n"):
                    line_clean = line.strip()
                    if not line_clean or line_clean.startswith("#"):
                        continue
                    parts = re.split(r"==|>=|<=|>|<|~=", line_clean)
                    if parts and parts[0]:
                        dep_name = parts[0].strip().lower()
                        if dep_name not in BUILTIN_BLOCKLIST:
                            evidence.append({
                                "tech": dep_name,
                                "file": file_path,
                                "snippet": line_clean,
                                "type": "dependency",
                                "is_core": True
                            })
                            
            # 3. pom.xml
            elif basename == "pom.xml":
                dep_blocks = re.findall(r'<dependency>[\s\S]*?</dependency>', content)
                for block in dep_blocks:
                    artifact_match = re.search(r'<artifactId>([^<]+)</artifactId>', block)
                    if artifact_match:
                        artifact = artifact_match.group(1).strip().lower()
                        if artifact not in BUILTIN_BLOCKLIST:
                            # Clean the block to fit in a single line or short block
                            block_lines = [l.strip() for l in block.split('\n') if l.strip()]
                            evidence.append({
                                "tech": artifact,
                                "file": file_path,
                                "snippet": " ".join(block_lines),
                                "type": "dependency",
                                "is_core": True
                            })
                            
            # 4. Gemfile
            elif basename == "gemfile":
                for line in content.split("\n"):
                    line_clean = line.strip()
                    match = re.match(r"^\s*gem\s+['\"]([^'\"]+)['\"]", line_clean)
                    if match:
                        gem_name = match.group(1).strip().lower()
                        if gem_name not in BUILTIN_BLOCKLIST:
                            evidence.append({
                                "tech": gem_name,
                                "file": file_path,
                                "snippet": line_clean,
                                "type": "dependency",
                                "is_core": True
                            })
                            
            # 5. go.mod
            elif basename == "go.mod":
                in_require = False
                for line in content.split("\n"):
                    line_clean = line.strip()
                    if line_clean.startswith("require ("):
                        in_require = True
                        continue
                    elif line_clean.startswith(")") and in_require:
                        in_require = False
                        
                    if line_clean.startswith("require") and not in_require:
                        parts = line_clean.split()
                        if len(parts) >= 2:
                            pkg = parts[1].split("/")[-1].lower()
                            if pkg not in BUILTIN_BLOCKLIST:
                                evidence.append({
                                    "tech": pkg,
                                    "file": file_path,
                                    "snippet": line_clean,
                                    "type": "dependency",
                                    "is_core": True
                                })
                    elif in_require and line_clean:
                        parts = line_clean.split()
                        if parts:
                            pkg = parts[0].split("/")[-1].lower()
                            if pkg not in BUILTIN_BLOCKLIST:
                                evidence.append({
                                    "tech": pkg,
                                    "file": file_path,
                                    "snippet": line_clean,
                                    "type": "dependency",
                                    "is_core": True
                                })
                                
            # 6. Cargo.toml
            elif basename == "cargo.toml":
                in_deps = False
                for line in content.split("\n"):
                    line_clean = line.strip()
                    if line_clean.startswith("[") and "dependencies" in line_clean:
                        in_deps = True
                        continue
                    elif line_clean.startswith("["):
                        in_deps = False
                        
                    if in_deps and line_clean and not line_clean.startswith("#"):
                        parts = line_clean.split("=")
                        if parts and parts[0]:
                            crate = parts[0].strip().strip('"').strip("'").lower()
                            if crate not in BUILTIN_BLOCKLIST:
                                evidence.append({
                                    "tech": crate,
                                    "file": file_path,
                                    "snippet": line_clean,
                                    "type": "dependency",
                                    "is_core": True
                                })
                                
            # 7. Dockerfile
            elif basename == "dockerfile":
                from_line = ""
                for line in content.split("\n"):
                    if line.strip().upper().startswith("FROM"):
                        from_line = line.strip()
                        break
                evidence.append({
                    "tech": "docker",
                    "file": file_path,
                    "snippet": from_line or "Dockerfile configuration",
                    "type": "infra",
                    "is_core": True
                })
                
            # 8. docker-compose.yml
            elif basename in ["docker-compose.yml", "docker-compose.yaml"]:
                services_snippet = []
                lines = content.split("\n")
                for line in lines[:10]:
                    services_snippet.append(line)
                evidence.append({
                    "tech": "docker compose",
                    "file": file_path,
                    "snippet": "\n".join(services_snippet),
                    "type": "infra",
                    "is_core": True
                })
                
            # 9. GitHub Workflows
            elif ".github/workflows" in file_path_lower and basename.endswith((".yml", ".yaml")):
                name_line = ""
                for line in content.split("\n"):
                    if line.strip().startswith("name:"):
                        name_line = line.strip()
                        break
                evidence.append({
                    "tech": "github actions",
                    "file": file_path,
                    "snippet": name_line or f"Workflow file: {basename}",
                    "type": "infra",
                    "is_core": True
                })
                
            # 10. Terraform files
            elif basename.endswith(".tf") or "terraform/" in file_path_lower:
                provider_line = ""
                for line in content.split("\n"):
                    if line.strip().startswith("provider") or line.strip().startswith("resource"):
                        provider_line = line.strip()
                        break
                evidence.append({
                    "tech": "terraform",
                    "file": file_path,
                    "snippet": provider_line or f"Terraform configuration: {basename}",
                    "type": "infra",
                    "is_core": True
                })
                
            # 11. Jupyter Notebooks (.ipynb)
            elif basename.endswith(".ipynb"):
                data = json.loads(content)
                cells = data.get("cells", [])
                imports = []
                for cell in cells:
                    if cell.get("cell_type") == "code":
                        source = cell.get("source", [])
                        source_code = "".join(source) if isinstance(source, list) else str(source)
                        for line in source_code.split("\n"):
                            line_strip = line.strip()
                            if not line_strip or line_strip.startswith("#"):
                                continue
                            import_match = re.match(r"^import\s+(.+)$", line_strip)
                            if import_match:
                                parts = import_match.group(1).split(",")
                                for part in parts:
                                    mod = re.split(r"\s+as\s+|\.", part.strip())[0].strip()
                                    if mod and mod.lower() not in BUILTIN_BLOCKLIST:
                                        imports.append((mod.lower(), line_strip))
                            from_match = re.match(r"^from\s+([a-zA-Z0-9_]+)(?:\.[a-zA-Z0-9_]+)*\s+import\s+", line_strip)
                            if from_match:
                                mod = from_match.group(1).lower()
                                if mod not in BUILTIN_BLOCKLIST:
                                    imports.append((mod, line_strip))
                for imp, line_text in set(imports):
                    tech_name = "scikit-learn" if imp == "sklearn" else imp
                    evidence.append({
                        "tech": tech_name,
                        "file": file_path,
                        "snippet": line_text,
                        "type": "notebook",
                        "is_core": False
                    })
                    
            # 12. README files
            elif "readme" in basename:
                content_lower = content.lower()
                for skill in FLAT_TAXONOMY:
                    escaped = re.escape(skill)
                    pattern = rf"\b{escaped}\b"
                    if skill == "c++":
                        pattern = r"c\+\+"
                    elif skill == "c#":
                        pattern = r"c\#"
                    elif skill == "next.js":
                        pattern = r"next\.js"
                    elif skill == "dotnet":
                        pattern = r"\.net"
                        
                    match = re.search(pattern, content_lower)
                    if match:
                        snippet_line = ""
                        for line in content.split("\n"):
                            if skill in line.lower():
                                snippet_line = line.strip()
                                break
                        tech_name = "scikit-learn" if skill == "sklearn" else skill
                        evidence.append({
                            "tech": tech_name,
                            "file": file_path,
                            "snippet": snippet_line or f"Mentioned {skill} in README",
                            "type": "readme",
                            "is_core": False
                        })
                        
            # 13. Source code files (.py, .js, .ts, etc.)
            elif basename.endswith((".py", ".js", ".jsx", ".ts", ".tsx")):
                if "node_modules" not in file_path_lower and "config" not in basename:
                    parsed_imports = []
                    if basename.endswith(".py"):
                        for line in content.split("\n"):
                            if "#" in line:
                                line = line.split("#", 1)[0]
                            line_strip = line.strip()
                            if not line_strip:
                                continue
                            import_match = re.match(r"^import\s+(.+)$", line_strip)
                            if import_match:
                                parts = import_match.group(1).split(",")
                                for part in parts:
                                    mod = re.split(r"\s+as\s+|\.", part.strip())[0].strip()
                                    if mod and mod.lower() not in BUILTIN_BLOCKLIST:
                                        parsed_imports.append((mod.lower(), line_strip))
                            from_match = re.match(r"^from\s+([a-zA-Z0-9_]+)(?:\.[a-zA-Z0-9_]+)*\s+import\s+", line_strip)
                            if from_match:
                                mod = from_match.group(1).lower()
                                if mod not in BUILTIN_BLOCKLIST:
                                    parsed_imports.append((mod, line_strip))
                    else:
                        for line in content.split("\n"):
                            line_strip = line.strip()
                            if line_strip.startswith("//") or line_strip.startswith("/*") or line_strip.startswith("*"):
                                continue
                            import_match = re.search(r"\bimport\s+.*\s+from\s+['\"]([^'\"]+)['\"]", line_strip)
                            if import_match:
                                pkg = import_match.group(1)
                                if not pkg.startswith("."):
                                    parts = pkg.split("/")
                                    pkg_name = f"{parts[0]}/{parts[1]}" if pkg.startswith("@") and len(parts) >= 2 else parts[0]
                                    if pkg_name.lower() not in BUILTIN_BLOCKLIST:
                                        parsed_imports.append((pkg_name.lower(), line_strip))
                            require_match = re.search(r"\brequire\(\s*['\"]([^'\"]+)['\"]\s*\)", line_strip)
                            if require_match:
                                pkg = require_match.group(1)
                                if not pkg.startswith("."):
                                    parts = pkg.split("/")
                                    pkg_name = f"{parts[0]}/{parts[1]}" if pkg.startswith("@") and len(parts) >= 2 else parts[0]
                                    if pkg_name.lower() not in BUILTIN_BLOCKLIST:
                                        parsed_imports.append((pkg_name.lower(), line_strip))
                    for imp, line_text in set(parsed_imports):
                        tech_name = "scikit-learn" if imp == "sklearn" else imp
                        evidence.append({
                            "tech": tech_name,
                            "file": file_path,
                            "snippet": line_text,
                            "type": "code",
                            "is_core": False
                        })
        except Exception as e:
            print(f"Error extracting evidence from {file_path}: {e}")
            
        return evidence

    def _parse_dependencies(self, file_name: str, content: str) -> List[str]:
        evs = self._extract_evidence_from_file(file_name, content)
        return [e["tech"] for e in evs]
        
    def _parse_python_code_imports(self, source_code: str) -> List[str]:
        evs = self._extract_evidence_from_file("file.py", source_code)
        return [e["tech"] for e in evs]

    def _parse_ipynb_dependencies(self, content: str) -> List[str]:
        evs = self._extract_evidence_from_file("file.ipynb", content)
        return [e["tech"] for e in evs]

    def _parse_readme_dependencies(self, content: str) -> List[str]:
        evs = self._extract_evidence_from_file("README.md", content)
        return [e["tech"] for e in evs]

    def _parse_code_dependencies(self, file_path: str, content: str) -> List[str]:
        evs = self._extract_evidence_from_file(file_path, content)
        return [e["tech"] for e in evs]

    def _clean_dependencies(self, deps: List[str]) -> List[str]:
        cleaned = []
        for d in deps:
            d_clean = d.lower().strip()
            if not d_clean:
                continue
            if d_clean in BUILTIN_BLOCKLIST:
                continue
            if len(d_clean) < 2 and d_clean != "c":
                continue
            cleaned.append(d_clean)
        return list(set(cleaned))


    async def fetch_repo_contents(self, client: httpx.AsyncClient, owner: str, repo_name: str, default_branch: str = "main") -> List[Dict[str, Any]]:
        """Fetches all files in the repository using the Git Trees API recursively."""
        try:
            resp = await client.get(f"{GITHUB_API_URL}/repos/{owner}/{repo_name}/git/trees/{default_branch}?recursive=1")
            if resp.status_code == 200:
                data = resp.json()
                if isinstance(data.get("tree"), list):
                    return data["tree"]
        except Exception:
            pass
            
        # Fallback to root contents if git tree fails
        try:
            resp = await client.get(f"{GITHUB_API_URL}/repos/{owner}/{repo_name}/contents")
            if resp.status_code == 200:
                data = resp.json()
                if isinstance(data, list):
                    return data
        except Exception:
            pass
        return []


    async def fetch_user_pull_requests(self, username: str) -> List[Dict[str, Any]]:
        """
        Fetches recent pull requests by the user to evaluate collaborative work.
        Uses search API: author:username type:pr
        """
        # Search rate limit is very low on free tiers, so we catch errors gracefully
        async with httpx.AsyncClient(headers=self.headers, timeout=15.0) as client:
            try:
                resp = await client.get(f"{GITHUB_API_URL}/search/issues?q=author:{username}+type:pr&per_page=50")
                if resp.status_code == 200:
                    items = resp.json().get("items", [])
                    prs = []
                    for item in items:
                        # Check if repo belongs to user or someone else
                        repo_url = item.get("repository_url", "")
                        repo_fullName = "/".join(repo_url.split("/")[-2:])
                        owner = repo_fullName.split("/")[0] if "/" in repo_fullName else ""
                        
                        prs.append({
                            "title": item.get("title"),
                            "repo": repo_fullName,
                            "state": item.get("state"),
                            "created_at": item.get("created_at"),
                            "closed_at": item.get("closed_at"),
                            "is_collaborative": owner.lower() != username.lower(),
                            "url": item.get("html_url")
                        })
                    return prs
            except Exception as e:
                print(f"Error fetching Pull Requests for {username}: {e}")
        return []

    async def analyze_user(self, username: str) -> Dict[str, Any]:
        """
        Runs the complete GitHub audit analysis pipeline.
        Resolves cached profiles/repos, applies temporal sorting, rate limiting mitigation,
        and analyzes repos for technologies.
        """
        username = username.lower().strip()
        
        # 1. Fetch Profile info
        profile = await self.fetch_profile(username)
        
        # 2. Try fetching cached repos
        cached_repos = get_cached_repos(username)
        
        # 3. Fetch PRs
        prs = await self.fetch_user_pull_requests(username)
        collab_prs_count = sum(1 for pr in prs if pr["is_collaborative"])
        
        # Check if the cached repositories list is incomplete (e.g. cached with a smaller limit previously)
        is_cache_incomplete = False
        if cached_repos:
            public_repos = profile.get("public_repos", 0)
            if len(cached_repos) < public_repos and len(cached_repos) < MAX_REPOS_TO_SCAN:
                is_cache_incomplete = True
                
        if cached_repos and not is_cache_incomplete:
            return {
                "profile": profile,
                "repositories": cached_repos,
                "pull_requests": prs,
                "collaborative_prs_count": collab_prs_count
            }
            
        # 4. Fetch repositories from API
        raw_repos = await self.fetch_user_repos(username)
        
        # Filter logic:
        # Exclude forks by default, unless they have active PRs or they are in the list of repos
        # we have contributed to.
        filtered_repos = []
        for r in raw_repos:
            is_fork = r.get("fork", False)
            pushed_at_str = r.get("pushed_at")
            
            # If it is a fork, we only include it if it was pushed to recently (e.g. last 6 months)
            # or if the user has PRs matching the repo name.
            if is_fork:
                has_pr = any(pr["repo"].lower() == r.get("full_name", "").lower() for pr in prs)
                if not has_pr:
                    # Verify push recency
                    if pushed_at_str:
                        pushed_at = datetime.fromisoformat(pushed_at_str.replace("Z", ""))
                        # If pushed to within last 180 days, keep it
                        if (datetime.utcnow() - pushed_at).days > 180:
                            continue
                    else:
                        continue
            filtered_repos.append(r)
            
        # Sort repositories by recent pushed_at and stargazers count
        def get_sort_key(repo):
            pushed = repo.get("pushed_at") or "1970-01-01T00:00:00Z"
            stars = repo.get("stargazers_count", 0)
            return (pushed, stars)
            
        filtered_repos.sort(key=get_sort_key, reverse=True)
        
        # Select the top repos to scan deeply (Mitigating rate limits)
        repos_to_scan = filtered_repos[:MAX_REPOS_TO_SCAN]
        
        analyzed_repos = []
        
        # Dependency files to look for
        dep_files = ["package.json", "requirements.txt", "cargo.toml", "go.mod", "pom.xml", "gemfile"]
        
        async with httpx.AsyncClient(headers=self.headers, timeout=12.0) as client:
            commit_tasks = []
            contents_tasks = []
            
            # Batch fetch commits and root directory listings concurrently
            for r in repos_to_scan:
                owner = r["owner"]["login"]
                name = r["name"]
                branch = r.get("default_branch", "main")
                commit_tasks.append(self.fetch_user_commits_in_repo(client, owner, name, username))
                contents_tasks.append(self.fetch_repo_contents(client, owner, name, branch))
                
            commit_results, contents_results = await asyncio.gather(
                asyncio.gather(*commit_tasks),
                asyncio.gather(*contents_tasks)
            )
            
            # Queue up individual file downloads concurrently
            file_tasks = []
            task_mapping = [] # List of tuples: (repo_idx, file_type, file_path)
            
            for idx, r in enumerate(repos_to_scan):
                owner = r["owner"]["login"]
                name = r["name"]
                commit_count, _, _ = commit_results[idx]
                is_owned = owner.lower() == username.lower()
                
                # Eligibility: Owned directly by candidate OR has >= 2 commits in it
                if is_owned or commit_count >= 2:
                    repo_items = contents_results[idx]
                    dep_count = 0
                    ipynb_count = 0
                    readme_count = 0
                    code_count = 0
                    infra_count = 0
                    
                    for item in repo_items:
                        item_path = item.get("path", "")
                        item_type = item.get("type", "")
                        
                        if item_type in ["blob", "file"] and item_path:
                            basename = os.path.basename(item_path).lower()
                            
                            # Match dependency configs (limit to 5 per repo)
                            if basename in dep_files and dep_count < 5:
                                file_tasks.append(self.fetch_file_content(client, owner, name, item_path))
                                task_mapping.append((idx, "dep", item_path))
                                dep_count += 1
                            # Match notebooks (limit to 5 per repo)
                            elif basename.endswith(".ipynb") and ipynb_count < 5:
                                file_tasks.append(self.fetch_file_content(client, owner, name, item_path))
                                task_mapping.append((idx, "ipynb", item_path))
                                ipynb_count += 1
                            # Match README files (limit to 2 per repo)
                            elif (basename == "readme.md" or basename == "readme.txt" or basename == "readme") and readme_count < 2:
                                file_tasks.append(self.fetch_file_content(client, owner, name, item_path))
                                task_mapping.append((idx, "readme", item_path))
                                readme_count += 1
                            # Match infra files (limit to 3 per repo)
                            elif (basename == "dockerfile" or basename in ["docker-compose.yml", "docker-compose.yaml"] or 
                                  (".github/workflows/" in item_path.lower() and (basename.endswith(".yml") or basename.endswith(".yaml"))) or 
                                  (basename.endswith(".tf") or "terraform/" in item_path.lower())) and infra_count < 3:
                                file_tasks.append(self.fetch_file_content(client, owner, name, item_path))
                                task_mapping.append((idx, "infra", item_path))
                                infra_count += 1
                            # Match source code files directly (limit to 5 per repo)
                            elif (basename.endswith(".py") or basename.endswith(".js") or basename.endswith(".jsx") or basename.endswith(".ts") or basename.endswith(".tsx")) and code_count < 5:
                                if "node_modules" not in item_path and "config" not in basename:
                                    file_tasks.append(self.fetch_file_content(client, owner, name, item_path))
                                    task_mapping.append((idx, "code", item_path))
                                    code_count += 1
            
            # Execute all file fetches concurrently in one parallel batch
            file_contents = await asyncio.gather(*file_tasks)
            
            # Group parsed dependencies and evidence back to repositories
            repo_dependencies = {i: [] for i in range(len(repos_to_scan))}
            repo_evidence = {i: [] for i in range(len(repos_to_scan))}
            
            for task_idx, content in enumerate(file_contents):
                if content:
                    repo_idx, file_type, file_path = task_mapping[task_idx]
                    evs = self._extract_evidence_from_file(file_path, content)
                    repo_evidence[repo_idx].extend(evs)
                    for ev in evs:
                        repo_dependencies[repo_idx].append(ev["tech"])
            
            # Construct final repository analysis records
            for idx, r in enumerate(repos_to_scan):
                owner = r["owner"]["login"]
                name = r["name"]
                commit_count, first_commit, last_commit = commit_results[idx]
                
                is_owned = owner.lower() == username.lower()
                
                # Check for infra signals directly by checking filenames in repo_items if files weren't downloaded
                repo_items = contents_results[idx]
                for item in repo_items:
                    item_path = item.get("path", "")
                    basename = os.path.basename(item_path).lower()
                    if basename == "dockerfile":
                        repo_dependencies[idx].append("docker")
                    elif basename in ["docker-compose.yml", "docker-compose.yaml"]:
                        repo_dependencies[idx].append("docker compose")
                    elif ".github/workflows" in item_path.lower() and basename.endswith((".yml", ".yaml")):
                        repo_dependencies[idx].append("github actions")
                    elif basename.endswith(".tf") or "terraform/" in item_path.lower():
                        repo_dependencies[idx].append("terraform")
                
                deps_cleaned = self._clean_dependencies(repo_dependencies[idx])
                
                analyzed_repos.append({
                    "name": name,
                    "full_name": r.get("full_name"),
                    "description": r.get("description"),
                    "language": r.get("language"),
                    "stars": r.get("stargazers_count", 0),
                    "forks": r.get("forks_count", 0),
                    "is_fork": r.get("fork", False),
                    "is_archived": r.get("archived", False),
                    "pushed_at": r.get("pushed_at"),
                    "created_at": r.get("created_at"),
                    "commits_by_user": commit_count,
                    "first_commit": first_commit,
                    "last_commit": last_commit,
                    "dependencies": deps_cleaned,
                    "evidence": repo_evidence[idx],
                    "owner": owner,
                    "is_owned": is_owned
                })
        
        # Cache the analyzed repos
        set_cached_repos(username, analyzed_repos)
        
        return {
            "profile": profile,
            "repositories": analyzed_repos,
            "pull_requests": prs,
            "collaborative_prs_count": collab_prs_count
        }

if __name__ == "__main__":
    # Small local async test
    async def main():
        client = GitHubClient()
        try:
            print("Analyzing user...")
            res = await client.analyze_user("torvalds")
            print("Profile name:", res["profile"].get("name"))
            print("Repos Scanned:", len(res["repositories"]))
        except Exception as e:
            print("Test error (likely rate limit):", e)
            
    asyncio.run(main())
