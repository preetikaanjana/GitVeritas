/**
 * GitVeritas Code Retriever
 * 
 * Embeddings, semantic vector retrieval, and hybrid keyword search
 * over cached candidate source code chunks.
 */

const { getEmbedding, cosineSimilarity } = require('./analyzer');
const { saveCodeChunks, getCachedCodeChunks, hasCachedCodeChunks } = require('./cache');
const { ingestCandidateRepositories } = require('./code_indexer');

/**
 * Ensures code chunks for the candidate's top repositories are ingested,
 * embedded, and cached in SQLite.
 */
async function indexCandidateCodebase(githubClient, username, repositories, force = false) {
    if (!username) return [];

    const usernameLower = username.toLowerCase().trim();

    // 1. Check if already indexed in SQLite
    if (!force) {
        const alreadyIndexed = await hasCachedCodeChunks(usernameLower);
        if (alreadyIndexed) {
            return await getCachedCodeChunks(usernameLower);
        }
    }

    // 2. Ingest code chunks from public repositories
    const rawChunks = await ingestCandidateRepositories(githubClient, usernameLower, repositories);
    if (!rawChunks || rawChunks.length === 0) {
        return [];
    }

    // 3. Generate 384-d vector embeddings using the existing SBERT pipeline
    const embeddedChunks = [];
    for (const chunk of rawChunks) {
        try {
            // Text to embed: symbol name + path + truncated content (max 500 chars)
            const textToEmbed = `${chunk.symbol_name} in ${chunk.file_path}: ${chunk.content.substring(0, 400)}`;
            const emb = await getEmbedding(textToEmbed);
            embeddedChunks.push({
                ...chunk,
                embedding: emb // 384-float array or null
            });
        } catch (err) {
            embeddedChunks.push({
                ...chunk,
                embedding: null
            });
        }
    }

    // 4. Cache in SQLite
    await saveCodeChunks(usernameLower, embeddedChunks);

    return embeddedChunks;
}

/**
 * Searches indexed codebase chunks using hybrid semantic + lexical retrieval.
 * 
 * @param {string} username - GitHub username
 * @param {string} query - Search query (e.g. "authentication JWT middleware", "React useState")
 * @param {number} topK - Max results to return (default 3)
 * @param {string} repoFilter - Optional repository filter
 */
async function searchCodebase(username, query, topK = 3, repoFilter = null) {
    if (!username || !query) return [];

    const usernameLower = username.toLowerCase().trim();
    const chunks = await getCachedCodeChunks(usernameLower, repoFilter);
    if (!chunks || chunks.length === 0) return [];

    const queryClean = query.toLowerCase().trim();
    const queryTokens = queryClean.split(/\s+/).filter(t => t.length > 2);

    // 1. Compute query vector embedding
    let queryEmb = null;
    try {
        queryEmb = await getEmbedding(queryClean);
    } catch (e) {
        queryEmb = null;
    }

    const scoredChunks = chunks.map(chunk => {
        let semanticScore = 0.0;
        if (queryEmb && chunk.embedding && Array.isArray(chunk.embedding)) {
            semanticScore = cosineSimilarity(queryEmb, chunk.embedding);
        }

        // Lexical match bonus
        let lexicalMatches = 0;
        const textContent = `${chunk.symbol_name} ${chunk.file_path} ${chunk.content}`.toLowerCase();
        for (const token of queryTokens) {
            if (textContent.includes(token)) {
                lexicalMatches++;
            }
        }
        const lexicalScore = queryTokens.length > 0 ? (lexicalMatches / queryTokens.length) : 0;

        // Combined hybrid score (70% semantic, 30% lexical if semantic available; 100% lexical fallback)
        let finalScore = 0;
        if (queryEmb && chunk.embedding) {
            finalScore = (semanticScore * 0.7) + (lexicalScore * 0.3);
        } else {
            finalScore = lexicalScore;
        }

        return {
            ...chunk,
            similarity: Math.round(finalScore * 100) / 100,
            semantic_score: Math.round(semanticScore * 100) / 100,
            lexical_score: Math.round(lexicalScore * 100) / 100
        };
    });

    // Filter chunks with reasonable relevance and sort descending
    return scoredChunks
        .filter(c => c.similarity > 0.15 || c.lexical_score > 0.25)
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, topK);
}

module.exports = {
    indexCandidateCodebase,
    searchCodebase
};
