const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'github_cache.db');
const db = new sqlite3.Database(dbPath);

// Promisify Database functions
const dbRun = (query, params = []) => {
    return new Promise((resolve, reject) => {
        db.run(query, params, function (err) {
            if (err) reject(err);
            else resolve(this);
        });
    });
};

const dbGet = (query, params = []) => {
    return new Promise((resolve, reject) => {
        db.get(query, params, (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
};

const dbAll = (query, params = []) => {
    return new Promise((resolve, reject) => {
        db.all(query, params, (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
};

let dbReadyPromise = null;
const initDb = () => {
    if (!dbReadyPromise) {
        dbReadyPromise = (async () => {
            try {
                await dbRun(`
                    CREATE TABLE IF NOT EXISTS users (
                        username TEXT PRIMARY KEY,
                        profile_data TEXT,
                        last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                    )
                `);
                await dbRun(`
                    CREATE TABLE IF NOT EXISTS repos (
                        username TEXT,
                        repo_name TEXT,
                        repo_data TEXT,
                        PRIMARY KEY (username, repo_name)
                    )
                `);
                await dbRun(`
                    CREATE TABLE IF NOT EXISTS code_chunks (
                        id TEXT PRIMARY KEY,
                        username TEXT,
                        repo_name TEXT,
                        file_path TEXT,
                        language TEXT,
                        symbol_name TEXT,
                        start_line INTEGER,
                        end_line INTEGER,
                        content TEXT,
                        embedding TEXT,
                        indexed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                    )
                `);
                await dbRun(`CREATE INDEX IF NOT EXISTS idx_code_chunks_user ON code_chunks (username)`);
                await dbRun(`CREATE INDEX IF NOT EXISTS idx_code_chunks_user_repo ON code_chunks (username, repo_name)`);
            } catch (e) {
                console.error("Database table creation failed", e);
            }
        })();
    }
    return dbReadyPromise;
};

// Initialize DB on module load
initDb().catch(err => console.error("Database initialization failed", err));

const getCachedProfile = async (username) => {
    try {
        await initDb();
        const row = await dbGet("SELECT profile_data, last_updated FROM users WHERE username = ?", [username.toLowerCase()]);
        if (!row) return null;
        
        // Expire cache after 24 hours
        const diffHours = (new Date() - new Date(row.last_updated)) / 36e5;
        if (diffHours > 24) return null;
        
        return JSON.parse(row.profile_data);
    } catch (e) {
        console.error("Cache getCachedProfile error", e);
        return null;
    }
};

const getCachedRepos = async (username) => {
    try {
        await initDb();
        const rows = await dbAll("SELECT repo_data FROM repos WHERE username = ?", [username.toLowerCase()]);
        if (!rows || rows.length === 0) return null;
        return rows.map(r => JSON.parse(r.repo_data));
    } catch (e) {
        console.error("Cache getCachedRepos error", e);
        return null;
    }
};

const saveProfileCache = async (username, profileData) => {
    try {
        await initDb();
        await dbRun(
            "INSERT OR REPLACE INTO users (username, profile_data, last_updated) VALUES (?, ?, CURRENT_TIMESTAMP)",
            [username.toLowerCase(), JSON.stringify(profileData)]
        );
    } catch (e) {
        console.error("Cache saveProfileCache error", e);
    }
};

const saveReposCache = async (username, reposData) => {
    try {
        await initDb();
        // Clear existing repos cache for this user first
        await dbRun("DELETE FROM repos WHERE username = ?", [username.toLowerCase()]);
        for (const repo of reposData) {
            await dbRun(
                "INSERT INTO repos (username, repo_name, repo_data) VALUES (?, ?, ?)",
                [username.toLowerCase(), repo.name, JSON.stringify(repo)]
            );
        }
    } catch (e) {
        console.error("Cache saveReposCache error", e);
    }
};

const saveCodeChunks = async (username, chunks) => {
    try {
        await initDb();
        for (const chunk of chunks) {
            await dbRun(
                `INSERT OR REPLACE INTO code_chunks 
                (id, username, repo_name, file_path, language, symbol_name, start_line, end_line, content, embedding, indexed_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
                [
                    chunk.id,
                    username.toLowerCase(),
                    chunk.repo_name,
                    chunk.file_path,
                    chunk.language || 'text',
                    chunk.symbol_name || '',
                    chunk.start_line,
                    chunk.end_line,
                    chunk.content,
                    chunk.embedding ? JSON.stringify(chunk.embedding) : null
                ]
            );
        }
    } catch (e) {
        console.error("Cache saveCodeChunks error", e);
    }
};

const getCachedCodeChunks = async (username, repoName = null) => {
    try {
        await initDb();
        let query = "SELECT id, username, repo_name, file_path, language, symbol_name, start_line, end_line, content, embedding FROM code_chunks WHERE username = ?";
        const params = [username.toLowerCase()];
        if (repoName) {
            query += " AND LOWER(repo_name) = ?";
            params.push(repoName.toLowerCase());
        }
        const rows = await dbAll(query, params);
        if (!rows || rows.length === 0) return [];
        return rows.map(r => ({
            ...r,
            embedding: r.embedding ? JSON.parse(r.embedding) : null
        }));
    } catch (e) {
        console.error("Cache getCachedCodeChunks error", e);
        return [];
    }
};

const hasCachedCodeChunks = async (username, repoName = null) => {
    try {
        await initDb();
        let query = "SELECT COUNT(*) as cnt FROM code_chunks WHERE username = ?";
        const params = [username.toLowerCase()];
        if (repoName) {
            query += " AND LOWER(repo_name) = ?";
            params.push(repoName.toLowerCase());
        }
        const row = await dbGet(query, params);
        return row && row.cnt > 0;
    } catch (e) {
        return false;
    }
};

module.exports = {
    initDb,
    getCachedProfile,
    getCachedRepos,
    saveProfileCache,
    saveReposCache,
    saveCodeChunks,
    getCachedCodeChunks,
    hasCachedCodeChunks
};
