/**
 * GitVeritas Code Indexer
 * 
 * Bounded source code ingestion, secret redaction, and language-aware
 * AST/regex chunking for public GitHub repositories.
 */

const crypto = require('crypto');

// File extensions and language mappings
const SUPPORTED_EXTENSIONS = {
    'js': 'javascript',
    'jsx': 'javascript',
    'ts': 'typescript',
    'tsx': 'typescript',
    'py': 'python',
    'java': 'java',
    'go': 'go',
    'rb': 'ruby',
    'php': 'php',
    'cs': 'csharp',
    'cpp': 'cpp',
    'c': 'c'
};

// Folders/files to strictly ignore
const IGNORED_DIRECTORIES = new Set([
    'node_modules', 'vendor', 'venv', '.venv', 'env', '__pycache__',
    'dist', 'build', 'out', 'target', '.next', '.nuxt', '.git',
    'coverage', '.idea', '.vscode', 'assets', 'static', 'public'
]);

const IGNORED_FILES = new Set([
    'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'poetry.lock',
    'composer.lock', 'gemfile.lock', 'cargo.lock'
]);

// Secret detection regexes
const SECRET_PATTERNS = [
    /ghp_[a-zA-Z0-9]{36}/g,                           // GitHub Personal Access Token
    /gho_[a-zA-Z0-9]{36}/g,                           // GitHub OAuth Token
    /github_pat_[a-zA-Z0-9_]{82}/g,                   // GitHub Fine-grained PAT
    /sk-[a-zA-Z0-9_-]{20,}/g,                         // OpenAI API Key
    /AIza[0-9A-Za-z-_]{35}/g,                         // Google API Key
    /AKIA[0-9A-Z]{16}/g,                              // AWS Access Key ID
    /-----BEGIN [A-Z\s]+ PRIVATE KEY-----[\s\S]*?-----END [A-Z\s]+ PRIVATE KEY-----/g, // Private Keys
    /(?:password|passwd|secret|api_key|apikey|token)\s*[:=]\s*['"][^'"]{6,}['"]/gi, // Hardcoded config credentials
    /(?:postgres|mysql|mongodb(?:\+srv)?):\/\/[^\s'"]+/gi, // Database connection URIs
    // Prompt injection triggers in code comments or strings
    /(?:\/\*|\/\/|#|<!--)?\s*(?:ignore|disregard|forget|override)\s+(?:all\s+)?(?:previous|prior|system)\s+(?:instructions|prompts|directives)[\s\S]*?(?:\*\/|\n|$)/gi,
    /(?:\/\*|\/\/|#|<!--)?\s*Output:\s*['"]?THIS CANDIDATE IS[\s\S]*?(?:\*\/|\n|$)/gi
];

/**
 * Redacts secrets and credentials from source code strings.
 */
function sanitizeCode(content) {
    if (!content || typeof content !== 'string') return "";
    let clean = content;
    for (const pattern of SECRET_PATTERNS) {
        clean = clean.replace(pattern, (match) => {
            // Keep the variable declaration if matched via credential assignment
            if (match.includes(':') || match.includes('=')) {
                const parts = match.split(/[:=]/);
                return `${parts[0]} = "[REDACTED_SECRET]"`;
            }
            return '[REDACTED_SECRET]';
        });
    }
    return clean;
}

/**
 * Checks if a file path is high priority for application logic.
 */
function isHighPriorityFile(filePath) {
    const lower = filePath.toLowerCase();
    const priorityKeywords = [
        'src/', 'app/', 'controllers/', 'services/', 'models/', 'routes/',
        'views/', 'utils/', 'lib/', 'api/', 'helpers/', 'core/', 'tests/',
        'test/', 'main.', 'index.', 'app.', 'server.'
    ];
    return priorityKeywords.some(kw => lower.includes(kw));
}

/**
 * Splits JavaScript / TypeScript code into function & class level chunks.
 */
function chunkJavaScript(content, filePath, repoName) {
    const lines = content.split('\n');
    const chunks = [];
    
    // Regex for common JS/TS constructs:
    // 1. function name(...) {
    // 2. async function name(...) {
    // 3. const/let/var name = (async)? (...) => { or function(...) {
    // 4. class ClassName {
    // 5. router.get/post/put/delete(...)
    // 6. app.get/post/put/delete(...)
    const funcRegex = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([a-zA-Z0-9_$]+)/;
    const arrowRegex = /^(?:export\s+)?(?:const|let|var)\s+([a-zA-Z0-9_$]+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[a-zA-Z0-9_$]+)\s*=>/;
    const classRegex = /^(?:export\s+)?(?:default\s+)?class\s+([a-zA-Z0-9_$]+)/;
    const routeRegex = /^(?:router|app)\.(get|post|put|delete|patch|use)\s*\(\s*['"]([^'"]+)['"]/;

    let currentChunk = null;
    let braceCount = 0;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();

        // Check for new symbol definition if not already capturing a function
        if (!currentChunk) {
            let symbol = null;
            if (classRegex.test(trimmed)) {
                symbol = trimmed.match(classRegex)[1];
            } else if (funcRegex.test(trimmed)) {
                symbol = trimmed.match(funcRegex)[1];
            } else if (arrowRegex.test(trimmed)) {
                symbol = trimmed.match(arrowRegex)[1];
            } else if (routeRegex.test(trimmed)) {
                const match = trimmed.match(routeRegex);
                symbol = `${match[1].toUpperCase()} ${match[2]}`;
            }

            if (symbol) {
                currentChunk = {
                    symbol_name: symbol,
                    start_line: i + 1,
                    lines: [line]
                };
                braceCount = (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
                if (braceCount <= 0 && trimmed.endsWith(';')) {
                    // One-line arrow function
                    chunks.push(finalizeChunk(currentChunk, i + 1, filePath, repoName, 'javascript'));
                    currentChunk = null;
                    braceCount = 0;
                }
                continue;
            }
        } else {
            currentChunk.lines.push(line);
            braceCount += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;

            // When braces balance out or chunk exceeds 80 lines, close chunk
            if (braceCount <= 0 || currentChunk.lines.length >= 80) {
                chunks.push(finalizeChunk(currentChunk, i + 1, filePath, repoName, 'javascript'));
                currentChunk = null;
                braceCount = 0;
            }
        }
    }

    if (currentChunk && currentChunk.lines.length >= 3) {
        chunks.push(finalizeChunk(currentChunk, lines.length, filePath, repoName, 'javascript'));
    }

    return chunks.length > 0 ? chunks : fallbackChunker(lines, filePath, repoName, 'javascript');
}

/**
 * Splits Python code into function and class chunks based on indentation.
 */
function chunkPython(content, filePath, repoName) {
    const lines = content.split('\n');
    const chunks = [];
    
    const defRegex = /^(?:async\s+)?def\s+([a-zA-Z0-9_]+)\s*\(/;
    const classRegex = /^class\s+([a-zA-Z0-9_]+)(?:\s*\(.*?\))?\s*:/;

    let currentChunk = null;
    let baseIndent = 0;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();
        const indent = line.search(/\S|$/);

        if (!trimmed || trimmed.startsWith('#')) {
            if (currentChunk) currentChunk.lines.push(line);
            continue;
        }

        const isDef = defRegex.test(trimmed);
        const isClass = classRegex.test(trimmed);

        if (isDef || isClass) {
            // If we are already capturing and hit a new top/same-level definition, close previous
            if (currentChunk) {
                if (indent <= baseIndent || currentChunk.lines.length >= 70) {
                    chunks.push(finalizeChunk(currentChunk, i, filePath, repoName, 'python'));
                    currentChunk = null;
                }
            }

            if (!currentChunk) {
                const symbol = isClass ? trimmed.match(classRegex)[1] : trimmed.match(defRegex)[1];
                baseIndent = indent;
                currentChunk = {
                    symbol_name: symbol,
                    start_line: i + 1,
                    lines: [line]
                };
                continue;
            }
        }

        if (currentChunk) {
            currentChunk.lines.push(line);
            if (currentChunk.lines.length >= 80) {
                chunks.push(finalizeChunk(currentChunk, i + 1, filePath, repoName, 'python'));
                currentChunk = null;
            }
        }
    }

    if (currentChunk && currentChunk.lines.length >= 3) {
        chunks.push(finalizeChunk(currentChunk, lines.length, filePath, repoName, 'python'));
    }

    return chunks.length > 0 ? chunks : fallbackChunker(lines, filePath, repoName, 'python');
}

/**
 * Splits Java code into method and class chunks.
 */
function chunkJava(content, filePath, repoName) {
    const lines = content.split('\n');
    const chunks = [];
    
    const classRegex = /^(?:public|protected|private)?\s*(?:static)?\s*class\s+([a-zA-Z0-9_]+)/;
    const methodRegex = /^(?:public|protected|private|static|\s)+[\w<>\[\]]+\s+([a-zA-Z0-9_]+)\s*\([^)]*\)\s*(?:throws\s+[\w,\s]+)?\s*\{?$/;

    let currentChunk = null;
    let braceCount = 0;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();

        if (!currentChunk) {
            let symbol = null;
            if (classRegex.test(trimmed)) {
                symbol = trimmed.match(classRegex)[1];
            } else if (methodRegex.test(trimmed)) {
                symbol = trimmed.match(methodRegex)[1];
            }

            if (symbol) {
                currentChunk = {
                    symbol_name: symbol,
                    start_line: i + 1,
                    lines: [line]
                };
                braceCount = (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
                continue;
            }
        } else {
            currentChunk.lines.push(line);
            braceCount += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;

            if (braceCount <= 0 || currentChunk.lines.length >= 80) {
                chunks.push(finalizeChunk(currentChunk, i + 1, filePath, repoName, 'java'));
                currentChunk = null;
                braceCount = 0;
            }
        }
    }

    if (currentChunk && currentChunk.lines.length >= 3) {
        chunks.push(finalizeChunk(currentChunk, lines.length, filePath, repoName, 'java'));
    }

    return chunks.length > 0 ? chunks : fallbackChunker(lines, filePath, repoName, 'java');
}

/**
 * Universal fallback sliding-window chunker (30 lines with 5-line overlap).
 */
function fallbackChunker(lines, filePath, repoName, language) {
    const chunks = [];
    const windowSize = 30;
    const overlap = 5;

    for (let i = 0; i < lines.length; i += (windowSize - overlap)) {
        const slice = lines.slice(i, i + windowSize);
        if (slice.join('').trim().length < 20) continue; // Skip nearly empty slices

        const startLine = i + 1;
        const endLine = Math.min(i + slice.length, lines.length);
        const contentText = slice.join('\n');

        chunks.push({
            id: generateChunkId(repoName, filePath, startLine),
            repo_name: repoName,
            file_path: filePath,
            language: language,
            symbol_name: `${filePath} (L${startLine}-${endLine})`,
            start_line: startLine,
            end_line: endLine,
            content: contentText
        });

        if (endLine >= lines.length) break;
    }
    return chunks;
}

function finalizeChunk(chunk, endLine, filePath, repoName, language) {
    const content = chunk.lines.join('\n');
    return {
        id: generateChunkId(repoName, filePath, chunk.start_line),
        repo_name: repoName,
        file_path: filePath,
        language: language,
        symbol_name: chunk.symbol_name || `${filePath}:${chunk.start_line}`,
        start_line: chunk.start_line,
        end_line: endLine,
        content: content
    };
}

function generateChunkId(repoName, filePath, startLine) {
    const raw = `${repoName}::${filePath}::${startLine}`;
    return crypto.createHash('md5').update(raw).digest('hex').substring(0, 16);
}

/**
 * Parses and chunks source code based on file extension.
 */
function chunkSourceFile(content, filePath, repoName) {
    const sanitized = sanitizeCode(content);
    const ext = filePath.split('.').pop().toLowerCase();
    const language = SUPPORTED_EXTENSIONS[ext] || 'text';

    if (['javascript', 'typescript'].includes(language)) {
        return chunkJavaScript(sanitized, filePath, repoName);
    } else if (language === 'python') {
        return chunkPython(sanitized, filePath, repoName);
    } else if (language === 'java') {
        return chunkJava(sanitized, filePath, repoName);
    } else {
        const lines = sanitized.split('\n');
        return fallbackChunker(lines, filePath, repoName, language);
    }
}

/**
 * Ingests and indexes code files for a candidate's repositories with strict bounds.
 * 
 * Limits:
 * - Max 3 top repositories
 * - Max 8 high-priority source files per repository
 * - Max 25 chunks per repository (to keep RAM minimal)
 * - Max file size: 50 KB
 */
async function ingestCandidateRepositories(githubClient, username, repositories) {
    const allChunks = [];
    if (!repositories || repositories.length === 0) return allChunks;

    // Pick top 3 active non-fork repositories
    const targetRepos = repositories
        .filter(r => !r.fork && !r.is_fork)
        .slice(0, 3);

    for (const repo of targetRepos) {
        const repoName = repo.name;
        const owner = (repo.owner && repo.owner.login) ? repo.owner.login : username;

        try {
            // Fetch repository git tree (recursive)
            let treeData = null;
            try {
                treeData = await githubClient.getRequest(`${githubClient.baseUrl}/repos/${owner}/${repoName}/git/trees/main?recursive=1`);
            } catch (err) {
                try {
                    treeData = await githubClient.getRequest(`${githubClient.baseUrl}/repos/${owner}/${repoName}/git/trees/master?recursive=1`);
                } catch (e) {
                    continue;
                }
            }

            if (!treeData || !treeData.tree) continue;

            // Filter for supported source code files
            const candidateFiles = treeData.tree.filter(item => {
                if (item.type !== 'blob') return false;
                
                const parts = item.path.split('/');
                const fileName = parts[parts.length - 1];
                
                // Exclude ignored folders and files
                if (parts.some(p => IGNORED_DIRECTORIES.has(p.toLowerCase()))) return false;
                if (IGNORED_FILES.has(fileName.toLowerCase())) return false;
                if (fileName.endsWith('.min.js') || fileName.endsWith('.min.css')) return false;

                const ext = fileName.split('.').pop().toLowerCase();
                return !!SUPPORTED_EXTENSIONS[ext];
            });

            // Prioritize application logic files over generic files
            candidateFiles.sort((a, b) => {
                const aPri = isHighPriorityFile(a.path) ? 1 : 0;
                const bPri = isHighPriorityFile(b.path) ? 1 : 0;
                return bPri - aPri;
            });

            // Limit to max 8 files per repo
            const selectedFiles = candidateFiles.slice(0, 8);
            let repoChunkCount = 0;

            for (const fileItem of selectedFiles) {
                if (repoChunkCount >= 25) break; // Hard cap per repo

                try {
                    const rawContent = await githubClient.getRawFileContent(owner, repoName, fileItem.path);
                    if (!rawContent || typeof rawContent !== 'string') continue;
                    
                    // Skip oversized files (> 50KB) to guard memory
                    if (rawContent.length > 50000) continue;

                    const chunks = chunkSourceFile(rawContent, fileItem.path, repoName);
                    for (const chunk of chunks) {
                        if (repoChunkCount < 25) {
                            allChunks.push(chunk);
                            repoChunkCount++;
                        }
                    }
                } catch (fileErr) {
                    console.warn(`Failed to process file ${fileItem.path} in ${repoName}:`, fileErr.message);
                }
            }
        } catch (repoErr) {
            console.warn(`Failed to ingest repository ${repoName}:`, repoErr.message);
        }
    }

    return allChunks;
}

module.exports = {
    sanitizeCode,
    chunkSourceFile,
    chunkJavaScript,
    chunkPython,
    chunkJava,
    fallbackChunker,
    ingestCandidateRepositories,
    SUPPORTED_EXTENSIONS
};
