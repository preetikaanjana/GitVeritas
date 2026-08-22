const fs = require('fs');
const path = require('path');
const pdf = require('pdf-parse');
const mammoth = require('mammoth');

const TECH_TAXONOMY = {
    "languages": [
        "python", "javascript", "typescript", "java", "c++", "c#", "go", "golang", "rust",
        "ruby", "php", "swift", "kotlin", "scala", "r", "shell", "bash", "sql", "html", "css"
    ],
    "frameworks": [
        "react", "angular", "vue", "next.js", "nextjs", "nuxt", "svelte", "django", "flask",
        "fastapi", "express", "spring", "spring boot", "laravel", "rails", "ruby on rails",
        "asp.net", "dotnet", "dotnet core", "flutter", "react native", "electron"
    ],
    "libraries_tools": [
        "tensorflow", "pytorch", "keras", "scikit-learn", "sklearn", "pandas", "numpy",
        "docker", "kubernetes", "k8s", "aws", "azure", "gcp", "google cloud", "terraform",
        "ansible", "jenkins", "git", "redis", "mongodb", "postgresql", "postgres", "mysql",
        "sqlite", "graphql", "rest api", "grpc", "webpack", "vite", "tailwind", "bootstrap"
    ]
};

class ResumeParser {
    constructor() {
        this.flatTaxonomy = [];
        for (const category in TECH_TAXONOMY) {
            this.flatTaxonomy.push(...TECH_TAXONOMY[category]);
        }
        this.flatTaxonomy = [...new Set(this.flatTaxonomy)];
    }

    async extractText(filePath, originalName = null) {
        if (!fs.existsSync(filePath)) {
            throw new Error(`File not found: ${filePath}`);
        }
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

    async _extractPdfText(filePath) {
        try {
            const dataBuffer = fs.readFileSync(filePath);
            const data = await pdf(dataBuffer);
            return data.text || "";
        } catch (e) {
            console.error(`Error reading PDF: ${e}`);
            return "";
        }
    }

    async _extractDocxText(filePath) {
        try {
            const result = await mammoth.extractRawText({ path: filePath });
            return result.value || "";
        } catch (e) {
            console.error(`Error reading DOCX: ${e}`);
            return "";
        }
    }

    extractSkills(text) {
        const foundSkills = [];
        const textLower = text.toLowerCase();
        
        for (const skill of this.flatTaxonomy) {
            // Escape special chars
            let escapedSkill = skill.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
            let pattern;
            
            if (skill === "c++") {
                pattern = /c\+\+/gi;
            } else if (skill === "c#") {
                pattern = /c\#/gi;
            } else if (skill === "next.js") {
                pattern = /next\.js/gi;
            } else if (skill === "dotnet") {
                pattern = /\.net/gi;
            } else {
                pattern = new RegExp(`\\b${escapedSkill}\\b`, 'gi');
            }
            
            if (pattern.test(textLower)) {
                foundSkills.push(skill);
            }
        }
        return foundSkills;
    }

    extractQuantifiableClaims(text) {
        const lines = text.split("\n");
        const claims = [];
        // Extract lines with numbers/percentages to analyze metrics
        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed && (/\b\d+%?\b/.test(trimmed) || /percent/i.test(trimmed))) {
                if (trimmed.length > 20 && trimmed.length < 300) {
                    claims.push(trimmed);
                }
            }
        }
        return claims;
    }
}

module.exports = { ResumeParser, TECH_TAXONOMY };
