const socket = io();

// DOM elements
const stateLabel = document.getElementById("state-label");
const statusDot = document.getElementById("status-dot");
const participantCount = document.getElementById("participant-count");
const keywordDisplay = document.getElementById("keyword-display");
const participantBody = document.getElementById("participant-body");
const emptyParticipants = document.getElementById("empty-participants");
const winnerDisplay = document.getElementById("winner-display");
const winnerName = document.getElementById("winner-name");
const winnerDetails = document.getElementById("winner-details");
const channelsBar = document.getElementById("channels-bar");

const btnStart = document.getElementById("btn-start");
const btnStop = document.getElementById("btn-stop");
const btnDraw = document.getElementById("btn-draw");
const btnReset = document.getElementById("btn-reset");

const inputTwitchEnabled = document.getElementById("input-twitch-enabled");
const inputTwitchChannel = document.getElementById("input-twitch-channel");
const inputKickEnabled = document.getElementById("input-kick-enabled");
const inputKickChannel = document.getElementById("input-kick-channel");

const inputKeyword = document.getElementById("input-keyword");
const inputAllowNonSubs = document.getElementById("input-allow-non-subs");
const inputNonSubWeight = document.getElementById("input-non-sub-weight");
const inputSubWeightMode = document.getElementById("input-sub-weight-mode");
const inputSubConstantWeight = document.getElementById("input-sub-constant-weight");
const constantWeightField = document.getElementById("constant-weight-field");
const inputLogMultiplier = document.getElementById("input-log-multiplier");
const logMultiplierField = document.getElementById("log-multiplier-field");
const inputLinearMultiplier = document.getElementById("input-linear-multiplier");
const linearMultiplierField = document.getElementById("linear-multiplier-field");
const weightPreview = document.getElementById("weight-preview");
const btnSaveConfig = document.getElementById("btn-save-config");

// Reel elements
const cpReelWrapper = document.getElementById("cp-reel-wrapper");
const cpReelContainer = document.getElementById("cp-reel-container");
const cpReelStrip = document.getElementById("cp-reel-strip");

// Settings toggle
const settingsToggle = document.getElementById("settings-toggle");
const settingsContent = document.getElementById("settings-content");

settingsToggle.addEventListener("click", () => {
    settingsToggle.classList.toggle("open");
    settingsContent.classList.toggle("open");
    // Redraw chart when opening (canvas may have been hidden)
    if (settingsContent.classList.contains("open")) {
        setTimeout(drawWeightChart, 50);
    }
});

// State
let currentState = "IDLE";
let count = 0;
let reelTimeout = null;

// --- Reel animation (CS2-style) ---
const REEL_CARD_W = 140;
const REEL_TOTAL = 55;
const REEL_DURATION = 6000;
function randomRarity() {
    const r = Math.random() * 100;
    if (r < 79.92) return "rarity-blue";
    if (r < 79.92 + 15.98) return "rarity-purple";
    if (r < 79.92 + 15.98 + 3.20) return "rarity-pink";
    return "rarity-red";
}

function buildCpReel(allNames, winnerName) {
    cpReelStrip.innerHTML = "";
    const winnerPos = 38 + Math.floor(Math.random() * 12);
    const pool = allNames.filter(n => n !== winnerName);
    if (pool.length === 0) pool.push(winnerName);

    for (let i = 0; i < REEL_TOTAL; i++) {
        const el = document.createElement("div");
        if (i === winnerPos) {
            el.className = "cp-reel-card rarity-gold";
            el.textContent = winnerName;
            el.dataset.winner = "1";
        } else {
            el.className = "cp-reel-card " + randomRarity();
            el.textContent = pool[Math.floor(Math.random() * pool.length)];
        }
        cpReelStrip.appendChild(el);
    }
    return winnerPos;
}

function spinCpReel(allNames, winner, callback) {
    if (reelTimeout) { clearTimeout(reelTimeout); reelTimeout = null; }

    winnerName.style.display = "none";
    winnerDetails.style.display = "none";
    cpReelWrapper.classList.remove("fade-out");
    cpReelWrapper.classList.add("active");
    winnerDisplay.classList.add("visible");

    const winnerPos = buildCpReel(allNames, winner.display_name);
    const containerW = cpReelContainer.offsetWidth;
    const target = -(winnerPos * REEL_CARD_W) + (containerW / 2) - (REEL_CARD_W / 2);
    const jitter = (Math.random() - 0.5) * (REEL_CARD_W * 0.35);

    cpReelStrip.style.transition = "none";
    cpReelStrip.style.transform = `translateX(${containerW + 200}px)`;

    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            cpReelStrip.style.transition = `transform ${REEL_DURATION}ms cubic-bezier(0.12, 0.68, 0.18, 1)`;
            cpReelStrip.style.transform = `translateX(${target + jitter}px)`;
        });
    });

    reelTimeout = setTimeout(() => {
        const wCard = cpReelStrip.querySelector('[data-winner="1"]');
        if (wCard) wCard.classList.add("winner-reveal");

        reelTimeout = setTimeout(() => {
            cpReelWrapper.classList.add("fade-out");
            reelTimeout = setTimeout(() => {
                cpReelWrapper.classList.remove("active", "fade-out");
                if (callback) callback();
            }, 600);
        }, 1500);
    }, REEL_DURATION + 150);
}

// --- Channel tags ---
function renderChannels(cfg) {
    channelsBar.innerHTML = "";

    if (cfg.twitch_enabled && cfg.twitch_channel) {
        const connected = cfg.twitch_connected !== false;
        channelsBar.innerHTML += `
            <div class="channel-tag twitch">
                <span class="dot ${connected ? "" : "off"}"></span>
                <span class="platform">TWITCH</span>
                <span>${escapeHtml(cfg.twitch_channel)}</span>
            </div>`;
    }
    if (cfg.kick_enabled && cfg.kick_channel_slug) {
        const connected = cfg.kick_connected !== false;
        channelsBar.innerHTML += `
            <div class="channel-tag kick">
                <span class="dot ${connected ? "" : "off"}"></span>
                <span class="platform">KICK</span>
                <span>${escapeHtml(cfg.kick_channel_slug)}</span>
            </div>`;
    }
    if (channelsBar.innerHTML === "") {
        channelsBar.innerHTML = `<div class="channel-tag none">No channels configured</div>`;
    }
}

// --- Keyword display ---
function updateKeywordDisplay(keyword) {
    const kw = keyword ? keyword.trim() : "";
    if (kw) {
        keywordDisplay.textContent = kw;
        keywordDisplay.classList.remove("empty");
    } else {
        keywordDisplay.textContent = "all messages";
        keywordDisplay.classList.add("empty");
    }
}

// --- Weight mode UI ---
function updateWeightModeUI() {
    const mode = inputSubWeightMode.value;
    constantWeightField.style.display = mode === "constant" ? "" : "none";
    logMultiplierField.style.display = mode === "logarithmic" ? "" : "none";
    linearMultiplierField.style.display = mode === "linear" ? "" : "none";
    updateWeightPreview();
}

function updateWeightPreview() {
    const mode = inputSubWeightMode.value;
    const nonSub = parseFloat(inputNonSubWeight.value) || 1.0;
    const constW = parseFloat(inputSubConstantWeight.value) || 2.0;
    const logMul = parseFloat(inputLogMultiplier.value) || 1.0;
    const linMul = parseFloat(inputLinearMultiplier.value) || 1.0;

    const examples = [1, 3, 6, 12, 24, 48];
    let lines = [];

    for (const m of examples) {
        let w;
        if (mode === "logarithmic") w = 1.0 + logMul * Math.log2(m + 1);
        else if (mode === "linear") w = 1.0 + linMul * m;
        else w = constW;
        lines.push(`${m}mo\u00a0=\u00a0${w.toFixed(1)}x`);
    }

    const modeLabels = { logarithmic: "Logarithmic", linear: "Linear", constant: "Constant" };
    weightPreview.innerHTML =
        `<strong>${modeLabels[mode]}</strong> &mdash; Non-sub: ${nonSub.toFixed(1)}x &nbsp;| Sub: ${lines.join(" | ")}`;

    drawWeightChart();
}

// --- Weight chart ---
const weightChart = document.getElementById("weight-chart");
const chartCtx = weightChart.getContext("2d");

function drawWeightChart() {
    const mode = inputSubWeightMode.value;
    const nonSub = parseFloat(inputNonSubWeight.value) || 1.0;
    const constW = parseFloat(inputSubConstantWeight.value) || 2.0;
    const logMul = parseFloat(inputLogMultiplier.value) || 1.0;
    const linMul = parseFloat(inputLinearMultiplier.value) || 1.0;

    const maxMonths = 60;
    const points = [];
    let maxW = nonSub;

    for (let m = 0; m <= maxMonths; m++) {
        let w;
        if (mode === "logarithmic") w = 1.0 + logMul * Math.log2(m + 1);
        else if (mode === "linear") w = 1.0 + linMul * m;
        else w = constW;
        points.push({ m, w });
        if (w > maxW) maxW = w;
    }

    const dpr = window.devicePixelRatio || 1;
    const rect = weightChart.getBoundingClientRect();
    if (rect.width === 0) return; // hidden
    weightChart.width = rect.width * dpr;
    weightChart.height = rect.height * dpr;
    chartCtx.scale(dpr, dpr);

    const W = rect.width;
    const H = rect.height;
    const pad = { top: 16, right: 16, bottom: 28, left: 40 };
    const plotW = W - pad.left - pad.right;
    const plotH = H - pad.top - pad.bottom;

    chartCtx.clearRect(0, 0, W, H);

    const yMax = Math.ceil(maxW * 1.15);
    const yStep = yMax <= 5 ? 1 : yMax <= 15 ? 2 : yMax <= 30 ? 5 : 10;

    // Grid lines & Y labels
    chartCtx.strokeStyle = "rgba(255,255,255,0.05)";
    chartCtx.fillStyle = "rgba(255,255,255,0.3)";
    chartCtx.font = "11px Inter, system-ui";
    chartCtx.textAlign = "right";
    chartCtx.textBaseline = "middle";

    for (let v = 0; v <= yMax; v += yStep) {
        const y = pad.top + plotH - (v / yMax) * plotH;
        chartCtx.beginPath();
        chartCtx.moveTo(pad.left, y);
        chartCtx.lineTo(pad.left + plotW, y);
        chartCtx.stroke();
        chartCtx.fillText(v.toFixed(v % 1 ? 1 : 0) + "x", pad.left - 6, y);
    }

    // X labels
    chartCtx.textAlign = "center";
    chartCtx.textBaseline = "top";
    const xLabels = [0, 6, 12, 24, 36, 48, 60];
    for (const m of xLabels) {
        const x = pad.left + (m / maxMonths) * plotW;
        chartCtx.fillText(m + "mo", x, pad.top + plotH + 8);
    }

    // Non-sub line
    const nonSubY = pad.top + plotH - (nonSub / yMax) * plotH;
    chartCtx.strokeStyle = "rgba(255,255,255,0.12)";
    chartCtx.setLineDash([4, 4]);
    chartCtx.beginPath();
    chartCtx.moveTo(pad.left, nonSubY);
    chartCtx.lineTo(pad.left + plotW, nonSubY);
    chartCtx.stroke();
    chartCtx.setLineDash([]);

    chartCtx.fillStyle = "rgba(255,255,255,0.25)";
    chartCtx.textAlign = "left";
    chartCtx.textBaseline = "bottom";
    chartCtx.fillText("non-sub " + nonSub.toFixed(1) + "x", pad.left + 4, nonSubY - 3);

    // Sub weight curve
    chartCtx.beginPath();
    for (let i = 0; i < points.length; i++) {
        const x = pad.left + (points[i].m / maxMonths) * plotW;
        const y = pad.top + plotH - (points[i].w / yMax) * plotH;
        if (i === 0) chartCtx.moveTo(x, y);
        else chartCtx.lineTo(x, y);
    }
    chartCtx.strokeStyle = "#7c5cfc";
    chartCtx.lineWidth = 2.5;
    chartCtx.stroke();
    chartCtx.lineWidth = 1;

    // Fill under curve
    const lastPt = points[points.length - 1];
    chartCtx.lineTo(pad.left + (lastPt.m / maxMonths) * plotW, pad.top + plotH);
    chartCtx.lineTo(pad.left, pad.top + plotH);
    chartCtx.closePath();
    const grad = chartCtx.createLinearGradient(0, pad.top, 0, pad.top + plotH);
    grad.addColorStop(0, "rgba(124,92,252,0.25)");
    grad.addColorStop(1, "rgba(124,92,252,0.02)");
    chartCtx.fillStyle = grad;
    chartCtx.fill();

    // Dots at key months
    const dotMonths = [1, 3, 6, 12, 24, 48];
    chartCtx.fillStyle = "#7c5cfc";
    for (const dm of dotMonths) {
        const pt = points[dm];
        if (!pt) continue;
        const x = pad.left + (pt.m / maxMonths) * plotW;
        const y = pad.top + plotH - (pt.w / yMax) * plotH;
        chartCtx.beginPath();
        chartCtx.arc(x, y, 3.5, 0, Math.PI * 2);
        chartCtx.fill();
    }
}

inputSubWeightMode.addEventListener("change", updateWeightModeUI);
inputNonSubWeight.addEventListener("input", updateWeightPreview);
inputSubConstantWeight.addEventListener("input", updateWeightPreview);
inputLogMultiplier.addEventListener("input", updateWeightPreview);
inputLinearMultiplier.addEventListener("input", updateWeightPreview);

// --- UI updates ---
function updateUI(state, keyword) {
    currentState = state;
    stateLabel.textContent = state;
    stateLabel.className = "state-badge " + state.toLowerCase();
    statusDot.className = "status-dot " + state.toLowerCase();

    if (keyword !== undefined) updateKeywordDisplay(keyword);

    btnStart.disabled = state !== "IDLE";
    btnStop.disabled = state !== "OPEN";
    btnDraw.disabled = !(state === "OPEN" || state === "CLOSED" || state === "DRAWN");
    btnReset.disabled = state === "IDLE";

    btnDraw.textContent = state === "DRAWN" ? "Redraw" : "Draw";

    if (state === "IDLE") {
        participantBody.innerHTML = "";
        winnerDisplay.classList.remove("visible");
        count = 0;
        participantCount.textContent = "0";
        updateEmptyState();
    }
}

function updateEmptyState() {
    if (emptyParticipants) {
        emptyParticipants.style.display = participantBody.children.length === 0 ? "" : "none";
    }
}

function addParticipantRow(p) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
        <td><span class="platform-badge ${p.platform}">${p.platform}</span></td>
        <td>${escapeHtml(p.display_name)}</td>
        <td>${p.is_subscriber ? p.sub_months + "m" : "-"}</td>
        <td>${Number(p.weight).toFixed(1)}</td>
    `;
    participantBody.prepend(tr);
    updateEmptyState();
}

function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
}

// Socket.IO events
socket.on("state_changed", (data) => {
    updateUI(data.state, data.keyword);
    if (data.count !== undefined) {
        count = data.count;
        participantCount.textContent = count;
    }
});

socket.on("participant_added", (data) => {
    count = data.count;
    participantCount.textContent = count;
    addParticipantRow(data.participant);
});

socket.on("winner_drawn", (data) => {
    const w = data.winner;
    const names = data.reel_names || [w.display_name];
    const detailsText =
        `${w.platform.toUpperCase()} | ` +
        (w.is_subscriber ? `Sub ${w.sub_months}mo | ` : "Non-sub | ") +
        `Weight: ${Number(w.weight).toFixed(1)} | ` +
        `${data.total_participants} eligible | ` +
        `Draw #${data.drawn_count}` +
        (data.eligible_remaining > 0 ? ` | ${data.eligible_remaining} left` : "");

    btnDraw.disabled = true;

    spinCpReel(names, w, () => {
        winnerName.textContent = w.display_name;
        winnerDetails.textContent = detailsText;
        winnerName.style.display = "";
        winnerDetails.style.display = "";
        btnDraw.disabled = false;
        btnDraw.textContent = data.eligible_remaining > 0 ? "Redraw" : "Draw";
    });
});

// Button handlers
btnStart.addEventListener("click", async () => {
    const keyword = inputKeyword.value.trim() || undefined;
    const body = keyword ? JSON.stringify({ keyword }) : "{}";
    await fetch("/api/giveaway/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
    });
});

btnStop.addEventListener("click", () => fetch("/api/giveaway/stop", { method: "POST" }));
btnDraw.addEventListener("click", () => fetch("/api/giveaway/draw", { method: "POST" }));
btnReset.addEventListener("click", () => fetch("/api/giveaway/reset", { method: "POST" }));

btnSaveConfig.addEventListener("click", async () => {
    const keyword = inputKeyword.value.trim();
    const resp = await fetch("/api/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            twitch_enabled: inputTwitchEnabled.checked,
            twitch_channel: inputTwitchChannel.value.trim(),
            kick_enabled: inputKickEnabled.checked,
            kick_channel_slug: inputKickChannel.value.trim(),
            keyword: keyword,
            allow_non_subs: inputAllowNonSubs.value === "true",
            non_sub_weight: parseFloat(inputNonSubWeight.value) || 1.0,
            sub_weight_mode: inputSubWeightMode.value,
            sub_constant_weight: parseFloat(inputSubConstantWeight.value) || 2.0,
            sub_log_multiplier: parseFloat(inputLogMultiplier.value) || 1.0,
            sub_linear_multiplier: parseFloat(inputLinearMultiplier.value) || 1.0,
        }),
    });
    const result = await resp.json();

    // Update keyword display immediately
    updateKeywordDisplay(keyword);

    btnSaveConfig.textContent = "Saved!";
    btnSaveConfig.classList.add("saved");
    setTimeout(() => {
        btnSaveConfig.textContent = "Save Settings";
        btnSaveConfig.classList.remove("saved");
    }, 1500);

    // Show reconnecting hint if channels changed
    const channelsHint = document.getElementById("channels-hint");
    if (result.reconnected) {
        channelsHint.style.display = "";
        setTimeout(() => { channelsHint.style.display = "none"; }, 3000);
    }

    // Refresh channel bar
    const cfgResp = await fetch("/api/config");
    const cfg = await cfgResp.json();
    renderChannels(cfg);
});

// Load initial config
(async () => {
    const resp = await fetch("/api/config");
    const cfg = await resp.json();

    inputTwitchEnabled.checked = cfg.twitch_enabled;
    inputTwitchChannel.value = cfg.twitch_channel || "";
    inputKickEnabled.checked = cfg.kick_enabled;
    inputKickChannel.value = cfg.kick_channel_slug || "";

    inputKeyword.value = cfg.keyword || "";
    inputAllowNonSubs.value = cfg.allow_non_subs ? "true" : "false";
    inputNonSubWeight.value = cfg.non_sub_weight ?? 1.0;
    inputSubWeightMode.value = cfg.sub_weight_mode || "logarithmic";
    inputSubConstantWeight.value = cfg.sub_constant_weight ?? 2.0;
    inputLogMultiplier.value = cfg.sub_log_multiplier ?? 1.0;
    inputLinearMultiplier.value = cfg.sub_linear_multiplier ?? 1.0;

    renderChannels(cfg);
    updateWeightModeUI();

    const status = await (await fetch("/api/status")).json();
    updateUI(status.state, status.keyword);
    participantCount.textContent = status.participant_count;
    count = status.participant_count;
})();
