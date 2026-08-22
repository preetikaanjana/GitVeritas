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

const initDb = async () => {
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
    } catch (e) {
        console.error("Database table creation failed", e);
    }
};

// Initialize DB on module load
initDb().catch(err => console.error("Database initialization failed", err));

const getCachedProfile = async (username) => {
    try {
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

module.exports = {
    getCachedProfile,
    getCachedRepos,
    saveProfileCache,
    saveReposCache
};
