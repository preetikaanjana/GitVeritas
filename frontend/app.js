document.addEventListener("DOMContentLoaded", () => {
    let lastAuditData = null;
    const downloadVerifiedPageBtn = document.getElementById("downloadVerifiedPageBtn");

    const auditForm = document.getElementById("auditForm");
    const submitBtn = document.getElementById("submitBtn");
    const spinner = document.getElementById("spinner");
    const emptyState = document.getElementById("emptyState");
    const errorBox = document.getElementById("errorBox");
    const errorText = document.getElementById("errorText");
    const resultsDashboard = document.getElementById("resultsDashboard");
    
    // Resume drag and drop / display file name
    const fileInput = document.getElementById("resume");
    const filePlaceholder = document.querySelector(".file-upload-placeholder");
    
    fileInput.addEventListener("change", (e) => {
        if (fileInput.files.length > 0) {
            const fileName = fileInput.files[0].name;
            filePlaceholder.innerHTML = `
                <span class="upload-icon">📄</span>
                <span class="upload-text" style="color: var(--color-accent);">${fileName}</span>
                <span class="upload-subtext">Click or drag to change file</span>
            `;
        }
    });

    // Intercept click on the submit button for maximum browser compatibility
    submitBtn.addEventListener("click", async (e) => {
        e.preventDefault();
        
        // Define animation scopes globally for cleanup
        let animInterval = null;
        let stepTimers = [];
        
        try {
            // 1. Immediate visual feedback: show spinner and disable button
            if (submitBtn) {
                submitBtn.disabled = true;
                const span = submitBtn.querySelector("span");
                if (span) span.innerText = "Verifying inputs...";
            }
            if (spinner) spinner.classList.remove("hidden");
            
            // Reset display states safely
            if (errorBox) errorBox.classList.add("hidden");
            if (resultsDashboard) resultsDashboard.classList.add("hidden");
            if (emptyState) emptyState.classList.add("hidden");
            
            const file = (fileInput && fileInput.files) ? fileInput.files[0] : null;
            const usernameInput = document.getElementById("github_username");
            const username = usernameInput ? usernameInput.value.trim() : "";
            const tokenInput = document.getElementById("github_token");
            const token = tokenInput ? tokenInput.value.trim() : "";
            
            // 2. Perform client-side validation
            if (!file) {
                showError("Please select a resume file (PDF or DOCX) to upload.");
                return;
            }
            if (!username) {
                showError("Please enter a GitHub username to verify.");
                return;
            }
            
            // Show analyzingCard and start circular scanning loaders
            const analyzingCard = document.getElementById("analyzingCard");
            if (analyzingCard) {
                analyzingCard.classList.remove("hidden");
                const analyzingTitle = document.getElementById("analyzingTitle");
                if (analyzingTitle) analyzingTitle.innerText = "Initiating audit scan...";
                const analyzingSub = document.getElementById("analyzingSub");
                if (analyzingSub) analyzingSub.innerText = "Please hold on, analyzing active repositories.";
            }
            
            const checkItems = {
                resume: document.getElementById("check-resume"),
                profile: document.getElementById("check-profile"),
                repos: document.getElementById("check-repos"),
                notebooks: document.getElementById("check-notebooks"),
                alignment: document.getElementById("check-alignment")
            };
            
            // Reset checklist state in UI
            Object.values(checkItems).forEach(item => {
                if (item) {
                    item.className = "checklist-item";
                    const icon = item.querySelector(".check-icon");
                    if (icon) icon.innerText = "⏳";
                }
            });

            const progressText = document.getElementById("scanProgressText");
            let progressVal = 0;
            let currentStep = 0;
            
            const stepDurations = [800, 1000, 1500, 1500, 1500]; 
            const stepTargets = [15, 35, 60, 80, 95];
            
            function updateProgressUI(val) {
                if (progressText) progressText.innerText = `${val}%`;
            }
            
            // Start progress loader ticker
            animInterval = setInterval(() => {
                if (progressVal < stepTargets[currentStep]) {
                    progressVal += 1;
                    updateProgressUI(progressVal);
                }
            }, 60);

            // Cascade active checklist steps
            function activateStep(stepIdx) {
                if (stepIdx >= 5) return;
                currentStep = stepIdx;
                
                if (stepIdx > 0) {
                    const prevKey = Object.keys(checkItems)[stepIdx - 1];
                    const prevItem = checkItems[prevKey];
                    if (prevItem) {
                        prevItem.className = "checklist-item done";
                        const icon = prevItem.querySelector(".check-icon");
                        if (icon) icon.innerText = "✓";
                    }
                }
                
                const currKey = Object.keys(checkItems)[stepIdx];
                const currItem = checkItems[currKey];
                if (currItem) {
                    currItem.className = "checklist-item active";
                    const icon = currItem.querySelector(".check-icon");
                    if (icon) icon.innerText = "⚡";
                }
                
                const timer = setTimeout(() => {
                    activateStep(stepIdx + 1);
                }, stepDurations[stepIdx]);
                stepTimers.push(timer);
            }
            
            activateStep(0);
            
            if (submitBtn) {
                const span = submitBtn.querySelector("span");
                if (span) span.innerText = "Auditing codebase...";
            }

            const formData = new FormData();
            formData.append("resume", file);
            formData.append("github_username", username);
            if (token) {
                formData.append("github_token", token);
            }

            const response = await fetch("/api/audit", {
                method: "POST",
                body: formData
            });

            const data = await response.json();

            // Clear active timers
            clearInterval(animInterval);
            stepTimers.forEach(clearTimeout);

            if (!response.ok) {
                if (analyzingCard) analyzingCard.classList.add("hidden");
                throw new Error(data.detail || "Verification failed. Check parameters and try again.");
            }

            // Finish radar graphics
            progressVal = 100;
            updateProgressUI(100);
            Object.values(checkItems).forEach(item => {
                if (item) {
                    item.className = "checklist-item done";
                    const icon = item.querySelector(".check-icon");
                    if (icon) icon.innerText = "✓";
                }
            });

            const analyzingTitle = document.getElementById("analyzingTitle");
            if (analyzingTitle) {
                analyzingTitle.innerText = "Consistency Audit Completed! 🎉";
            }
            const analyzingSub = document.getElementById("analyzingSub");
            if (analyzingSub) {
                analyzingSub.innerText = "Analysis done. Scroll down to see the verified details.";
            }

            // Smooth transition delay
            await new Promise(resolve => setTimeout(resolve, 800));

            if (analyzingCard) analyzingCard.classList.add("hidden");

            lastAuditData = data;
            renderDashboard(data);
            
            // Smoothly scroll down to dashboard report
            if (resultsDashboard) {
                resultsDashboard.scrollIntoView({ behavior: "smooth", block: "start" });
            }
            
            resetButtonState();

        } catch (error) {
            console.error(error);
            if (animInterval) clearInterval(animInterval);
            stepTimers.forEach(clearTimeout);
            
            const analyzingCard = document.getElementById("analyzingCard");
            if (analyzingCard) analyzingCard.classList.add("hidden");
            
            showError(error.message);
        }
    });

    function showError(message) {
        if (errorText) errorText.innerText = message;
        if (errorBox) errorBox.classList.remove("hidden");
        if (emptyState) emptyState.classList.remove("hidden");
        resetButtonState();
    }

    function resetButtonState() {
        if (submitBtn) {
            submitBtn.disabled = false;
            const span = submitBtn.querySelector("span");
            if (span) span.innerText = "Analyze Consistency";
        }
        if (spinner) spinner.classList.add("hidden");
    }

    function escapeHtml(text) {
        if (!text) return "";
        return text
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

    function renderDashboard(data) {
        // 1. Render Profile Card
        document.getElementById("profileAvatar").src = data.profile.avatar_url || "https://github.com/identicons/git.png";
        document.getElementById("profileName").innerText = data.profile.name || data.username;
        document.getElementById("profileUsername").innerText = `@${data.username}`;
        document.getElementById("profileBio").innerText = data.profile.bio || "No profile bio available.";
        document.getElementById("scannedReposCount").innerText = data.repositories_scanned;
        document.getElementById("collabPrsCount").innerText = data.collaborative_prs_count;

        // 2. Render Score Card
        const score = data.audit.score;
        const scoreNumberText = document.getElementById("scoreText");
        scoreNumberText.innerText = `${score}%`;
        
        // Update radial progress bar color
        const scoreRadial = document.querySelector(".score-radial");
        let scoreColor = "#ef4444";
        let scoreTitle = "Resume Alignment Needed";
        let scoreDesc = "We couldn't verify many of your resume skills on GitHub. Make sure your coding projects are public, or update your resume to match the libraries you've actually written code for.";

        if (score >= 75) {
            scoreColor = "#10b981";
            scoreTitle = "Strong Portfolio Match";
            scoreDesc = "Awesome! Your public codebases, repositories, and open-source contributions strongly support your resume claims. You're ready to share this report with hiring managers!";
        } else if (score >= 40) {
            scoreColor = "#f59e0b";
            scoreTitle = "Good Progress, Some Gaps";
            scoreDesc = "You have public code evidence for several skills, but some key claims lack sufficient commit history, active projects, or timeline alignment. Consider pushing more repository commits to verify these.";
        }

        scoreRadial.style.background = `radial-gradient(circle, var(--color-score-center) 58%, transparent 59%), conic-gradient(${scoreColor} ${score}%, rgba(255, 255, 255, 0.05) 0%)`;
        scoreNumberText.style.color = scoreColor;
        
        // Restore label styling
        const scoreLabel = document.querySelector(".score-label");
        if (scoreLabel) {
            scoreLabel.style.color = "";
            scoreLabel.style.textShadow = "";
        }

        document.getElementById("scoreTitle").innerText = scoreTitle;
        document.getElementById("scoreDescription").innerText = scoreDesc;

        // 3. Render Buckets
        const verifiedList = document.getElementById("verifiedList");
        const unsupportedList = document.getElementById("unsupportedList");
        const strengthsList = document.getElementById("strengthsList");

        verifiedList.innerHTML = "";
        unsupportedList.innerHTML = "";
        strengthsList.innerHTML = "";

        // verified claims
        if (data.audit.verified_claims.length === 0) {
            verifiedList.innerHTML = `<p class="item-sub">No verified claims found.</p>`;
        } else {
            data.audit.verified_claims.forEach(item => {
                const itemDiv = document.createElement("div");
                itemDiv.className = "audit-item";
                
                let warningHtml = "";
                if (item.timeline_warning) {
                    warningHtml = `
                        <div class="warning-text" style="margin-top: 0.4rem; color: var(--color-warning-text); font-size:0.75rem;">
                            <span>🕒</span>
                            <span>${item.timeline_warning}</span>
                        </div>
                    `;
                }

                itemDiv.innerHTML = `
                    <div class="item-main" style="display:flex; justify-content:space-between; align-items:center;">
                        <div>
                            <span class="item-title" style="font-weight:600;">${item.skill}</span>
                            <span class="item-sub badge-success" style="padding: 0.1rem 0.4rem; border-radius:4px; font-size:0.7rem; margin-left: 0.4rem;">Match: ${item.matched_tech}</span>
                        </div>
                        <span class="accordion-indicator">▼</span>
                    </div>
                    
                    <div class="evidence-score-row">
                        <span class="evidence-score-lbl">Evidence Strength: <strong>${item.evidence_strength}%</strong></span>
                        <div class="evidence-score-bg">
                            <div class="evidence-score-fill" style="width: ${item.evidence_strength}%;"></div>
                        </div>
                    </div>

                    <div class="audit-item-details">
                        <div class="item-meta" style="font-size:0.75rem; color: var(--color-text-sub); display:flex; gap:1rem;">
                            <span>Commits: <strong>${item.total_commits}</strong></span>
                            <span>Active Period: <strong>${item.active_period}</strong></span>
                        </div>
                        <div class="item-meta" style="font-size:0.75rem; color: var(--color-text-sub); margin-top: 0.2rem;">
                            <span>Repositories: <span class="item-repos">${item.repos.join(", ")}</span></span>
                        </div>
                        ${warningHtml}
                    </div>
                `;
                verifiedList.appendChild(itemDiv);
            });
        }

        // unsupported claims
        if (data.audit.unsupported_claims.length === 0) {
            unsupportedList.innerHTML = `<p class="item-sub">No unsupported claims found.</p>`;
        } else {
            data.audit.unsupported_claims.forEach(item => {
                const itemDiv = document.createElement("div");
                itemDiv.className = "audit-item";
                
                itemDiv.innerHTML = `
                    <div class="item-main">
                        <span class="item-title" style="color: #fda4af; font-weight:600;">${item.skill}</span>
                    </div>
                    <p class="item-sub" style="margin-top: 0.4rem; line-height: 1.3; font-size:0.8rem;">${item.reason}</p>
                `;
                unsupportedList.appendChild(itemDiv);
            });
        }

        // unlisted strengths
        if (data.audit.unlisted_strengths.length === 0) {
            strengthsList.innerHTML = `<p class="item-sub">No unlisted strengths detected.</p>`;
        } else {
            data.audit.unlisted_strengths.forEach(item => {
                const itemDiv = document.createElement("div");
                itemDiv.className = "audit-item";

                itemDiv.innerHTML = `
                    <div class="item-main" style="display:flex; justify-content:space-between; align-items:center;">
                        <div>
                            <span class="item-title" style="color: #93c5fd; font-weight:600;">${item.technology}</span>
                            <span class="item-sub" style="color: var(--color-warning); font-size:0.75rem; margin-left:0.4rem;">★ ${item.stars}</span>
                        </div>
                        <span class="accordion-indicator">▼</span>
                    </div>
                    
                    <div class="evidence-score-row">
                        <span class="evidence-score-lbl">Evidence Strength: <strong>${item.evidence_strength}%</strong></span>
                        <div class="evidence-score-bg">
                            <div class="evidence-score-fill" style="width: ${item.evidence_strength}%;"></div>
                        </div>
                    </div>

                    <div class="audit-item-details">
                        <div class="item-meta" style="font-size:0.75rem; color: var(--color-text-sub); display:flex; gap:1rem;">
                            <span>Commits: <strong>${item.total_commits}</strong></span>
                            <span>Active Period: <strong>${item.active_period}</strong></span>
                        </div>
                        <div class="item-meta" style="font-size:0.75rem; color: var(--color-text-sub); margin-top: 0.2rem;">
                            <span>Repositories: <span class="item-repos">${item.repos.join(", ")}</span></span>
                        </div>
                    </div>
                `;
                strengthsList.appendChild(itemDiv);
            });
        }

        // 4. Render Aggregated Recommendations list
        const recommendationsCard = document.getElementById("recommendationsCard");
        const recommendationsList = document.getElementById("recommendationsList");
        recommendationsList.innerHTML = "";
        
        const gaps = data.audit.unsupported_claims;
        if (gaps.length === 0) {
            recommendationsCard.style.display = "none";
        } else {
            recommendationsCard.style.display = "block";
            gaps.forEach(item => {
                const recDiv = document.createElement("div");
                recDiv.className = "recommendation-item";
                recDiv.innerHTML = `
                    <span class="recommendation-icon">💡</span>
                    <div class="recommendation-content">
                        <h4 style="font-weight:600;">Add code evidence for "${item.skill}"</h4>
                        <p>${item.recommendation || 'Create a public repository containing active commits and configuration files supporting this skill.'}</p>
                    </div>
                `;
                recommendationsList.appendChild(recDiv);
            });
        }

        // 5. Render Quantifiable Claims
        const claimsList = document.getElementById("claimsList");
        claimsList.innerHTML = "";

        if (data.audit.evaluated_claims.length === 0) {
            claimsList.innerHTML = `<p class="item-sub">No quantifiable claims detected in resume bullet points.</p>`;
        } else {
            data.audit.evaluated_claims.forEach(item => {
                const itemDiv = document.createElement("div");
                itemDiv.className = "claim-item";
                
                const isVerified = item.status === "Evidence Found";
                const statusBadgeClass = isVerified ? "status-verified" : "status-unsupported";
                const statusIcon = isVerified ? "✓" : "✗";

                itemDiv.innerHTML = `
                    <div class="claim-header">
                        <span class="claim-text">"${item.claim}"</span>
                        <span class="claim-status ${statusBadgeClass}">${statusIcon} ${item.status}</span>
                    </div>
                    <p class="claim-evidence">${item.evidence}</p>
                `;
                claimsList.appendChild(itemDiv);
            });
        }

        // 6. Setup Accordion Event Handlers if not already configured
        if (!window.accordionHandlerRegistered) {
            document.addEventListener("click", (e) => {
                const item = e.target.closest(".audit-item");
                if (item) {
                    if (e.target.closest("pre") || e.target.closest("code") || e.target.closest("a")) {
                        return;
                    }
                    item.classList.toggle("expanded");
                }
            });
            window.accordionHandlerRegistered = true;
        }

        // Show Dashboard
        resultsDashboard.classList.remove("hidden");
    }

    function roundVal(val) {
        return Math.round(val);
    }


    // Tilt effects removed for card stability

    // Theme toggle switch logic
    const themeSwitch = document.querySelector(".theme-switch");
    if (themeSwitch) {
        // Default to light theme if no theme is stored, or if stored theme is "light"
        if (localStorage.getItem("theme") !== "dark") {
            document.body.classList.add("light-theme");
            themeSwitch.innerText = "🌙";
        } else {
            document.body.classList.remove("light-theme");
            themeSwitch.innerText = "☀️";
        }
        
        themeSwitch.addEventListener("click", () => {
            document.body.classList.toggle("light-theme");
            if (document.body.classList.contains("light-theme")) {
                themeSwitch.innerText = "🌙";
                localStorage.setItem("theme", "light");
            } else {
                themeSwitch.innerText = "☀️";
                localStorage.setItem("theme", "dark");
            }
        });
    }

    // --- Standalone Verified Stamp Download Action ---

    function generateLocalSignature(username, score) {
        const input = `${username}:${score}:2026-gitveritas-secure`;
        let hash = 0;
        for (let i = 0; i < input.length; i++) {
            hash = (hash << 5) - hash + input.charCodeAt(i);
            hash |= 0; // Convert to 32bit integer
        }
        return Math.abs(hash).toString(16).toUpperCase();
    }

    if (downloadVerifiedPageBtn) {
        downloadVerifiedPageBtn.addEventListener("click", () => {
            if (!lastAuditData) {
                alert("Please run a consistency audit scan first.");
                return;
            }

            try {
                const score = lastAuditData.audit.score;
                const scoreColor = document.getElementById("scoreText").style.color || "#10b981";
                const scoreTitle = document.getElementById("scoreTitle").innerText || "Strong Match";
                const scoreDesc = document.getElementById("scoreDescription").innerText || "";
                
                const signature = generateLocalSignature(lastAuditData.username, lastAuditData.audit.score);
                const formattedDate = new Date().toLocaleDateString(undefined, {
                    year: 'numeric', month: 'long', day: 'numeric'
                });

                // Rosette Gear Seal generator
                function getGearPoints(cx, cy, rOuter, rInner, points) {
                    let res = [];
                    let angleStep = Math.PI / points;
                    for (let i = 0; i < points * 2; i++) {
                        let angle = i * angleStep;
                        let r = (i % 2 === 0) ? rOuter : rInner;
                        let x = cx + Math.cos(angle) * r;
                        let y = cy + Math.sin(angle) * r;
                        res.push(`${x.toFixed(1)},${y.toFixed(1)}`);
                    }
                    return res.join(" ");
                }
                const gearPointsStr = getGearPoints(60, 60, 56, 50, 24);

                // Calculate dynamic badge, seal styles, and color palette based on score
                let sealBg = "rgba(16, 185, 129, 0.08)";
                let sealBorder = "rgba(16, 185, 129, 0.35)";
                let sealText = "#10b981";
                let checkBg = "#059669";
                let badgeTitle = "🛡️ GITVERITAS VERIFIED";

                // Seal SVG gradients and styles
                let sealGradStart = "#34d399";
                let sealGradEnd = "#047857";
                let sealStrokeColor = "#10b981";
                let sealTextStroke = "#10b981";
                let sealRibbonDarkColor = "#065f46";
                let badgeLabel = "GREEN VERIFIED";
                let ribbonText = "Audited";

                if (score >= 85) {
                    // Gold Seal
                    sealBg = "rgba(251, 191, 36, 0.08)";
                    sealBorder = "rgba(251, 191, 36, 0.35)";
                    sealText = "#fbbf24";
                    checkBg = "#fbbf24";
                    badgeTitle = "🥇 GITVERITAS GOLD VERIFIED";

                    sealGradStart = "#fbbf24";
                    sealGradEnd = "#d97706";
                    sealStrokeColor = "#fbbf24";
                    sealTextStroke = "#fbbf24";
                    sealRibbonDarkColor = "#b45309";
                    badgeLabel = "GOLD LEVEL";
                    ribbonText = "Excellent";
                } else if (score >= 70) {
                    // Silver Seal (Green in UI to match user screenshot at 83%)
                    sealBg = "rgba(16, 185, 129, 0.08)";
                    sealBorder = "rgba(16, 185, 129, 0.35)";
                    sealText = "#10b981";
                    checkBg = "#059669";
                    badgeTitle = "🥈 GITVERITAS SILVER VERIFIED";

                    sealGradStart = "#cbd5e1";
                    sealGradEnd = "#64748b";
                    sealStrokeColor = "#cbd5e1";
                    sealTextStroke = "#cbd5e1";
                    sealRibbonDarkColor = "#475569";
                    badgeLabel = "SILVER LEVEL";
                    ribbonText = "Credible";
                } else if (score >= 40) {
                    // Bronze Seal
                    sealBg = "rgba(217, 119, 6, 0.08)";
                    sealBorder = "rgba(217, 119, 6, 0.35)";
                    sealText = "#f59e0b";
                    checkBg = "#d97706";
                    badgeTitle = "🥉 GITVERITAS BRONZE VERIFIED";

                    sealGradStart = "#f59e0b";
                    sealGradEnd = "#78350f";
                    sealStrokeColor = "#d97706";
                    sealTextStroke = "#d97706";
                    sealRibbonDarkColor = "#78350f";
                    badgeLabel = "BRONZE LEVEL";
                    ribbonText = "Verified";
                }

                const rosetteSealSvg = `
                <svg width="110" height="110" viewBox="0 0 120 120" style="position: absolute; top: 1.5rem; right: 2rem; transform: rotate(-5deg); filter: drop-shadow(0 4px 8px rgba(0,0,0,0.25)); z-index: 10;">
                    <!-- Rosette Gear Points -->
                    <polygon points="${gearPointsStr}" fill="url(#sealPrimaryGrad)" stroke="${sealStrokeColor}" stroke-width="1.5" />
                    
                    <!-- Outer Dark Ring -->
                    <circle cx="60" cy="60" r="44" fill="#0f0717" stroke="${sealStrokeColor}" stroke-width="1.5" />
                    
                    <!-- Inner Dash Ring -->
                    <circle cx="60" cy="60" r="39" fill="none" stroke="${sealStrokeColor}" stroke-width="0.8" stroke-dasharray="2 1" />
                    
                    <!-- Curved Text Paths -->
                    <path id="topTextArc" d="M 28 60 A 32 32 0 0 1 92 60" fill="none" />
                    <path id="bottomTextArc" d="M 92 60 A 32 32 0 0 1 28 60" fill="none" />
                    
                    <text fill="${sealTextStroke}" font-family="sans-serif" font-size="6.2" font-weight="700" letter-spacing="1.2">
                        <textPath href="#topTextArc" startOffset="50%" text-anchor="middle">GITVERITAS</textPath>
                    </text>
                    
                    <text fill="${sealTextStroke}" font-family="sans-serif" font-size="6.2" font-weight="700" letter-spacing="1.2">
                        <textPath href="#bottomTextArc" startOffset="50%" text-anchor="middle">${badgeLabel}</textPath>
                    </text>
                    
                    <!-- Stars -->
                    <text x="60" y="47" fill="${sealTextStroke}" font-size="5" text-anchor="middle">★ ★ ★</text>
                    <text x="60" y="79" fill="${sealTextStroke}" font-size="5" text-anchor="middle">★ ★ ★</text>
                    
                    <!-- Ribbon Banner Tabs (Back layer) -->
                    <path d="M 12 60 L 5 54 L 15 48 Z" fill="${sealRibbonDarkColor}" />
                    <path d="M 108 60 L 115 54 L 105 48 Z" fill="${sealRibbonDarkColor}" />
                    
                    <!-- Ribbon Banner Front -->
                    <path d="M 14 54 Q 60 50 106 54 L 104 66 Q 60 62 16 66 Z" fill="url(#sealPrimaryGrad)" />
                    
                    <!-- Ribbon Text -->
                    <text x="60" y="62.5" fill="#ffffff" font-family="'Playfair Display', serif" font-size="8.5" font-weight="700" text-anchor="middle" style="letter-spacing: 0.5px;">${ribbonText}</text>
                    
                    <!-- Gradients -->
                    <defs>
                        <linearGradient id="sealPrimaryGrad" x1="0" y1="0" x2="120" y2="120" gradientUnits="userSpaceOnUse">
                            <stop stop-color="${sealGradStart}"/>
                            <stop offset="1" stop-color="${sealGradEnd}"/>
                        </linearGradient>
                    </defs>
                </svg>`;

                // Generate printable popup window targeting PDF download
                const printWindow = window.open('', '_blank');
                if (!printWindow) {
                    alert("Pop-up blocker active! Please allow pop-ups to download the PDF certificate.");
                    return;
                }

                printWindow.document.write(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>GitVeritas Certificate - @${lastAuditData.username}</title>
    <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@600;700&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
    <style>
        body {
            font-family: 'Inter', sans-serif;
            background: #090412;
            color: #f3f1f6;
            padding: 3rem;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
            box-sizing: border-box;
            margin: 0;
        }
        .certificate-card {
            background: #140a1e;
            border-radius: 24px;
            padding: 3.5rem;
            max-width: 680px;
            width: 100%;
            border: 2px solid rgba(192, 132, 252, 0.3);
            box-shadow: 0 15px 45px rgba(0, 0, 0, 0.5);
            display: flex;
            flex-direction: column;
            gap: 2rem;
            box-sizing: border-box;
            position: relative;
        }
        .header-section {
            display: flex;
            align-items: center;
            gap: 2rem;
            text-align: left;
            width: 100%;
        }
        .avatar {
            width: 96px;
            height: 96px;
            border-radius: 50%;
            border: 2px solid rgba(192, 132, 252, 0.4);
            box-shadow: 0 4px 15px rgba(0, 0, 0, 0.3);
            object-fit: cover;
        }
        .header-text {
            flex: 1;
            padding-right: 120px;
        }
        .header-text h2 {
            margin: 0;
            font-family: 'Playfair Display', serif;
            font-size: 1.8rem;
            font-weight: 700;
            color: #ffffff;
        }
        .header-text p.username {
            margin: 0.2rem 0 0.4rem 0;
            font-size: 0.9rem;
            color: #c084fc;
            font-family: monospace;
            font-weight: 500;
        }
        .header-text p.bio {
            margin: 0;
            font-size: 0.85rem;
            color: #b4a8c2;
            line-height: 1.4;
        }
        .separator {
            border: 0;
            border-top: 1px solid rgba(255, 255, 255, 0.08);
            margin: 0;
            width: 100%;
        }
        .mid-section {
            display: flex;
            flex-direction: column;
            gap: 1.8rem;
            width: 100%;
            box-sizing: border-box;
        }
        .stats-col {
            display: flex;
            gap: 4rem;
            text-align: left;
        }
        .stat-item {
            display: flex;
            flex-direction: column;
            gap: 0.15rem;
        }
        .stat-num {
            font-size: 2.2rem;
            font-weight: 700;
            color: #ffffff;
            line-height: 1.1;
        }
        .stat-lbl {
            font-size: 0.72rem;
            font-weight: 700;
            color: #b4a8c2;
            letter-spacing: 0.05em;
        }
        .progress-box {
            background: rgba(255, 255, 255, 0.03);
            border: 1px dashed rgba(255, 255, 255, 0.08);
            border-radius: 16px;
            padding: 1.5rem;
            display: flex;
            align-items: center;
            gap: 1.5rem;
            box-sizing: border-box;
            text-align: left;
            width: 100%;
        }
        .radial-circle {
            width: 64px;
            height: 64px;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            flex-shrink: 0;
        }
        .progress-info h4 {
            margin: 0;
            font-size: 0.95rem;
            color: #ffffff;
            font-weight: 600;
        }
        .progress-info p {
            margin: 0.2rem 0 0 0;
            font-size: 0.74rem;
            color: #b4a8c2;
            line-height: 1.4;
        }
        .verified-box {
            display: flex;
            align-items: center;
            gap: 1.2rem;
            border-radius: 14px;
            padding: 1.2rem 1.4rem;
            width: 100%;
            box-sizing: border-box;
            text-align: left;
        }
        .check-circle {
            width: 40px;
            height: 40px;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            flex-shrink: 0;
        }
        .verified-details {
            display: flex;
            flex-direction: column;
        }
        .verified-title {
            font-weight: 700;
            font-size: 0.85rem;
            letter-spacing: 0.08em;
            text-transform: uppercase;
            margin: 0;
            display: flex;
            align-items: center;
            gap: 0.35rem;
        }
        .verified-candidate {
            margin: 0.2rem 0 0 0;
            font-size: 0.76rem;
            color: #cbd5e1;
        }
        .verified-score-date {
            margin: 0.15rem 0 0 0;
            font-size: 0.74rem;
            font-weight: 500;
        }
        .verified-hash {
            margin: 0.2rem 0 0 0;
            font-size: 0.65rem;
            color: #94a3b8;
            font-family: monospace;
        }
        
        @media print {
            body {
                background: #090412 !important;
                color: #f3f1f6 !important;
                -webkit-print-color-adjust: exact;
                print-color-adjust: exact;
            }
            .certificate-card {
                border: 2px solid rgba(192, 132, 252, 0.3) !important;
                background: #140a1e !important;
                box-shadow: none !important;
            }
        }
    </style>
</head>
<body>
    <div class="certificate-card">
        <!-- Dynamic Rosette Stamp Seal in New Place -->
        ${rosetteSealSvg}

        <!-- Header: Avatar + Bio -->
        <div class="header-section">
            <img class="avatar" src="${lastAuditData.profile.avatar_url || 'https://github.com/identicons/git.png'}" alt="Avatar">
            <div class="header-text">
                <h2>${lastAuditData.profile.name || lastAuditData.username}</h2>
                <p class="username">@${lastAuditData.username}</p>
                <p class="bio">${lastAuditData.profile.bio || '🌸 Coding in pastel and building dreams in pixels. 🌸'}</p>
            </div>
        </div>
        
        <hr class="separator">
        
        <!-- Mid Section: Stats & Portfolio Match -->
        <div class="mid-section">
            <div class="stats-col">
                <div class="stat-item">
                    <span class="stat-num">${lastAuditData.repositories_scanned}</span>
                    <span class="stat-lbl">SCANNED REPOS</span>
                </div>
                <div class="stat-item">
                    <span class="stat-num">${lastAuditData.collaborative_prs_count}</span>
                    <span class="stat-lbl">COLLABORATIVE PRS</span>
                </div>
            </div>
            
            <div class="progress-box">
                <!-- Non-overlapping circular pie chart with pointer dot in center -->
                <div class="radial-circle" style="background: radial-gradient(circle, #140a1e 12%, transparent 13%), conic-gradient(${scoreColor} ${score}%, rgba(255, 255, 255, 0.08) 0%);"></div>
                <div class="progress-info">
                    <h4>${scoreTitle}</h4>
                    <p>Evidence verifies developer credibility alignment.</p>
                </div>
            </div>
        </div>

        <!-- Verified Box -->
        <div class="verified-box" style="background: ${sealBg}; border: 1.5px solid ${sealBorder};">
            <div class="check-circle" style="background: ${checkBg};">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M20 6L9 17L4 12" stroke="white" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
            </div>
            <div class="verified-details">
                <h4 class="verified-title" style="color: ${sealText};">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="fill: #3b82f6; vertical-align: middle; margin-right: 0.1rem;">
                        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
                    </svg>
                    ${badgeTitle.replace('🛡️', '').trim()}
                </h4>
                <p class="verified-candidate">Candidate: @${lastAuditData.username}</p>
                <p class="verified-score-date" style="color: ${sealText};">Score: ${score}% | Date: ${formattedDate}</p>
                <p class="verified-hash">Verify Hash: GV-${signature}</p>
            </div>
        </div>
    </div>

    <script>
        window.onload = function() {
            setTimeout(() => {
                window.print();
                setTimeout(() => { window.close(); }, 500);
            }, 300);
        };
    </script>
</body>
</html>`);
                printWindow.document.close();

            } catch (err) {
                console.error(err);
                alert("Failed to download PDF report: " + err.message);
            }
        });
    }
});
