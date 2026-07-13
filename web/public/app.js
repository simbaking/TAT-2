// API base URL
const API_URL = '';

/**
 * Write to element.innerHTML while preserving the window scroll position.
 * - Skips the write entirely when content hasn't changed (no-op on same data).
 * - When content does change, saves scrollX/scrollY before the DOM rebuild
 *   and restores them synchronously after. Because JS is single-threaded the
 *   browser cannot repaint in between, so the scroll lock is invisible to the
 *   user even when game state updates mid-poll.
 */
function setHTML(el, html) {
    if (!el || el._lastHtml === html) return; // nothing changed – skip
    const sx = window.scrollX;
    const sy = window.scrollY;
    el.innerHTML = html;
    el._lastHtml = html;
    window.scrollTo(sx, sy); // restore before browser gets a chance to repaint
}

// DOM elements
const registerForm = document.getElementById('register-form');
const startForm = document.getElementById('start-form');
const gameForm = document.getElementById('game-form');
const createOfferForm = document.getElementById('create-offer-form');
const playerNameInput = document.getElementById('player-name');
const isComputerCheckbox = document.getElementById('is-computer');
const computerLevelSelect = document.getElementById('computer-level');

// Active games duration updater
setInterval(() => {
    document.querySelectorAll('.active-game-duration').forEach(el => {
        let duration = parseInt(el.getAttribute('data-duration') || '0', 10);
        // We increment it visually, actual sync happens when server updates the data attribute
        const totalSeconds = duration;
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        el.textContent = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
        el.setAttribute('data-duration', duration + 1);
    });
}, 1000);

const durationHoursInput = document.getElementById('duration-hours');
const durationMinutesInput = document.getElementById('duration-minutes');
const gamePlayer1Select = document.getElementById('game-player1');
const gamePlayer2Select = document.getElementById('game-player2');
// const offerPlayerSelect = document.getElementById('offer-player'); // Removed
const offerTargetsSelect = document.getElementById('offer-targets');
const leaderboard = document.getElementById('leaderboard');
const openOffersDiv = document.getElementById('open-offers');
const statusBadge = document.getElementById('tournament-status');
const timerDisplay = document.getElementById('timer');
const resetBtn = document.getElementById('reset-btn');
const messageDiv = document.getElementById('message');

let statusInterval = null;
let currentPlayers = [];
let wasTournamentRunning = false; // Track tournament state for end detection
let celebrationShown = false; // Prevent multiple celebrations
let openedGames = new Set(JSON.parse(sessionStorage.getItem('openedGames') || '[]')); // Track games already auto-opened for this player

// Local Storage Key
const STORAGE_KEY = 'chess_tournament_player_name';
const BROWSER_ID_KEY = 'chess_browser_id';
let myPlayerName = localStorage.getItem(STORAGE_KEY);

// Generate or retrieve persistent browser ID
function getBrowserId() {
    let browserId = localStorage.getItem(BROWSER_ID_KEY);
    if (!browserId) {
        // Generate a UUID
        browserId = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
            const r = Math.random() * 16 | 0;
            const v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
        localStorage.setItem(BROWSER_ID_KEY, browserId);
    }
    return browserId;
}
const myBrowserId = getBrowserId();

// Enable/disable computer level selector
isComputerCheckbox.addEventListener('change', () => {
    computerLevelSelect.disabled = !isComputerCheckbox.checked;
    if (typeof updateAuthUI === 'function') {
        updateAuthUI();
    }
});

// Calculate Elo (mirrors ComputerPlayer.js)
function getElo(level) {
    if (level === -1) return 200;  // Random moves
    if (level === -0.5) return 300;
    if (level === 0) return 400;   // Simple minimax
    if (level === 0.5) return 600;
    return 800 + (Math.max(1, Math.min(25, level)) - 1) * 120;
}

// Populate computer levels
function populateComputerLevels() {
    computerLevelSelect.innerHTML = '';

    // Add Level -1 (Random)
    const randomOption = document.createElement('option');
    randomOption.value = -1;
    randomOption.textContent = 'Level -1 (200) - Random';
    computerLevelSelect.appendChild(randomOption);

    const minusHalfOption = document.createElement('option');
    minusHalfOption.value = -0.5;
    minusHalfOption.textContent = 'Level -0.5 (300) - Two Move';
    computerLevelSelect.appendChild(minusHalfOption);

    const zeroOption = document.createElement('option');
    zeroOption.value = 0;
    zeroOption.textContent = 'Level 0 (400) - Pseudo Random';
    computerLevelSelect.appendChild(zeroOption);

    const halfOption = document.createElement('option');
    halfOption.value = 0.5;
    halfOption.textContent = 'Level 0.5 (600) - Two Move Stockfish';
    computerLevelSelect.appendChild(halfOption);

    // Add Levels 1-25
    for (let i = 1; i <= 25; i++) {
        const elo = getElo(i);
        const option = document.createElement('option');
        option.value = i;

        let label = `Level ${i} (${Math.round(elo)}) - Stockfish`;

        option.textContent = label;
        if (i === 10) option.selected = true;
        computerLevelSelect.appendChild(option);
    }
}

populateComputerLevels();

// Show message
function showMessage(text, type = 'success') {
    messageDiv.innerHTML = text;
    messageDiv.className = `message ${type} show`;
    setTimeout(() => {
        messageDiv.classList.remove('show');
    }, 5000);
}

// BroadcastChannel for cross-tab communication
const gameChannel = new BroadcastChannel('chess_games');

// Listen for game tab close notifications
gameChannel.onmessage = (event) => {
    if (event.data.type === 'GAME_CLOSED') {
        console.log(`Game ${event.data.gameId} closed. Returning focus to tournament tab.`);
        openedGames.delete(event.data.gameId);
        sessionStorage.setItem('openedGames', JSON.stringify([...openedGames]));
        window.focus();
    }
};

// Open game window (now navigates in the same tab)
function openGameWindow(url, gameId) {
    window.location.href = url;
    return window;
}

// Toggle variant selection panel based on Allow Variants checkbox
const allowVariantsCheckbox = document.getElementById('allow-variants');
const variantSelectionPanel = document.getElementById('variant-selection');
if (allowVariantsCheckbox && variantSelectionPanel) {
    allowVariantsCheckbox.addEventListener('change', () => {
        variantSelectionPanel.classList.toggle('hidden-panel', !allowVariantsCheckbox.checked);
    });
}

// Format time
function formatTime(totalMs) {
    const hours = Math.floor(totalMs / 3600000);
    const minutes = Math.floor((totalMs % 3600000) / 60000);
    const seconds = Math.floor((totalMs % 60000) / 1000);

    const parts = [];
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0 || hours > 0) parts.push(`${minutes}m`);
    parts.push(`${seconds}s`);

    return parts.join(' ');
}

function formatScore(totalMs) {
    const hours = Math.floor(totalMs / 3600000);
    const minutes = Math.floor((totalMs % 3600000) / 60000);
    const seconds = Math.floor((totalMs % 60000) / 1000);

    const parts = [];
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0 || hours > 0) parts.push(`${minutes}m`);
    parts.push(`${seconds}s`);

    return parts.join(' ');
}

// Helper to format player name with (You)
function formatPlayerName(name) {
    return (name && myPlayerName && name.toLowerCase() === myPlayerName.toLowerCase()) ? `${name} (You)` : name;
}

// Fetch and update status
async function updateStatus() {
    try {
        const response = await fetch(`${API_URL}/api/status`);
        const data = await response.json();

        // Check if my player still exists on server (e.g. after server restart)
        if (myPlayerName) {
            const me = data.players.find(p => p.name.toLowerCase() === myPlayerName.toLowerCase());
            if (!me) {
                // Server forgot us, clear local storage so we can re-register
                console.log('Local player not found on server, clearing local storage');
                localStorage.removeItem(STORAGE_KEY);
                myPlayerName = null;
            }
        }

        // Update status badge
        if (data.isRunning) {
            statusBadge.textContent = 'Running';
            statusBadge.classList.remove('status-badge');
            statusBadge.classList.add('status-badge', 'running');
            statusBadge.style.backgroundColor = ''; // Reset inline style
            let displayTime = data.remainingTime;
            if (data.config && data.config.mode === 'survival' && myPlayerName) {
                const me = data.players.find(p => p.name.toLowerCase() === myPlayerName.toLowerCase());
                if (me) displayTime = me.timeLeft;
            }
            timerDisplay.textContent = formatTime(displayTime);
            wasTournamentRunning = true;
            celebrationShown = false;

            // Change Start button to Update button
            const startBtn = document.querySelector('#start-form button[type="submit"]');
            if (startBtn) {
                if (startBtn.textContent !== 'Update Tournament') {
                    startBtn.textContent = 'Update Tournament';
                    startBtn.classList.remove('btn-success');
                    startBtn.classList.add('btn-primary');

                    // Pre-fill form with current config if available
                    if (data.config) {
                        const allowVariantsCheckbox = document.getElementById('allow-variants');
                        if (allowVariantsCheckbox) allowVariantsCheckbox.checked = data.config.allowVariants;

                        const variantPanel = document.getElementById('variant-selection');
                        if (variantPanel) variantPanel.classList.toggle('hidden-panel', !data.config.allowVariants);

                        if (data.config.allowedVariants) {
                            ['freestyle', 'kungfu', 'crazyhouse', 'kingofthehill', 'atomic'].forEach(v => {
                                const cb = document.getElementById(`allow-${v}`);
                                if (cb) cb.checked = data.config.allowedVariants.includes(v);
                            });
                        }
                    }
                }
            }
        } else {
            // Check if tournament is Finished or just Not Started
            if (data.startTime && data.durationLimit > 0) {
                statusBadge.textContent = 'Finished';
                statusBadge.className = 'status-badge';
                statusBadge.style.backgroundColor = '#f97316'; // Orange
                timerDisplay.textContent = '00:00';
            } else {
                statusBadge.textContent = 'Not Started';
                statusBadge.classList.remove('running');
                statusBadge.style.backgroundColor = ''; // Reset
                timerDisplay.textContent = '';
            }

            // Reset Start Button
            const startBtn = document.querySelector('#start-form button[type="submit"]');
            if (startBtn) {
                startBtn.textContent = 'Start Tournament';
                startBtn.classList.add('btn-success');
                startBtn.classList.remove('btn-primary');
            }

            // Detect tournament end transition
            if (wasTournamentRunning && !celebrationShown && data.players.length >= 2) {
                console.log('[Tournament End] Showing celebration!');
                celebrationShown = true;
                wasTournamentRunning = false;
                showCelebration(data.players);
            }
        }

        // Update leaderboard
        if (data.players.length === 0) {
            setHTML(leaderboard, '<p class="empty-state">No players registered yet</p>');
        } else {
            const isSurvival = data.config && data.config.mode === 'survival';
            let sortedPlayers = [...data.players];
            
            if (isSurvival) {
                sortedPlayers.sort((a, b) => {
                    if (a.eliminated && !b.eliminated) return 1;
                    if (!a.eliminated && b.eliminated) return -1;
                    return b.timeLeft - a.timeLeft;
                });
            } else {
                sortedPlayers.sort((a, b) => b.score - a.score);
            }

            setHTML(leaderboard, sortedPlayers.map((player, index) => {
                const pos = index + 1;
                const getOrdinal = (n) => {
                    const s = ["th", "st", "nd", "rd"];
                    const v = n % 100;
                    return n + (s[(v - 20) % 10] || s[v] || s[0]);
                };
                const ordinal = getOrdinal(pos);
                const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : '';
                const playerType = player.isComputer ? `🤖 Level ${player.level} (${Math.round(player.elo || 0)})` : `👤 (${Math.round(player.elo || 0)})`;
                const displayName = formatPlayerName(player.name);
                const highlightClass = (player.name && myPlayerName && player.name.toLowerCase() === myPlayerName.toLowerCase()) ? 'highlight-me' : '';
                
                let scoreText = '';
                let styleStr = '';
                if (isSurvival) {
                    if (player.eliminated) {
                        scoreText = player.eliminationPosition ? `Eliminated (#${player.eliminationPosition})` : 'Eliminated';
                        styleStr = 'text-decoration: line-through; opacity: 0.6;';
                    } else {
                        scoreText = formatTime(player.timeLeft);
                    }
                } else {
                    scoreText = formatScore(player.score);
                }

                return `
                    <div class="player-item ${highlightClass}" style="${styleStr}">
                        <span>${ordinal} ${medal} ${displayName} ${playerType}</span>
                        <span class="player-score">${scoreText}</span>
                    </div>
                `;
            }).join(''));
        }

        // Store players for dropdown updates
        console.log('[updateStatus] Players from server:', data.players.length, data.players.map(p => p.name));
        currentPlayers = data.players;
        updatePlayerDropdowns(data.players);

        // Update active games list
        updateActiveGames();

        // Update open offers
        updateOpenOffers(data.offers || []);

    } catch (error) {
        console.error('Error updating status:', error);
    }
}

// Update player dropdowns
function updatePlayerDropdowns(players) {
    console.log('[updatePlayerDropdowns] Called with', players.length, 'players:', players.map(p => p.name));
    const player1Current = gamePlayer1Select.value;
    const player2Current = gamePlayer2Select.value;
    // const offerPlayerCurrent = offerPlayerSelect.value; // Removed

    // Preserve selected targets
    const currentTargets = Array.from(offerTargetsSelect.selectedOptions).map(opt => opt.value);

    // Helper to create options
    const createOptions = (select, currentValue, isMulti = false) => {
        if (select.getAttribute('id') === 'offer-targets') {
            select.innerHTML = '<option value="Any">Any / Open to All</option>';
        } else {
            select.innerHTML = `<option value="">${select.getAttribute('data-placeholder') || 'Select Player'}</option>`;
        }

        players.forEach(player => {
            const playerType = player.isComputer ? ` 🤖 L${player.level} (${Math.round(player.elo)})` : '';
            const option = document.createElement('option');
            option.value = player.name;
            option.textContent = formatPlayerName(player.name) + playerType;
            select.appendChild(option);
        });

        if (isMulti) {
            // Restore selection
            if (currentTargets.length > 0) {
                Array.from(select.options).forEach(opt => {
                    if (currentTargets.includes(opt.value)) opt.selected = true;
                });
            } else {
                // Default to Any if nothing selected previously (or first load)
                select.options[0].selected = true;
            }
        } else {
            if (currentValue) select.value = currentValue;
        }
    };

    // Only update if not focused to avoid interrupting user (except targets which might need refresh)
    // OR if the dropdown is effectively empty (only default option)
    const isDefault = (select) => select.options.length <= 1;

    if (document.activeElement !== gamePlayer1Select || isDefault(gamePlayer1Select)) {
        gamePlayer1Select.setAttribute('data-placeholder', 'Select Player 1 (White)');
        createOptions(gamePlayer1Select, player1Current);
    }
    if (document.activeElement !== gamePlayer2Select || isDefault(gamePlayer2Select)) {
        gamePlayer2Select.setAttribute('data-placeholder', 'Select Player 2 (Black)');
        createOptions(gamePlayer2Select, player2Current);
    }
    // offerPlayerSelect removed from DOM, no need to update

    // Always update targets list to include new players, but try to preserve selection
    // Note: This might be annoying if user is actively selecting. 
    // Ideally we check focus, but for now let's update it.
    if (document.activeElement !== offerTargetsSelect) {
        createOptions(offerTargetsSelect, null, true);
    }
}

// Update open offers list
function updateOpenOffers(offers) {
    if (offers.length === 0) {
        setHTML(openOffersDiv, '<p class="empty-state">No active offers</p>');
        return;
    }

    const newHtml = offers.map(offer => {
        const timeText = `${offer.timeControl}m${offer.increment ? '+' + offer.increment + 's' : ''}`;

        let targetText = 'Any';
        if (offer.targets && offer.targets.length > 0 && !offer.targets.includes('Any')) {
            targetText = offer.targets.map(t => formatPlayerName(t)).join(', ');
        }

        const playerDisplay = formatPlayerName(offer.creator);
        const eloDisplay = offer.elo ? `(${Math.round(offer.elo)})` : '';

        // Variant badge
        const variantBadge = getVariantBadge(offer.variant);

        // Determine if we can accept
        let actionHtml = '';
        if (!myPlayerName) {
            actionHtml = '<small style="color: var(--text-muted);">Register to accept</small>';
        } else if (offer.acceptedBy && offer.acceptedBy.includes(myPlayerName)) {
            actionHtml = '<small style="color: var(--text-muted);">You accepted</small>';
        } else {
            // Check targets
            const isTargeted = !offer.targets ||
                offer.targets.length === 0 ||
                offer.targets.includes('Any') ||
                offer.targets.includes(myPlayerName);

            if (isTargeted) {
                actionHtml = `<button class="btn btn-success" style="padding: 5px 10px; font-size: 0.9rem;" 
                        onclick="acceptOffer(${offer.id})">Accept as ${myPlayerName}</button>`;
            } else {
                actionHtml = '<small style="color: var(--text-muted);">Not targeted</small>';
            }
        }

        const acceptedText = offer.requiredPlayers > 2 ? `<br><small style="color: #ff9800; font-weight: bold;">${offer.acceptedBy ? offer.acceptedBy.length : 1}/${offer.requiredPlayers} Accepted</small>` : '';

        return `
            <div class="player-item" style="flex-wrap: wrap; gap: 10px;">
                <div style="flex: 1;">
                    <strong>${playerDisplay} ${eloDisplay}</strong> wants to play 
                    <span class="score">${timeText}</span>
                    ${variantBadge}
                    ${acceptedText}
                    <br><small style="color: var(--text-muted);">Target: ${targetText}</small>
                </div>
                <div style="display: flex; gap: 5px; align-items: center;">
                    ${actionHtml}
                </div>
            </div>
        `;
    }).join('');
    setHTML(openOffersDiv, newHtml);
}

// Get variant badge HTML
function getVariantBadge(variantString) {
    if (!variantString || variantString === 'standard') {
        return '';
    }

    const badges = {
        'freestyle': { text: '♟️ 960', color: '#3b82f6' },
        'kungfu': { text: '⚡ Kung Fu', color: '#ff4500' },
        'crazyhouse': { text: '🏠 Crazy', color: '#9333ea' },
        'kingofthehill': { text: '⛰️ KOTH', color: '#22c55e' },
        'atomic': { text: '💥 Atomic', color: '#dc2626' },
        '4player': { text: '👥 4-Player', color: '#eab308' },
        '3player_hex': { text: '⬡ 3-Hex', color: '#f59e0b' },
        '2player_hex': { text: '⬡ 2-Hex', color: '#f59e0b' },
        '6x6': { text: '⬛ 6x6', color: '#14b8a6' },
        '4x4': { text: '⬛ 4x4', color: '#0ea5e9' },
        'secret': { text: '🕵️ Secret', color: '#8b5cf6' },
        'fogofwar': { text: '🌫️ Fog', color: '#64748b' }
    };

    const variants = variantString.split(',');
    return variants.map(variant => {
        if (variant === 'standard') return '';
        const badge = badges[variant] || { text: variant, color: '#666' };
        return `<span class="variant-badge" style="display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 0.75rem; font-weight: 600; background: ${badge.color}; color: white; margin-left: 5px;">${badge.text}</span>`;
    }).join('');
}

// Accept offer handler (global scope for onclick)
window.acceptOffer = async (offerId) => {
    const playerName = myPlayerName;

    if (!playerName) {
        showMessage('Please register first', 'error');
        return;
    }
    // const playerName = select.value; // REMOVED duplicate declaration

    if (!playerName) {
        showMessage('Please select a player to accept as', 'error');
        return;
    }

    try {
        const response = await fetch(`${API_URL}/api/offers/accept`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ offerId, player2: playerName })
        });

        const data = await response.json();

        if (response.ok) {
            // Open game for acceptor (only if gameId is valid)
            if (data.gameId) {
                openGameWindow(`game.html?gameId=${data.gameId}&player=${playerName}`, data.gameId);
                showMessage(`Game started! Tab opened for ${playerName}`, 'success');
            } else {
                showMessage('Game created but no ID returned', 'error');
            }
            updateStatus();
        } else {
            showMessage(data.error, 'error');
        }
    } catch (error) {
        showMessage('Error accepting offer', 'error');
    }
};

// Update active games list
async function updateActiveGames() {
    try {
        const response = await fetch(`${API_URL}/api/games`);
        const data = await response.json();
        const activeGamesDiv = document.getElementById('active-games');

        // Auto-open game tab for human players when their game starts
        if (myPlayerName) {
            for (const game of data.games) {
                const isMyGame = game.player1.toLowerCase() === myPlayerName.toLowerCase() ||
                    game.player2.toLowerCase() === myPlayerName.toLowerCase();

                if (isMyGame && !game.isGameOver && !openedGames.has(game.gameId)) {
                    // New game involving this player - open it in a new tab
                    console.log(`Auto-opening game ${game.gameId} for player ${myPlayerName}`);
                    openedGames.add(game.gameId);
                    sessionStorage.setItem('openedGames', JSON.stringify([...openedGames]));
                    openGameWindow(`game.html?gameId=${game.gameId}&player=${encodeURIComponent(myPlayerName)}`, game.gameId);
                }
            }
        }

        if (data.games.length === 0) {
            setHTML(activeGamesDiv, '<p class="empty-state">No games in progress</p>');
        } else {
            const newHtml = data.games.map(game => {
                const statusIcon = game.isGameOver ? '✓' : '⏱️';
                const statusText = game.isGameOver
                    ? (game.winner ? `Winner: ${formatPlayerName(game.winner)}` : 'Draw')
                    : `${formatPlayerName(game.currentPlayer)}'s turn`;

                const timeControlText = game.timeControl
                    ? `(${game.timeControl}m${game.increment ? '+' + game.increment + 's' : ''})`
                    : '';


                // Format player names
                const p1Display = formatPlayerName(game.player1) + (game.player1Elo ? ` (${Math.round(game.player1Elo)})` : '');
                const p2Display = formatPlayerName(game.player2) + (game.player2Elo ? ` (${Math.round(game.player2Elo)})` : '');

                // Highlight current player
                const p1Class = game.currentPlayer === game.player1 && !game.isGameOver ? 'style="font-weight: bold; color: var(--primary);"' : '';
                const p2Class = game.currentPlayer === game.player2 && !game.isGameOver ? 'style="font-weight: bold; color: var(--primary);"' : '';

                // Variant badge for active games
                const variantBadge = getVariantBadge(game.variant);

                return `
                    <div class="player-item" style="flex-direction: column; align-items: flex-start; gap: 0.5rem;">
                        <div style="display: flex; justify-content: space-between; width: 100%; align-items: center;">
                            <span>
                                ${statusIcon} <span ${p1Class}>${p1Display}</span> vs <span ${p2Class}>${p2Display}</span> 
                                <small style="color: var(--text-muted); margin-left: 0.5rem;">${timeControlText}</small>
                                ${variantBadge}
                            </span>
                            <span class="score">
                                <a href="#" onclick="openGameWindow('game.html?gameId=${game.gameId}', '${game.gameId}'); return false;" style="color: var(--accent); text-decoration: none; cursor: pointer;">
                                    ${statusText} →
                                </a>
                            </span>
                        </div>
                        <div style="font-size: 0.9rem; color: var(--text-muted); width: 100%; display: flex; justify-content: space-between;">
                            <span>Duration: <span class="active-game-duration" id="game-duration-${game.gameId}"></span></span>
                            <span>${data.mode === 'survival' 
                                ? `${formatPlayerName(game.player1)}: ${formatTime(game.player1TimeLeft)} | ${formatPlayerName(game.player2)}: ${formatTime(game.player2TimeLeft)}`
                                : `Tournament Time: ${formatTime(game.tournamentTimeRemaining)}`
                            }</span>
                        </div>
                    </div>
                `;
            }).join('');
            setHTML(activeGamesDiv, newHtml);

            // Update durations directly on DOM elements without triggering setHTML rebuilds
            data.games.forEach(game => {
                const el = document.getElementById(`game-duration-${game.gameId}`);
                if (el) {
                    const durationSeconds = Math.max(0, Math.floor((game.duration || 0) / 1000));
                    el.setAttribute('data-duration', durationSeconds);
                    const minutes = Math.floor(durationSeconds / 60);
                    const seconds = durationSeconds % 60;
                    const text = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
                    if (el.textContent !== text) {
                        el.textContent = text;
                    }
                }
            });
        }
    } catch (error) {
        console.error('Error updating active games:', error);
    }
}

// Register player
registerForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = playerNameInput.value.trim();
    const isComputer = isComputerCheckbox.checked;
    const level = isComputer ? parseFloat(computerLevelSelect.value) : null;

    try {
        const headers = { 'Content-Type': 'application/json' };
        if (typeof authToken !== 'undefined' && authToken) {
            headers['Authorization'] = `Bearer ${authToken}`;
        }
        
        const response = await fetch(`${API_URL}/api/register`, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify({ name, isComputer, level, browserId: myBrowserId })
        });

        const data = await response.json();

        if (response.ok) {
            const playerType = isComputer ? ` (Computer Level ${level})` : '';
            showMessage(`${data.message}${playerType}`, 'success');

            // Save to local storage if human
            if (!isComputer) {
                const finalName = data.name || name;
                localStorage.setItem(STORAGE_KEY, finalName);
                myPlayerName = finalName;
            }

            playerNameInput.value = '';
            isComputerCheckbox.checked = false;
            computerLevelSelect.disabled = true;
            // Wait a moment for server to update before fetching status
            setTimeout(updateStatus, 300);
        } else {
            showMessage(data.error, 'error');

            // If server says this browser already has a player, restore localStorage
            if (data.existingPlayer) {
                console.log(`Server says we're already registered as ${data.existingPlayer}, restoring localStorage`);
                localStorage.setItem(STORAGE_KEY, data.existingPlayer);
                myPlayerName = data.existingPlayer;
            }
        }
    } catch (error) {
        showMessage('Error registering player', 'error');
    }
});

// Start tournament
if (startForm) {
    console.log('Start form found, attaching event listener');
    startForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        console.log('Start tournament form submitted');
        const hours = parseInt(durationHoursInput.value) || 0;
        const minutes = parseInt(durationMinutesInput.value) || 0;
        const durationMinutes = (hours * 60) + minutes;
        console.log(`Duration: ${hours}h ${minutes}m = ${durationMinutes} total minutes`);

        if (durationMinutes <= 0) {
            showMessage('Please enter a valid duration', 'error');
            return;
        }

        const mode = document.getElementById('tournament-mode').value || 'survival';
        const allowVariants = document.getElementById('allow-variants').checked;

        // Collect specific allowed variants
        const allowedVariants = ['standard']; // Standard is always allowed
        let secretOptions = null;
        if (allowVariants) {
            const geometries = Array.from(document.querySelectorAll('input[name="start-geometry"]:checked')).map(cb => cb.value);
            const normalVariants = Array.from(document.querySelectorAll('input[name="start-variants"]:checked')).map(cb => cb.value);
            allowedVariants.push(...geometries);
            allowedVariants.push(...normalVariants);


        }

        try {
            console.log(`Sending start request: ${durationMinutes} minutes, allowedVariants: ${allowedVariants}`);
            const response = await fetch(`${API_URL}/api/start`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    durationMinutes,
                    hours,
                    minutes,
                    mode,
                    allowVariants,
                    allowedVariants, // Send specific allowed variants
                    secretOptions
                })
            });
            const data = await response.json();
            console.log('Start tournament response:', data);

            if (response.ok) {
                showMessage(data.message, 'success');
                updateStatus();
            } else {
                showMessage(data.error, 'error');
            }
        } catch (error) {
            console.error('Error starting tournament:', error);
            showMessage('Error starting tournament', 'error');
        }
    });
} else {
    console.error('Start form not found!');
}

// Toggle Freestyle position ID input and Kung Fu cooldown input visibility
const offerGeometryRadios = document.querySelectorAll('input[name="geometry"]');
const offerVariantCheckboxes = document.querySelectorAll('input[name="variants"]');
const offerStartPosInput = document.getElementById('offer-start-pos');
const offerCooldownInput = document.getElementById('offer-cooldown');
const offerTimeControl = document.getElementById('offer-time-control');
const offerIncrement = document.getElementById('offer-increment');
const geomOptions6x6 = document.getElementById('geom-options-6x6');
const geomOptions4x4 = document.getElementById('geom-options-4x4');

const handleVariantUIChange = () => {
    let hasKungFu = false;
    let hasFreestyle = false;

    offerVariantCheckboxes.forEach(cb => {
        if (cb.checked && cb.value === 'kungfu') hasKungFu = true;
        if (cb.checked && cb.value === 'freestyle') hasFreestyle = true;
    });

    const geometry = document.querySelector('input[name="geometry"]:checked')?.value || 'standard';
    if (geomOptions6x6) geomOptions6x6.style.display = geometry === '6x6' ? 'block' : 'none';
    if (geomOptions4x4) geomOptions4x4.style.display = geometry === '4x4' ? 'block' : 'none';

    if (offerStartPosInput) offerStartPosInput.style.display = hasFreestyle ? 'block' : 'none';
    if (offerCooldownInput) offerCooldownInput.style.display = hasKungFu ? 'block' : 'none';
    
    if (offerTimeControl) {
        offerTimeControl.disabled = hasKungFu;
        offerTimeControl.style.opacity = hasKungFu ? '0.5' : '1';
    }
    if (offerIncrement) {
        offerIncrement.disabled = hasKungFu;
        offerIncrement.style.opacity = hasKungFu ? '0.5' : '1';
    }

    const offerSecretOptions = document.getElementById('offer-secret-options');
    if (offerSecretOptions) offerSecretOptions.style.display = hasSecret ? 'flex' : 'none';
};

offerVariantCheckboxes.forEach(cb => cb.addEventListener('change', handleVariantUIChange));
offerGeometryRadios.forEach(radio => radio.addEventListener('change', handleVariantUIChange));



// Create Game Offer
createOfferForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const player1 = myPlayerName; // Use local player name
    const timeControl = document.getElementById('offer-time-control').value;
    const increment = document.getElementById('offer-increment').value;
    const geometry = document.querySelector('input[name="geometry"]:checked')?.value || 'standard';
    const checkedVariants = Array.from(document.querySelectorAll('input[name="variants"]:checked')).map(cb => cb.value);
    
    let variants = [];
    if (geometry !== 'standard') variants.push(geometry);
    
    // Add sub-options
    if (geometry === '6x6' && document.getElementById('offer-6x6-same-bishop')?.checked) {
        variants.push('6x6_same_bishop');
    }
    if (geometry === '4x4' && document.getElementById('offer-4x4-pawn-center')?.checked) {
        variants.push('4x4_pawn_center');
    }

    variants = variants.concat(checkedVariants);
    
    let variant = variants.length > 0 ? variants.join(',') : 'standard';

    let startPos = 'random';
    let cooldown = 10; // Default 10 seconds

    if (checkedVariants.includes('freestyle') && startPosInput) {
        const val = startPosInput.value.trim();
        if (val && val.toLowerCase() !== 'random') {
            startPos = val;
        }
    }

    if (checkedVariants.includes('kungfu') && cooldownInput) {
        cooldown = parseInt(cooldownInput.value) || 10;
    }

    // Get selected targets
    const selectedOptions = Array.from(offerTargetsSelect.selectedOptions);
    let targets = selectedOptions.map(opt => opt.value);

    // If "Any" is selected, or nothing is selected, treat as Any
    if (targets.includes('Any') || targets.length === 0) {
        targets = ['Any'];
    }

    if (!player1) {
        showMessage('Please register first', 'error');
        return;
    }

    let secretOptions = null;
    if (checkedVariants.includes('secret')) {
        const queens = parseInt(document.getElementById('offer-secret-queens').value) || 0;
        const kings = parseInt(document.getElementById('offer-secret-kings').value) || 0;
        const elizabeths = parseInt(document.getElementById('offer-secret-elizabeths').value) || 0;

        if (queens + kings + elizabeths === 0) {
            showMessage('You must configure at least 1 secret piece when playing Secret Chess.', 'error');
            return;
        }
        secretOptions = { queens, kings, elizabeths };
    }

    try {
        const response = await fetch(`${API_URL}/api/offers/create`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                player1,
                timeControl,
                increment,
                targets,
                variant,
                startPos,
                cooldown,
                secretOptions
            })
        });

        const data = await response.json();

        if (response.ok) {
            if (data.gameStarted && data.gameId) {
                // Only open tab if game actually started with valid ID
                openGameWindow(`game.html?gameId=${data.gameId}&player=${playerName}`, data.gameId);
                showMessage(data.message, 'success');
            } else if (!data.gameStarted) {
                showMessage('Offer posted! Waiting for opponent...', 'success');
            } else {
                showMessage('Offer created', 'success');
            }
            updateStatus();
        } else {
            showMessage(data.error, 'error');
        }
    } catch (error) {
        showMessage('Error creating offer', 'error');
    }
});

// Start game (Direct)
if (gameForm) {
    gameForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const player1Name = document.getElementById('player1-name').value;
        const player2Name = document.getElementById('player2-name').value;
        const timeControl = document.getElementById('time-control').value;
        const increment = document.getElementById('increment').value;
        const isFreestyle = document.getElementById('freestyle-mode').checked;

        if (player1Name === player2Name) {
            showMessage('Players must be different', 'error');
            return;
        }

        try {
            const response = await fetch(`${API_URL}/api/game/start`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    player1: player1Name,
                    player2: player2Name,
                    timeControl: parseInt(timeControl),
                    increment: parseInt(increment),
                    variant: isFreestyle ? 'freestyle' : 'standard'
                })
            });

            const data = await response.json();

            if (response.ok && data.gameId) {
                openGameWindow(`game.html?gameId=${data.gameId}&player=${player1Name}`, data.gameId);
                const p2Link = `game.html?gameId=${data.gameId}&player=${player2Name}`;
                showMessage(`Game started! Player 1 tab opened. <a href="${p2Link}" target="_blank">Open Player 2 View</a>`, 'success');
            } else if (response.ok) {
                showMessage('Game created but no ID returned', 'error');
            } else {
                showMessage(data.error, 'error');
            }
        } catch (error) {
            showMessage('Error starting game', 'error');
        }
    });
}

// Initialize only after the page has fully loaded
// This prevents the browser from thinking the page is still loading (tab spinner)
window.addEventListener('load', () => {
    updateStatus();
    statusInterval = setInterval(updateStatus, 1000);
});

// Reset tournament handler
if (resetBtn) {
    resetBtn.addEventListener('click', async () => {
        // Confirmation dialog to prevent accidental resets
        if (!confirm('Reset tournament? This will clear all games, reset scores, AND remove all registered players.')) {
            return;
        }

        try {
            const response = await fetch(`${API_URL}/api/reset`, {
                method: 'POST'
            });
            const data = await response.json();

            if (response.ok) {
                showMessage('Tournament reset successfully', 'success');

                // Update status immediately
                updateStatus();
            } else {
                showMessage(data.error || 'Failed to reset tournament', 'error');
            }
        } catch (error) {
            console.error('Error resetting tournament:', error);
            showMessage('Error resetting tournament', 'error');
        }
    });
}

// Format time helper
function formatTime(ms) {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

// Clear Scores button handler
const clearScoresBtn = document.getElementById('clear-scores-btn');
if (clearScoresBtn) {
    clearScoresBtn.addEventListener('click', async () => {
        if (!confirm('Clear all scores to zero? This will keep players registered and the tournament running.')) {
            return;
        }

        try {
            const response = await fetch(`${API_URL}/api/clear-scores`, {
                method: 'POST'
            });
            const data = await response.json();

            if (response.ok) {
                showMessage('Scores cleared! Players are still registered.', 'success');
                updateStatus();
            } else {
                showMessage(data.error || 'Failed to clear scores', 'error');
            }
        } catch (error) {
            console.error('Error clearing scores:', error);
            showMessage('Error clearing scores', 'error');
        }
    });
}

// ==================== Tournament End Celebration ====================

// DOM elements for celebration
const celebrationModal = document.getElementById('celebration-modal');
const celebrationResults = document.getElementById('celebration-results');
const celebrationClose = document.getElementById('celebration-close');
const confettiContainer = document.getElementById('confetti-container');

// Show celebration modal with results
function showCelebration(players) {
    if (!celebrationModal || !celebrationResults) {
        console.error('Celebration modal elements not found');
        return;
    }

    // Sort players by score
    const sortedPlayers = [...players].sort((a, b) => b.score - a.score);

    if (sortedPlayers.length < 2) {
        console.log('Not enough players for celebration');
        return;
    }

    // Build result cards HTML
    let resultsHtml = '';

    // Top 3 players
    const medals = ['🥇', '🥈', '🥉'];
    const positions = ['1st Place - Champion!', '2nd Place - Runner Up', '3rd Place - Bronze'];
    const classes = ['gold', 'silver', 'bronze'];

    for (let i = 0; i < Math.min(3, sortedPlayers.length); i++) {
        const player = sortedPlayers[i];
        const playerType = player.isComputer ? '🤖' : '👤';
        resultsHtml += `
            <div class="result-card ${classes[i]}">
                <span class="result-medal">${medals[i]}</span>
                <div class="result-info">
                    <div class="result-name">${playerType} ${formatPlayerName(player.name)}</div>
                    <div class="result-position">${positions[i]}</div>
                </div>
                <span class="result-score">${formatScore(player.score)}</span>
            </div>
        `;
    }

    // Last place player (only if more than 3 players)
    if (sortedPlayers.length > 3) {
        const lastPlayer = sortedPlayers[sortedPlayers.length - 1];
        const playerType = lastPlayer.isComputer ? '🤖' : '👤';
        resultsHtml += `
            <div class="result-card last-place">
                <span class="result-medal">😢</span>
                <div class="result-info">
                    <div class="result-name">${playerType} ${formatPlayerName(lastPlayer.name)}</div>
                    <div class="result-position">Last Place - Better luck next time!</div>
                </div>
                <span class="result-score">${formatScore(lastPlayer.score)}</span>
            </div>
        `;
    }

    celebrationResults.innerHTML = resultsHtml;

    // Show modal
    celebrationModal.style.display = 'flex';
    setTimeout(() => {
        celebrationModal.classList.add('show');
    }, 10);

    // Create confetti
    createConfetti();

    // Auto-close after 15 seconds
    setTimeout(() => {
        closeCelebration();
    }, 15000);
}

// Create confetti particles
function createConfetti() {
    if (!confettiContainer) return;

    confettiContainer.innerHTML = '';

    const colors = ['gold', 'orange', 'blue', 'green', 'pink', 'purple'];
    const shapes = ['square', 'circle', 'rect'];
    const particleCount = 100;

    for (let i = 0; i < particleCount; i++) {
        const confetti = document.createElement('div');
        confetti.className = `confetti ${colors[Math.floor(Math.random() * colors.length)]} ${shapes[Math.floor(Math.random() * shapes.length)]}`;

        // Random position and animation delay
        confetti.style.left = `${Math.random() * 100}%`;
        confetti.style.animationDelay = `${Math.random() * 2}s`;
        confetti.style.animationDuration = `${3 + Math.random() * 2}s`;

        confettiContainer.appendChild(confetti);
    }

    // Clear confetti after animation
    setTimeout(() => {
        confettiContainer.innerHTML = '';
    }, 6000);
}

// Close celebration modal
function closeCelebration() {
    if (!celebrationModal) return;

    celebrationModal.classList.remove('show');
    setTimeout(() => {
        celebrationModal.style.display = 'none';
    }, 500);
}

// Close button handler
if (celebrationClose) {
    celebrationClose.addEventListener('click', closeCelebration);
}

// Also close on backdrop click
if (celebrationModal) {
    celebrationModal.addEventListener('click', (e) => {
        if (e.target === celebrationModal) {
            closeCelebration();
        }
    });
}

// ================= Auth Logic =================
let authToken = localStorage.getItem('authToken');
let authUsername = localStorage.getItem('authUsername');
let authElo = localStorage.getItem('authElo');
if (authElo === 'null' || authElo === 'undefined') authElo = null;

function updateAuthUI() {
    const loginContainer = document.getElementById('login-form-container');
    const loggedInContainer = document.getElementById('logged-in-container');
    
    if (authToken && authUsername) {
        loginContainer.style.display = 'none';
        loggedInContainer.style.display = 'block';
        document.getElementById('logged-in-username').textContent = authUsername;
        document.getElementById('logged-in-elo').textContent = authElo || '400';
        document.getElementById('account-btn').textContent = `👤 ${authUsername}`;
        
        // Update registration form if not computer
        if (!isComputerCheckbox.checked) {
            playerNameInput.value = authUsername;
            playerNameInput.readOnly = true;
        } else {
            playerNameInput.value = '';
            playerNameInput.readOnly = false;
        }
    } else {
        loginContainer.style.display = 'block';
        loggedInContainer.style.display = 'none';
        document.getElementById('account-btn').textContent = 'Account 👤';
        
        playerNameInput.readOnly = false;
        if (!isComputerCheckbox.checked && playerNameInput.value === authUsername) {
            playerNameInput.value = '';
        }
    }
}

async function handleSignup() {
    const usernameInput = document.getElementById('auth-username');
    const passwordInput = document.getElementById('auth-password');
    const username = usernameInput.value;
    const password = passwordInput.value;
    
    try {
        const res = await fetch('/api/signup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        const data = await res.json();
        if (data.success) {
            authToken = data.token;
            authUsername = data.username;
            authElo = data.elo;
            localStorage.setItem('authToken', authToken);
            localStorage.setItem('authUsername', authUsername);
            localStorage.setItem('authElo', authElo);
            updateAuthUI();
            usernameInput.value = '';
            passwordInput.value = '';
            showMessage('Signup successful!', 'success');
        } else {
            showMessage(data.error || 'Signup failed', 'error');
        }
    } catch (e) {
        console.error(e);
        showMessage('Error connecting to server', 'error');
    }
}

async function handleLogin() {
    const usernameInput = document.getElementById('auth-username');
    const passwordInput = document.getElementById('auth-password');
    const username = usernameInput.value;
    const password = passwordInput.value;
    
    try {
        const browserId = getBrowserId();
        const res = await fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password, browserId })
        });
        const data = await res.json();
        if (data.success) {
            authToken = data.token;
            authUsername = data.username;
            authElo = data.elo;
            localStorage.setItem('authToken', authToken);
            localStorage.setItem('authUsername', authUsername);
            localStorage.setItem('authElo', authElo);
            updateAuthUI();
            usernameInput.value = '';
            passwordInput.value = '';
            showMessage('Login successful!', 'success');
        } else {
            showMessage(data.error || 'Login failed', 'error');
        }
    } catch (e) {
        console.error(e);
        showMessage('Error connecting to server', 'error');
    }
}

async function handleLogout() {
    if (authToken) {
        try {
            await fetch('/api/logout', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${authToken}` }
            });
        } catch (e) {
            console.error('Logout error:', e);
        }
    }
    authToken = null;
    authUsername = null;
    authElo = null;
    localStorage.removeItem('authToken');
    localStorage.removeItem('authUsername');
    localStorage.removeItem('authElo');
    updateAuthUI();
    showMessage('Logged out', 'success');
}

async function openLeaderboard() {
    const modal = document.getElementById('leaderboard-modal');
    const list = document.getElementById('leaderboard-list');
    list.innerHTML = 'Loading...';
    modal.style.display = 'flex';
    
    try {
        const res = await fetch('/api/leaderboard');
        const data = await res.json();
        
        if (data.length === 0) {
            list.innerHTML = '<p style="text-align:center;">No users registered yet.</p>';
            return;
        }
        
        let html = '<table style="width:100%; border-collapse: collapse;">';
        html += '<tr style="border-bottom: 1px solid var(--border-color);"><th style="text-align:left; padding:5px;">Rank</th><th style="text-align:left; padding:5px;">Username</th><th style="text-align:center; padding:5px;">Avg End Pos</th><th style="text-align:right; padding:5px;">Elo</th></tr>';
        
        data.forEach((user, index) => {
            const rowStyle = index % 2 === 0 ? 'background: rgba(0,0,0,0.1);' : '';
            const avgPosText = user.avgEndingPosition !== null ? user.avgEndingPosition.toFixed(1) : '-';
            html += `<tr style="${rowStyle}">
                <td style="padding:5px;">#${index + 1}</td>
                <td style="padding:5px; font-weight:bold;">${user.username}</td>
                <td style="padding:5px; text-align:center;">${avgPosText}</td>
                <td style="padding:5px; text-align:right;">${Math.round(user.elo)}</td>
            </tr>`;
        });
        html += '</table>';
        list.innerHTML = html;
        
    } catch (e) {
        console.error(e);
        list.innerHTML = 'Error loading leaderboard.';
    }
}

function closeLeaderboard() {
    document.getElementById('leaderboard-modal').style.display = 'none';
}

// Call updateAuthUI on load
updateAuthUI();

// Theme Toggle Logic
function initTheme() {
    const savedTheme = localStorage.getItem('theme');
    const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    
    if (savedTheme === 'dark' || (!savedTheme && prefersDark)) {
        document.documentElement.setAttribute('data-theme', 'dark');
    }
    
    const themeBtn = document.getElementById('theme-toggle-btn');
    if (themeBtn) {
        // Remove old listeners to avoid duplicates if initTheme is called twice
        const newBtn = themeBtn.cloneNode(true);
        themeBtn.parentNode.replaceChild(newBtn, themeBtn);
        
        newBtn.addEventListener('click', () => {
            const currentTheme = document.documentElement.getAttribute('data-theme');
            const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
            
            if (newTheme === 'dark') {
                document.documentElement.setAttribute('data-theme', 'dark');
                localStorage.setItem('theme', 'dark');
            } else {
                document.documentElement.removeAttribute('data-theme');
                localStorage.setItem('theme', 'light');
            }
        });
    }
}

// Ensure it runs once the DOM is ready, and also now in case it's already loaded
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initTheme);
} else {
    initTheme();
}

function initSecretCheckboxes() {
    const offerSecretCheckbox = document.getElementById('offer-secret-checkbox');
    const offerSecretOptions = document.getElementById('offer-secret-options');
    if (offerSecretCheckbox && offerSecretOptions) {
        offerSecretCheckbox.addEventListener('change', (e) => {
            offerSecretOptions.style.display = e.target.checked ? 'flex' : 'none';
        });
        offerSecretOptions.style.display = offerSecretCheckbox.checked ? 'flex' : 'none';
    }
}
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initSecretCheckboxes);
} else {
    initSecretCheckboxes();
}
