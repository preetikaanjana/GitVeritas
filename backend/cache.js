const fs = require('fs');
const path = require('path');
const cachePath = path.join(__dirname, 'github_cache.json');

const loadCache = () => {
    if (!fs.existsSync(cachePath)) {
        return { users: {}, repos: {} };
    }
    try {
        return JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    } catch (e) {
        return { users: {}, repos: {} };
    }
};

const saveCache = (data) => {
    try {
        fs.writeFileSync(cachePath, JSON.stringify(data, null, 2), 'utf8');
    } catch (e) {
        console.error("Failed to write cache file", e);
    }
};

const getCachedProfile = async (username) => {
    try {
        const cache = loadCache();
        const user = cache.users[username.toLowerCase()];
        if (!user) return null;
        
        // Expire cache after 24 hours
        const diffHours = (new Date() - new Date(user.last_updated)) / 36e5;
        if (diffHours > 24) return null;
        
        return user.profile_data;
    } catch (e) {
        console.error("Cache getCachedProfile error", e);
        return null;
    }
};

const getCachedRepos = async (username) => {
    try {
        const cache = loadCache();
        return cache.repos[username.toLowerCase()] || null;
    } catch (e) {
        console.error("Cache getCachedRepos error", e);
        return null;
    }
};

const saveProfileCache = async (username, profileData) => {
    try {
        const cache = loadCache();
        cache.users[username.toLowerCase()] = {
            profile_data: profileData,
            last_updated: new Date().toISOString()
        };
        saveCache(cache);
    } catch (e) {
        console.error("Cache saveProfileCache error", e);
    }
};

const saveReposCache = async (username, reposData) => {
    try {
        const cache = loadCache();
        cache.repos[username.toLowerCase()] = reposData;
        saveCache(cache);
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
