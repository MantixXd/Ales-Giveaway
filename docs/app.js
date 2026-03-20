// ============================================================
// Giveaway Tool — fully client-side (no backend needed)
// ============================================================

// ---- Config (localStorage) ----
const DEFAULT_CONFIG = {
    twitch_enabled: true,
    twitch_channel: "",
    kick_enabled: false,
    kick_channel_slug: "",
    kick_chatroom_id: null,
    keyword: "!giveaway",
    allow_non_subs: true,
    non_sub_weight: 1.0,
    sub_weight_mode: "logarithmic",
    sub_constant_weight: 2.0,
    sub_log_multiplier: 1.0,
    sub_linear_multiplier: 1.0,
};

function loadConfig() {
    try {
        const raw = localStorage.getItem("giveaway_config");
        if (raw) return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
    } catch (_) {}
    return { ...DEFAULT_CONFIG };
}

function saveConfig(cfg) {
    localStorage.setItem("giveaway_config", JSON.stringify(cfg));
}

// ---- Weight calculation ----
function calculateWeight(isSubscriber, subMonths, cfg) {
    if (!isSubscriber) return cfg.non_sub_weight;
    const mode = cfg.sub_weight_mode;
    if (mode === "linear") return 1.0 + (cfg.sub_linear_multiplier || 1.0) * subMonths;
    if (mode === "constant") return cfg.sub_constant_weight || 2.0;
    // logarithmic (default)
    return 1.0 + (cfg.sub_log_multiplier || 1.0) * Math.log2(subMonths + 1);
}

// ---- Giveaway Engine ----
class GiveawayEngine {
    constructor() {
        this.state = "IDLE";
        this.keyword = "!giveaway";
        this.participants = new Map(); // "platform:userId" -> participant obj
        this.drawnWinners = new Set();
        this.config = loadConfig();

        // Callbacks (set by UI)
        this.onStateChanged = null;
        this.onParticipantAdded = null;
        this.onWinnerDrawn = null;
    }

    start(keyword) {
        if (this.state !== "IDLE") return { error: "Cannot start: " + this.state };
        if (keyword !== undefined) this.keyword = keyword;
        this.participants.clear();
        this.drawnWinners.clear();
        this.state = "OPEN";
        this._fire("state", { state: this.state, keyword: this.keyword });
        return { state: this.state, keyword: this.keyword };
    }

    stopEntries() {
        if (this.state !== "OPEN") return { error: "Cannot stop: " + this.state };
        this.state = "CLOSED";
        this._fire("state", { state: this.state, count: this.participants.size });
        return { state: this.state, count: this.participants.size };
    }

    drawWinner() {
        if (!["OPEN", "CLOSED", "DRAWN"].includes(this.state))
            return { error: "Cannot draw: " + this.state };

        // Filter out already-drawn winners
        const eligible = [];
        for (const [key, p] of this.participants) {
            if (!this.drawnWinners.has(key)) eligible.push(p);
        }
        if (eligible.length === 0) return { error: "No eligible participants left" };

        const weights = eligible.map(p => p.weight);
        const totalWeight = weights.reduce((a, b) => a + b, 0);

        // Weighted random selection
        let r = Math.random() * totalWeight;
        let winner = eligible[eligible.length - 1];
        for (let i = 0; i < eligible.length; i++) {
            r -= weights[i];
            if (r <= 0) { winner = eligible[i]; break; }
        }

        this.drawnWinners.add(winner.platform + ":" + winner.user_id);
        this.state = "DRAWN";

        const allNames = Array.from(this.participants.values()).map(p => p.display_name);
        const result = {
            winner,
            total_participants: eligible.length,
            total_weight: totalWeight,
            reel_names: allNames,
            drawn_count: this.drawnWinners.size,
            eligible_remaining: eligible.length - 1,
        };

        if (this.onWinnerDrawn) this.onWinnerDrawn(result);
        this._fire("state", {
            state: this.state,
            drawn_count: this.drawnWinners.size,
            eligible_remaining: eligible.length - 1,
        });
        return result;
    }

    reset() {
        this.state = "IDLE";
        this.participants.clear();
        this.drawnWinners.clear();
        this._fire("state", { state: this.state });
        return { state: this.state };
    }

    handleChatMessage(entry) {
        if (this.state !== "OPEN") return;

        // Keyword filter (empty = all messages)
        const kw = this.keyword.trim();
        if (kw && !entry.message.toLowerCase().includes(kw.toLowerCase())) return;

        const key = entry.platform + ":" + entry.user_id;
        if (this.participants.has(key)) return; // duplicate

        if (!entry.is_subscriber && !this.config.allow_non_subs) return;

        const weight = calculateWeight(entry.is_subscriber, entry.sub_months, this.config);
        const participant = { ...entry, weight };
        this.participants.set(key, participant);

        if (this.onParticipantAdded) {
            this.onParticipantAdded(participant, this.participants.size);
        }
    }

    _fire(type, data) {
        if (type === "state" && this.onStateChanged) this.onStateChanged(data);
    }
}

// ---- Twitch Connector (browser WebSocket) ----
class TwitchConnector {
    constructor() {
        this.ws = null;
        this.running = false;
        this.channel = "";
        this.onMessage = null; // callback(entry)
        this.onStatus = null;  // callback(connected: bool)
        this._reconnectTimer = null;
    }

    connect(channel) {
        this.channel = channel.toLowerCase().replace(/^#/, "");
        this.running = true;
        this._doConnect();
    }

    disconnect() {
        this.running = false;
        if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
        if (this.ws) { this.ws.close(); this.ws = null; }
        if (this.onStatus) this.onStatus(false);
    }

    _doConnect() {
        if (!this.running) return;
        try {
            this.ws = new WebSocket("wss://irc-ws.chat.twitch.tv:443");
        } catch (e) {
            this._scheduleReconnect();
            return;
        }

        this.ws.onopen = () => {
            const nick = "justinfan" + Math.floor(1000 + Math.random() * 9000);
            this.ws.send("CAP REQ :twitch.tv/tags twitch.tv/commands\r\n");
            this.ws.send("NICK " + nick + "\r\n");
            this.ws.send("JOIN #" + this.channel + "\r\n");
            if (this.onStatus) this.onStatus(true);
        };

        this.ws.onmessage = (event) => {
            const lines = event.data.split("\r\n");
            for (const line of lines) {
                if (!line) continue;
                if (line.startsWith("PING")) {
                    this.ws.send("PONG :tmi.twitch.tv\r\n");
                    continue;
                }
                if (line.includes("PRIVMSG")) {
                    this._parsePrivmsg(line);
                }
            }
        };

        this.ws.onclose = () => {
            if (this.onStatus) this.onStatus(false);
            this._scheduleReconnect();
        };

        this.ws.onerror = () => {};
    }

    _scheduleReconnect() {
        if (!this.running) return;
        this._reconnectTimer = setTimeout(() => this._doConnect(), 5000);
    }

    _parsePrivmsg(line) {
        if (!this.onMessage) return;
        try {
            let tags = {};
            let rest = line;

            if (line.startsWith("@")) {
                const spaceIdx = line.indexOf(" ");
                const tagStr = line.substring(1, spaceIdx);
                rest = line.substring(spaceIdx + 1);
                for (const part of tagStr.split(";")) {
                    const eqIdx = part.indexOf("=");
                    if (eqIdx !== -1) tags[part.substring(0, eqIdx)] = part.substring(eqIdx + 1);
                }
            }

            const match = rest.match(/:(\w+)!\S+ PRIVMSG #\S+ :(.*)/);
            if (!match) return;

            const username = match[1];
            const message = match[2];

            let isSubscriber = false;
            let subMonths = 0;

            const badges = tags["badges"] || "";
            const badgeInfo = tags["badge-info"] || "";

            for (const badge of badges.split(",")) {
                if (badge.startsWith("subscriber/") || badge.startsWith("founder/")) {
                    isSubscriber = true;
                    break;
                }
            }

            for (const info of badgeInfo.split(",")) {
                if (info.startsWith("subscriber/")) {
                    const parts = info.split("/");
                    subMonths = parseInt(parts[1]) || (isSubscriber ? 1 : 0);
                    break;
                }
            }

            if (isSubscriber && subMonths === 0) subMonths = 1;

            this.onMessage({
                platform: "twitch",
                user_id: tags["user-id"] || username,
                username: username,
                display_name: tags["display-name"] || username,
                is_subscriber: isSubscriber,
                sub_months: subMonths,
                message: message,
            });
        } catch (_) {}
    }
}

// ---- Kick Connector (browser WebSocket via Pusher) ----
class KickConnector {
    constructor() {
        this.ws = null;
        this.running = false;
        this.chatroomId = null;
        this.onMessage = null;
        this.onStatus = null;
        this._reconnectTimer = null;
    }

    async connect(slug, chatroomId) {
        this.running = true;

        if (chatroomId) {
            this.chatroomId = chatroomId;
        } else {
            try {
                this.chatroomId = await this._fetchChatroomId(slug);
            } catch (e) {
                console.error("Failed to fetch Kick chatroom ID:", e);
                if (this.onStatus) this.onStatus(false);
                return;
            }
        }

        this._doConnect();
    }

    disconnect() {
        this.running = false;
        if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
        if (this.ws) { this.ws.close(); this.ws = null; }
        if (this.onStatus) this.onStatus(false);
    }

    async _fetchChatroomId(slug) {
        // Try CORS proxy since Kick API doesn't allow cross-origin
        const proxies = [
            `https://corsproxy.io/?url=${encodeURIComponent("https://kick.com/api/v2/channels/" + slug)}`,
            `https://api.allorigins.win/raw?url=${encodeURIComponent("https://kick.com/api/v2/channels/" + slug)}`,
        ];

        for (const url of proxies) {
            try {
                const resp = await fetch(url);
                if (!resp.ok) continue;
                const data = await resp.json();
                if (data?.chatroom?.id) return data.chatroom.id;
            } catch (_) {}
        }

        throw new Error("Could not fetch chatroom ID. Enter it manually in settings.");
    }

    _doConnect() {
        if (!this.running || !this.chatroomId) return;

        const url = "wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679?protocol=7&client=js&version=8.4.0-rc2&flash=false";
        try {
            this.ws = new WebSocket(url);
        } catch (e) {
            this._scheduleReconnect();
            return;
        }

        this.ws.onopen = () => {};

        this.ws.onmessage = (event) => {
            try {
                const msg = JSON.parse(event.data);
                const evt = msg.event || "";

                if (evt === "pusher:connection_established") {
                    // Subscribe
                    this.ws.send(JSON.stringify({
                        event: "pusher:subscribe",
                        data: { auth: "", channel: `chatrooms.${this.chatroomId}.v2` }
                    }));
                    if (this.onStatus) this.onStatus(true);
                } else if (evt === "pusher:ping") {
                    this.ws.send(JSON.stringify({ event: "pusher:pong", data: {} }));
                } else if (evt.includes("ChatMessage")) {
                    this._parseChatMessage(msg);
                }
            } catch (_) {}
        };

        this.ws.onclose = () => {
            if (this.onStatus) this.onStatus(false);
            this._scheduleReconnect();
        };

        this.ws.onerror = () => {};
    }

    _scheduleReconnect() {
        if (!this.running) return;
        this._reconnectTimer = setTimeout(() => this._doConnect(), 5000);
    }

    _parseChatMessage(msg) {
        if (!this.onMessage) return;
        try {
            const dataStr = msg.data || "{}";
            const data = typeof dataStr === "string" ? JSON.parse(dataStr) : dataStr;
            const sender = data.sender || {};
            const identity = sender.identity || {};
            const badges = identity.badges || [];

            let isSubscriber = false;
            let subMonths = 0;

            for (const badge of badges) {
                const badgeType = (badge.type || "").toLowerCase();
                if (badgeType.includes("subscriber")) {
                    isSubscriber = true;
                    subMonths = badge.count || sender.months_subscribed || 0;
                    break;
                }
            }

            if (!isSubscriber && sender.is_subscriber) {
                isSubscriber = true;
                subMonths = sender.months_subscribed || 1;
            }

            this.onMessage({
                platform: "kick",
                user_id: String(sender.id || "unknown"),
                username: sender.slug || sender.username || "unknown",
                display_name: sender.username || "unknown",
                is_subscriber: isSubscriber,
                sub_months: subMonths,
                message: data.content || "",
            });
        } catch (_) {}
    }
}

// ============================================================
// UI
// ============================================================

// DOM elements
const stateLabel = document.getElementById("state-label");
const statusDot = document.getElementById("status-dot");
const participantCount = document.getElementById("participant-count");
const keywordDisplay = document.getElementById("keyword-display");
const participantBody = document.getElementById("participant-body");
const emptyParticipants = document.getElementById("empty-participants");
const winnerDisplay = document.getElementById("winner-display");
const winnerNameEl = document.getElementById("winner-name");
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

const cpReelWrapper = document.getElementById("cp-reel-wrapper");
const cpReelContainer = document.getElementById("cp-reel-container");
const cpReelStrip = document.getElementById("cp-reel-strip");

const settingsToggle = document.getElementById("settings-toggle");
const settingsContent = document.getElementById("settings-content");

// State
let currentState = "IDLE";
let count = 0;
let reelTimeout = null;
let twitchConnected = false;
let kickConnected = false;

// Instances
const engine = new GiveawayEngine();
const twitchConn = new TwitchConnector();
const kickConn = new KickConnector();

// Wire connectors to engine
twitchConn.onMessage = (entry) => engine.handleChatMessage(entry);
kickConn.onMessage = (entry) => engine.handleChatMessage(entry);
twitchConn.onStatus = (connected) => { twitchConnected = connected; renderChannels(); };
kickConn.onStatus = (connected) => { kickConnected = connected; renderChannels(); };

// Wire engine callbacks
engine.onStateChanged = (data) => {
    updateUI(data.state, data.keyword);
    if (data.count !== undefined) {
        count = data.count;
        participantCount.textContent = count;
    }
};

engine.onParticipantAdded = (participant, cnt) => {
    count = cnt;
    participantCount.textContent = count;
    addParticipantRow(participant);
};

engine.onWinnerDrawn = (data) => {
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
        winnerNameEl.textContent = w.display_name;
        winnerDetails.textContent = detailsText;
        winnerNameEl.style.display = "";
        winnerDetails.style.display = "";
        btnDraw.disabled = false;
        btnDraw.textContent = data.eligible_remaining > 0 ? "Redraw" : "Draw";
    });
};

// ---- Settings toggle ----
settingsToggle.addEventListener("click", () => {
    settingsToggle.classList.toggle("open");
    settingsContent.classList.toggle("open");
    if (settingsContent.classList.contains("open")) {
        setTimeout(drawWeightChart, 50);
    }
});

// ---- Reel animation (CS2-style) ----
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

function buildCpReel(allNames, winnerDisplayName) {
    cpReelStrip.innerHTML = "";
    const winnerPos = 38 + Math.floor(Math.random() * 12);
    const pool = allNames.filter(n => n !== winnerDisplayName);
    if (pool.length === 0) pool.push(winnerDisplayName);

    for (let i = 0; i < REEL_TOTAL; i++) {
        const el = document.createElement("div");
        if (i === winnerPos) {
            el.className = "cp-reel-card rarity-gold";
            el.textContent = winnerDisplayName;
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

    winnerNameEl.style.display = "none";
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

// ---- Channel tags ----
function renderChannels() {
    const cfg = engine.config;
    channelsBar.innerHTML = "";

    if (cfg.twitch_enabled && cfg.twitch_channel) {
        channelsBar.innerHTML += `
            <div class="channel-tag twitch">
                <span class="dot ${twitchConnected ? "" : "off"}"></span>
                <span class="platform">TWITCH</span>
                <span>${escapeHtml(cfg.twitch_channel)}</span>
            </div>`;
    }
    if (cfg.kick_enabled && cfg.kick_channel_slug) {
        channelsBar.innerHTML += `
            <div class="channel-tag kick">
                <span class="dot ${kickConnected ? "" : "off"}"></span>
                <span class="platform">KICK</span>
                <span>${escapeHtml(cfg.kick_channel_slug)}</span>
            </div>`;
    }
    if (channelsBar.innerHTML === "") {
        channelsBar.innerHTML = `<div class="channel-tag none">No channels configured</div>`;
    }
}

// ---- Keyword display ----
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

// ---- Weight mode UI ----
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

// ---- Weight chart ----
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
    if (rect.width === 0) return;
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

    chartCtx.textAlign = "center";
    chartCtx.textBaseline = "top";
    const xLabels = [0, 6, 12, 24, 36, 48, 60];
    for (const m of xLabels) {
        const x = pad.left + (m / maxMonths) * plotW;
        chartCtx.fillText(m + "mo", x, pad.top + plotH + 8);
    }

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

    const lastPt = points[points.length - 1];
    chartCtx.lineTo(pad.left + (lastPt.m / maxMonths) * plotW, pad.top + plotH);
    chartCtx.lineTo(pad.left, pad.top + plotH);
    chartCtx.closePath();
    const grad = chartCtx.createLinearGradient(0, pad.top, 0, pad.top + plotH);
    grad.addColorStop(0, "rgba(124,92,252,0.25)");
    grad.addColorStop(1, "rgba(124,92,252,0.02)");
    chartCtx.fillStyle = grad;
    chartCtx.fill();

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


// ---- UI updates ----
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

// ---- Button handlers ----
btnStart.addEventListener("click", () => {
    const keyword = inputKeyword.value.trim();
    engine.start(keyword);
});

btnStop.addEventListener("click", () => engine.stopEntries());
btnDraw.addEventListener("click", () => engine.drawWinner());
btnReset.addEventListener("click", () => engine.reset());

// ---- Save & reconnect ----
btnSaveConfig.addEventListener("click", () => {
    const oldCfg = { ...engine.config };

    const cfg = {
        ...engine.config,
        twitch_enabled: inputTwitchEnabled.checked,
        twitch_channel: inputTwitchChannel.value.trim(),
        kick_enabled: inputKickEnabled.checked,
        kick_channel_slug: inputKickChannel.value.trim(),
        kick_chatroom_id: null,
        keyword: inputKeyword.value.trim(),
        allow_non_subs: inputAllowNonSubs.value === "true",
        non_sub_weight: parseFloat(inputNonSubWeight.value) || 1.0,
        sub_weight_mode: inputSubWeightMode.value,
        sub_constant_weight: parseFloat(inputSubConstantWeight.value) || 2.0,
        sub_log_multiplier: parseFloat(inputLogMultiplier.value) || 1.0,
        sub_linear_multiplier: parseFloat(inputLinearMultiplier.value) || 1.0,
    };

    engine.config = cfg;
    saveConfig(cfg);

    // Update keyword display
    updateKeywordDisplay(cfg.keyword);

    // Reconnect if channel settings changed
    const channelsChanged =
        oldCfg.twitch_enabled !== cfg.twitch_enabled ||
        oldCfg.twitch_channel !== cfg.twitch_channel ||
        oldCfg.kick_enabled !== cfg.kick_enabled ||
        oldCfg.kick_channel_slug !== cfg.kick_channel_slug ||
        oldCfg.kick_chatroom_id !== cfg.kick_chatroom_id;

    if (channelsChanged) {
        connectChannels(cfg);
        const hint = document.getElementById("channels-hint");
        hint.style.display = "";
        setTimeout(() => { hint.style.display = "none"; }, 3000);
    }

    renderChannels();

    btnSaveConfig.textContent = "Saved!";
    btnSaveConfig.classList.add("saved");
    setTimeout(() => {
        btnSaveConfig.textContent = "Save Settings";
        btnSaveConfig.classList.remove("saved");
    }, 1500);
});

// ---- Connect channels ----
function connectChannels(cfg) {
    // Disconnect existing
    twitchConn.disconnect();
    kickConn.disconnect();

    if (cfg.twitch_enabled && cfg.twitch_channel) {
        twitchConn.connect(cfg.twitch_channel);
    }

    if (cfg.kick_enabled && cfg.kick_channel_slug) {
        kickConn.connect(cfg.kick_channel_slug, cfg.kick_chatroom_id);
    }
}

// ---- Init ----
(function init() {
    const cfg = loadConfig();
    engine.config = cfg;
    engine.keyword = cfg.keyword || "!giveaway";

    // Populate form
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

    updateKeywordDisplay(cfg.keyword);
    renderChannels();
    updateWeightModeUI();
    updateUI("IDLE");

    // Redraw chart after layout is ready
    setTimeout(drawWeightChart, 100);

    // Auto-connect
    connectChannels(cfg);
})();

// Redraw chart on window resize
window.addEventListener("resize", drawWeightChart);
