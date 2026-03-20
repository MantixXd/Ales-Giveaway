const socket = io();

const statusBar = document.getElementById("status-bar");
const stateEl = document.getElementById("overlay-state");
const countEl = document.getElementById("overlay-count");
const keywordEl = document.getElementById("overlay-keyword");
const winnerOverlay = document.getElementById("winner-overlay");
const winnerNameEl = document.getElementById("overlay-winner-name");
const winnerPlatformEl = document.getElementById("overlay-winner-platform");
const winnerSubEl = document.getElementById("overlay-winner-sub");
const ticker = document.getElementById("ticker");

const reelWrapper = document.getElementById("reel-wrapper");
const reelContainer = document.getElementById("reel-container");
const reelStrip = document.getElementById("reel-strip");

const MAX_TICKER = 5;
const CARD_WIDTH = 160;
const TOTAL_CARDS = 55;
const SPIN_DURATION = 6000; // ms
let animationTimeout = null;

function randomRarity() {
    const r = Math.random() * 100;
    if (r < 79.92) return "rarity-blue";
    if (r < 79.92 + 15.98) return "rarity-purple";
    if (r < 79.92 + 15.98 + 3.20) return "rarity-pink";
    return "rarity-red";
}

function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
}

function updateState(state, keyword) {
    stateEl.textContent = state;
    stateEl.className = "state " + state.toLowerCase();
    if (keyword) keywordEl.textContent = keyword;

    if (state === "IDLE") {
        statusBar.classList.add("hidden");
        winnerOverlay.classList.remove("visible");
        reelWrapper.classList.remove("active");
        ticker.innerHTML = "";
    } else {
        statusBar.classList.remove("hidden");
    }
}

// --- REEL ANIMATION ---

function buildReel(allNames, winnerName) {
    reelStrip.innerHTML = "";

    // Winner position: somewhere in the last third
    const winnerPos = 38 + Math.floor(Math.random() * 12); // 38-49

    // Build pool excluding winner name (for variety)
    const pool = allNames.filter(n => n !== winnerName);
    if (pool.length === 0) pool.push(winnerName); // edge case: only 1 participant

    const cards = [];
    for (let i = 0; i < TOTAL_CARDS; i++) {
        if (i === winnerPos) {
            cards.push({ name: winnerName, isWinner: true });
        } else {
            const name = pool[Math.floor(Math.random() * pool.length)];
            cards.push({ name, isWinner: false });
        }
    }

    // Create DOM
    cards.forEach((card) => {
        const el = document.createElement("div");
        if (card.isWinner) {
            el.className = "reel-card rarity-gold";
            el.dataset.winner = "1";
        } else {
            el.className = "reel-card " + randomRarity();
        }
        el.textContent = card.name;
        reelStrip.appendChild(el);
    });

    return winnerPos;
}

function spinReel(allNames, winner, callback) {
    // Clear any pending animation
    if (animationTimeout) {
        clearTimeout(animationTimeout);
        animationTimeout = null;
    }

    // Hide previous winner
    winnerOverlay.classList.remove("visible");
    reelWrapper.classList.remove("fade-out");

    // Build cards
    const winnerPos = buildReel(allNames, winner.display_name);

    // Calculate positions
    const containerWidth = reelContainer.offsetWidth;
    const targetOffset = -(winnerPos * CARD_WIDTH) + (containerWidth / 2) - (CARD_WIDTH / 2);
    // Small random jitter so marker doesn't always hit dead center
    const jitter = (Math.random() - 0.5) * (CARD_WIDTH * 0.35);

    // Initial position: strip starts off-screen right
    reelStrip.style.transition = "none";
    reelStrip.style.transform = `translateX(${containerWidth + 200}px)`;

    // Show reel
    reelWrapper.classList.add("active");

    // Start spinning after a frame
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            reelStrip.style.transition = `transform ${SPIN_DURATION}ms cubic-bezier(0.12, 0.68, 0.18, 1)`;
            reelStrip.style.transform = `translateX(${targetOffset + jitter}px)`;
        });
    });

    // After spin completes: highlight winner
    animationTimeout = setTimeout(() => {
        const winnerCard = reelStrip.querySelector('[data-winner="1"]');
        if (winnerCard) winnerCard.classList.add("winner-reveal");

        // After highlight pause: fade reel, show winner overlay
        animationTimeout = setTimeout(() => {
            reelWrapper.classList.add("fade-out");

            animationTimeout = setTimeout(() => {
                reelWrapper.classList.remove("active", "fade-out");
                if (callback) callback();
            }, 800);
        }, 1800);
    }, SPIN_DURATION + 150);
}

// --- SOCKET.IO EVENTS ---

socket.on("state_changed", (data) => {
    updateState(data.state, data.keyword);
    if (data.count !== undefined) countEl.textContent = data.count;
});

socket.on("participant_added", (data) => {
    countEl.textContent = data.count;

    const entry = document.createElement("div");
    entry.className = "ticker-entry";
    entry.innerHTML = `
        <span class="user">${escapeHtml(data.participant.display_name)}</span>
        <span class="weight">${data.participant.weight}x</span>
    `;
    ticker.prepend(entry);

    while (ticker.children.length > MAX_TICKER) {
        ticker.removeChild(ticker.lastChild);
    }
});

socket.on("winner_drawn", (data) => {
    const w = data.winner;
    const names = data.reel_names || [w.display_name];

    // Hide ticker during animation
    ticker.innerHTML = "";

    // Run CS2 reel animation
    spinReel(names, w, () => {
        // Show winner overlay after reel fades
        winnerNameEl.textContent = w.display_name;
        winnerPlatformEl.textContent = w.platform.toUpperCase();
        winnerSubEl.textContent = w.is_subscriber
            ? `Subscriber ${w.sub_months} months`
            : "Non-subscriber";
        winnerOverlay.classList.add("visible");
    });
});
