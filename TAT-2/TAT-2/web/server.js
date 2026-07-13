require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const nodemailer = require('nodemailer');
const path = require('path');
const Tournament = require('./lib/Tournament');
const { ChessGame } = require('./lib/ChessGame');
const ComputerPlayer = require('./lib/ComputerPlayer');
const TournamentAI = require('./lib/TournamentAI');
const GlobalAnalyzer = require('./lib/GlobalAnalyzer');

// Global error handlers - prevent crashes from unhandled errors
process.on('uncaughtException', (err) => {
    console.error('[FATAL] Uncaught Exception:', err);
    console.error(err.stack);
    // Save state before potential crash
    try { if (typeof saveState === 'function') saveState(); } catch (e) { /* ignore */ }
    // Don't exit - try to keep running
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('[FATAL] Unhandled Promise Rejection:', reason);
    // Don't exit - try to keep running
});

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());

// Issue Reporting Endpoint
app.post('/api/report-issue', async (req, res) => {
    const { issue } = req.body;
    if (!issue) return res.status(400).json({ error: 'Issue text is required' });

    try {
        const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: {
                user: 'changfourafrica@gmail.com',
                pass: process.env.EMAIL_PASSWORD
            }
        });

        const mailOptions = {
            from: 'changfourafrica@gmail.com',
            to: 'changfourafrica@gmail.com',
            subject: 'chess tournament issue',
            text: `a user of the chess tournament app has had this issue : ${issue}`
        };

        await transporter.sendMail(mailOptions);
        res.json({ success: true, message: 'Issue reported successfully.' });
    } catch (err) {
        console.error('Error sending issue report:', err);
        res.status(500).json({ error: 'Failed to send issue report.' });
    }
});

// Static files with cache-busting headers (prevents browser caching issues)
app.use(express.static(path.join(__dirname, 'public'), {
    etag: false,
    maxAge: 0,
    setHeaders: (res, filePath) => {
        res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.set('Pragma', 'no-cache');
        res.set('Expires', '0');
    }
}));

// Global tournament instance
const tournament = new Tournament();

// Active games storage
const activeGames = new Map();
GlobalAnalyzer.setGamesMap(activeGames);
let gameIdCounter = 1;
let tournamentMonitorInterval = null;
let autoMatchmakingInterval = null;
let timeoutMonitorInterval = null;

// Game offers storage
let gameOffers = [];
let offerIdCounter = 1;

// Tournament AI for strategic decisions
const tournamentAI = new TournamentAI(tournament);

// Human priority delay - computers must wait this long before accepting offers
const HUMAN_PRIORITY_DELAY = 10000; // 10 seconds

// Helper to create and start a game
function createGame(player1Name, player2Name, timeControlMinutes, incrementSeconds = 0, timeStages = [], variant = 'standard', startPos = 'random', cooldownSeconds = 10, gameId = null) {
    // Check if tournament is running before creating game
    if (!tournament.checkIsRunning()) {
        console.warn(`Cannot create game: Tournament is not running`);
        return { success: false, error: 'Tournament is not running' };
    }

    // Logic for New Game vs Restore
    if (!gameId) {
        // NEW GAME: Randomize colors
        const participants = [player1Name, player2Name];
        const whiteIndex = Math.random() < 0.5 ? 0 : 1;
        player1Name = participants[whiteIndex];
        player2Name = participants[1 - whiteIndex];

        // Generate ID
        gameId = `game_${gameIdCounter++}`;

        console.log(`[COLOR] Matchup: ${participants[0]} vs ${participants[1]} -> ${player1Name} (White), ${player2Name} (Black)`);
    } else {
        // RESTORE: Trust provided players order (White, Black)
        // Ensure strictly unique ID if manually provided (or trust caller)
        console.log(`[RESTORE] Game ${gameId}: ${player1Name} (White) vs ${player2Name} (Black)`);
    }

    const p1 = tournament.getPlayerByName(player1Name);
    const p2 = tournament.getPlayerByName(player2Name);

    if (!p1 || !p2) return { success: false, error: 'Player not found' };

    // Get ELO ratings for the players
    const p1Elo = p1.getElo();
    const p2Elo = p2.getElo();

    // Strict Busy Check (skip if restoring?)
    // If restoring, players ARE busy probably.
    // Let's assume if gameId is provided, we skip busy check or handle it.
    // Actually, 'loadState' manages busy flag.
    // So createGame should just proceed.
    // But if we call createGame during restore, we might want to skip this check?
    // Or we expect players to NOT be busy yet because we just loaded them?
    // 'loadState' sets players busy status AFTER creating game? 
    // Or we rely on createGame to set them busy.
    // Ideally, createGame sets them busy.
    // So players should be free before this.
    // NOTE: In `fromJSON`, player busy status is loaded. We might need to clear it before calling createGame?
    // OR, we instantiate ChessGame manually in loadState and don't use createGame?
    // `createGame` does a lot of setup (worker threads, event coding).
    // Better to use `createGame` logic but reused.
    // For now, let's assume players are free when we call this (because we reset them or they are loaded as such).

    // Actually, if loaded from JSON, they might be marked busy=true.
    // We should allow busy players if `gameId` matches their `activeGameId`.
    if (p1.isBusy() && p1.getActiveGameId() !== gameId) {
        console.warn(`Cannot create game: ${p1.getName()} is busy in ${p1.getActiveGameId()}`);
        return { success: false, error: 'Player 1 is busy' };
    }
    if (p2.isBusy() && p2.getActiveGameId() !== gameId) {
        console.warn(`Cannot create game: ${p2.getName()} is busy in ${p2.getActiveGameId()}`);
        return { success: false, error: 'Player 2 is busy' };
    }

    const handleGameEnd = (result) => {
        console.log(`Game ${gameId} ended. Winner: ${result.winner}, Reason: ${result.reason}`);

        const p1End = tournament.getPlayerByName(player1Name);
        const p2End = tournament.getPlayerByName(player2Name);

        try {
            if (p1End && p2End) {
                const duration = game.getDuration();
                tournament.recordGameResult(player1Name, player2Name, result.winner, duration, game.variant);
            }
        } catch (e) {
            console.error(`Error recording game result for game ${gameId}:`, e);
        } finally {
            if (p1End) p1End.setBusy(false);
            if (p2End) p2End.setBusy(false);
            if (game.cleanup) game.cleanup();

            // Delay game deletion to give clients time to see the final game state
            setTimeout(() => {
                activeGames.delete(gameId);
                console.log(`Game ${gameId} removed from active games after delay`);
            }, 30000);

            // Save state immediately after game end
            saveState();
        }
    };

    // If restoring, we might want to pass existing game state?
    // `createGame` creates a NEW ChessGame instance.
    // To restore, we need to inject the state.
    // Or better: `createGame` only for NEW games, and a separate `restoreGame` for loading?
    // `ChessGame.fromJSON` is static factory.
    // So `createGame` is NOT suitable for restoration if we use `fromJSON`.
    // Correct! `createGame` call `new ChessGame(...)`.
    // So `loadState` should use `ChessGame.fromJSON` and then wire up the handler.

    // BUT `createGame` logic for "New Game" needs to stay.
    // So I should REVERT the signature change to `createGame` and leave it for NEW games.
    // And implement `restoreGame` or duplicate the wiring logic in `loadState`.

    // Rewriting createGame to be creating NEW game.
    // Saving state logic is added to handleGameEnd.

    const game = new ChessGame(player1Name, player2Name, gameId, timeControlMinutes, handleGameEnd, incrementSeconds, timeStages, variant, startPos, cooldownSeconds, p1.getElo(), p2.getElo());

    game.getTournamentTimeRemaining = () => tournament.getRemainingTime();

    // Use each player's persistent engine (already warm) instead of creating a
    // brand-new ComputerPlayer per game, which would trigger a Stockfish boot delay.
    if (p1.isComputerPlayer()) game.setPlayerType('white', 'computer', p1.getLevel(), p1.getEngine());
    if (p2.isComputerPlayer()) game.setPlayerType('black', 'computer', p2.getLevel(), p2.getEngine());

    activeGames.set(gameId, game);

    p1.setBusy(true, gameId);
    p2.setBusy(true, gameId);

    const hasComputer = p1.isComputerPlayer() || p2.isComputerPlayer();
    if (hasComputer) {
        console.log(`Starting game ${gameId} (variant: ${variant}, computers: W=${p1.isComputerPlayer()}, B=${p2.isComputerPlayer()})`);
        game.startGame();
    }

    saveState(); // Save state after creation

    const isComputerVsComputer = p1.isComputerPlayer() && p2.isComputerPlayer();
    return { success: true, gameId, isComputerVsComputer, message: 'Game started' };
}

// ================= Persistence Logic =================
const STATE_FILE = path.join(__dirname, 'tournament_state.json');
const STATE_BACKUP_FILE = path.join(__dirname, 'tournament_state.backup.json');
const fs = require('fs');

// Create backup of state file before saving new state
function backupState() {
    try {
        if (fs.existsSync(STATE_FILE)) {
            fs.copyFileSync(STATE_FILE, STATE_BACKUP_FILE);
        }
    } catch (err) {
        console.error('[BACKUP] Failed to backup state:', err.message);
    }
}

function saveState() {
    try {
        // Create backup before saving
        backupState();

        const state = {
            timestamp: Date.now(),
            tournament: tournament.toJSON(),
            activeGames: Array.from(activeGames.values()).map(g => g.toJSON()),
            gameOffers: gameOffers
        };
        fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

        // Persist Elos of human players back to users.json
        let usersChanged = false;
        tournament.getPlayers().forEach(p => {
            if (!p.isComputerPlayer()) {
                const username = Object.keys(users).find(u => u.toLowerCase() === p.getName().toLowerCase());
                if (username) {
                    if (users[username].elo !== p.getElo()) {
                        users[username].elo = p.getElo();
                        usersChanged = true;
                    }
                }
            }
        });
        if (usersChanged) saveUsers();
    } catch (err) {
        console.error('Failed to save state:', err);
    }
}

function loadState() {
    if (!fs.existsSync(STATE_FILE)) return;

    try {
        console.log('[STATE_LOAD] Loading tournament state...');
        const data = JSON.parse(fs.readFileSync(STATE_FILE));

        // Verbose logging for debugging timer issues
        const savedTimestamp = data.timestamp;
        const savedStartTime = data.tournament?.startTime;
        const savedDuration = data.tournament?.durationLimit;
        const savedIsRunning = data.tournament?.isRunning;

        console.log(`[STATE_LOAD] File timestamp: ${new Date(savedTimestamp).toISOString()}`);
        console.log(`[STATE_LOAD] Tournament isRunning: ${savedIsRunning}`);

        if (savedIsRunning && savedStartTime && savedDuration) {
            const elapsed = Date.now() - savedStartTime;
            const remaining = savedDuration - elapsed;
            console.log(`[STATE_LOAD] StartTime: ${new Date(savedStartTime).toISOString()}`);
            console.log(`[STATE_LOAD] Duration limit: ${(savedDuration / 60000).toFixed(1)} minutes`);
            console.log(`[STATE_LOAD] Elapsed since start: ${(elapsed / 60000).toFixed(1)} minutes`);
            console.log(`[STATE_LOAD] Remaining time: ${(remaining / 60000).toFixed(1)} minutes`);

            if (remaining <= 0) {
                console.log(`[STATE_LOAD] WARNING: Tournament time already expired!`);
            }
        }

        // Restore Tournament
        const restoredTournament = Tournament.fromJSON(data.tournament);
        // Copy properties to singleton
        tournament.players = restoredTournament.players;
        tournament.isRunning = restoredTournament.isRunning;
        tournament.startTime = restoredTournament.startTime;
        tournament.durationLimit = restoredTournament.durationLimit;
        tournament.allowVariants = restoredTournament.allowVariants;
        tournament.allowedVariants = restoredTournament.allowedVariants;

        // Restore Offers
        gameOffers = data.gameOffers || [];
        if (gameOffers.length > 0) {
            offerIdCounter = Math.max(...gameOffers.map(o => o.id)) + 1;
        }

        // Restore Active Games
        activeGames.clear();
        if (data.activeGames) {
            for (const gameData of data.activeGames) {
                // Determine handleGameEnd (similar to createGame)
                const handleGameEnd = (result) => {
                    console.log(`Game ${gameData.gameId} ended. Winner: ${result.winner}, Reason: ${result.reason}`);
                    const p1End = tournament.getPlayerByName(gameData.player1);
                    const p2End = tournament.getPlayerByName(gameData.player2);
                    try {
                        if (p1End && p2End) {
                            tournament.recordGameResult(gameData.player1, gameData.player2, result.winner, game.getDuration(), game.variant);
                        }
                    } catch (e) {
                        console.error(`Error recording game result for game ${gameData.gameId}:`, e);
                    } finally {
                        if (p1End) p1End.setBusy(false);
                        if (p2End) p2End.setBusy(false);
                        if (game.cleanup) game.cleanup();

                        // Delay game deletion to give clients time to see the final game state
                        setTimeout(() => {
                            activeGames.delete(gameData.gameId);
                            console.log(`Game ${gameData.gameId} removed from active games after delay`);
                        }, 30000);

                        saveState();
                    }
                };

                const game = ChessGame.fromJSON(gameData, handleGameEnd);
                game.getTournamentTimeRemaining = () => tournament.getRemainingTime();

                // Set Computer Player Instances (done inside fromJSON partially, but verify here?)
                // fromJSON calls setPlayerType, which creates new ComputerPlayer instances.

                if (game.isGameOver) {
                    // Do not add to activeGames or set players busy if game is already completed
                    console.log(`Skipping already completed game ${game.gameId} during restore`);
                    continue;
                }

                activeGames.set(game.gameId, game);

                // Re-bind players
                const p1 = tournament.tournament ? tournament.getPlayerByName(game.player1) : tournament.getPlayerByName(game.player1);
                const p2 = tournament.tournament ? tournament.getPlayerByName(game.player2) : tournament.getPlayerByName(game.player2);
                if (p1) p1.setBusy(true, game.gameId);
                if (p2) p2.setBusy(true, game.gameId);

                // Restart logic?
                // If it was running?
                // We should check if we need to restart engine loops?
                // For KungFu, `startGame` starts loops. For stockfish, it schedules moves.
                // We need `resumeGame`?
                // `startGame` might be safe to call again if checks turn?

                // If computers are involved, we need to kickstart them if needed.
                const hasComputer = (game.whitePlayerType === 'computer' || game.blackPlayerType === 'computer');
                if (hasComputer && !game.isGameOver) {
                    console.log(`Resuming game ${game.gameId} (computers involved)`);
                    game.startGame(); // Schedules next move or starts loop
                }
            }

            if (data.activeGames.length > 0) {
                // Update gameIdCounter
                const maxId = Math.max(...data.activeGames.map(g => parseInt(g.gameId.replace('game_', ''))));
                if (!isNaN(maxId)) gameIdCounter = maxId + 1;
            }
        }

        console.log('State loaded successfully.');
    } catch (err) {
        console.error('Failed to load state:', err);
    }
}

// Load state on startup
loadState();

function recordTournamentResults() {
    const sortedPlayers = tournament.getPlayers().sort((a, b) => b.getElo() - a.getElo());
    let usersChanged = false;
    sortedPlayers.forEach((p, index) => {
        if (!p.isComputerPlayer()) {
            const username = Object.keys(users).find(u => u.toLowerCase() === p.getName().toLowerCase());
            if (username) {
                users[username].totalTournaments = (users[username].totalTournaments || 0) + 1;
                users[username].totalPosition = (users[username].totalPosition || 0) + (index + 1);
                usersChanged = true;
            }
        }
    });
    if (usersChanged) saveUsers();
}

// If tournament was running when we loaded state, restart the monitor intervals
if (tournament.checkIsRunning()) {
    console.log('[STARTUP] Tournament is running, starting monitor intervals...');

    // Start tournament monitor
    tournamentMonitorInterval = setInterval(() => {
        const isRunning = tournament.checkIsRunning();
        const remaining = tournament.getRemainingTime();

        if (Math.random() < 0.05) {
            console.log(`[MONITOR] Running: ${isRunning}, Remaining: ${(remaining / 60000).toFixed(1)}m, ActiveGames: ${activeGames.size}, Offers: ${gameOffers.length}`);
        }

        if (!isRunning) {
            if (gameOffers.length > 0) {
                const clearedOffers = gameOffers.length;
                gameOffers.length = 0;
                console.log(`Cleared ${clearedOffers} pending game offers`);
            }

            if (activeGames.size > 0) {
                console.log('Tournament ended. Terminating all active games...');
                for (const [gameId, game] of activeGames.entries()) {
                    if (!game.isGameOver) {
                        const whiteTime = game.whiteTimeRemaining;
                        const blackTime = game.blackTimeRemaining;
                        let winner = whiteTime > blackTime ? game.player1 : (blackTime > whiteTime ? game.player2 : null);
                        console.log(`Ending game ${gameId}: ${game.player1} vs ${game.player2}. Winner: ${winner || 'Draw'}`);
                        game.isGameOver = true;
                        game.winner = winner;
                        if (game.onGameOver) game.onGameOver({ winner, reason: 'tournament_timeout' });
                    }
                    // Clean up game resources
                    if (game.cleanup) game.cleanup();
                }
                // Clear all games immediately when tournament ends
                activeGames.clear();
                console.log('All active games cleared.');
                recordTournamentResults();
            }

            clearInterval(tournamentMonitorInterval);
            tournamentMonitorInterval = null;
            if (autoMatchmakingInterval) {
                clearInterval(autoMatchmakingInterval);
                autoMatchmakingInterval = null;
            }
        }
    }, 1000);

    function getRequiredPlayersForVariant(variant) {
        if (!variant) return 2;
        const v = variant.toLowerCase();
        if (v.includes('4player') || v.includes('four') || v === 'bughouse') return 4;
        if (v.includes('3player') || v.includes('three')) return 3;
        return 2;
    }

    // Start auto-matchmaking
    autoMatchmakingInterval = setInterval(() => {
        try {
            if (!tournament.checkIsRunning()) return;

            const remainingTime = tournament.getRemainingTime();
            const players = tournament.getPlayers();

            // Self-healing: clear busy state if player is not in any active game
            for (const p of players) {
                if (p.isBusy()) {
                    const activeGameId = p.getActiveGameId();
                    if (!activeGameId || !activeGames.has(activeGameId)) {
                        let gameFound = false;
                        for (const [id, game] of activeGames.entries()) {
                            if (game.player1 === p.getName() || game.player2 === p.getName()) {
                                gameFound = true;
                                break;
                            }
                        }
                        if (!gameFound) {
                            console.log(`[Self-Healing] Clearing stuck busy state for ${p.getName()}`);
                            p.setBusy(false);
                        }
                    }
                }
            }

            // Ensure there are enough players in the tournament to play a game
            if (players.length < 2) return;

            // Find idle computers
            const idleComputers = players.filter(p =>
                p.isComputerPlayer() &&
                !p.isBusy() &&
                !gameOffers.some(o => o.player === p.getName())
            );

            const candidates = players.filter(p => !p.isBusy());

            if (Math.random() < 0.2) {
                console.log(`[Matchmaking] ${idleComputers.length} idle computers, ${gameOffers.length} active offers, ${candidates.length} available players`);
            }

            // Offer creation
            idleComputers.sort(() => Math.random() - 0.5);
            let newOffersCount = 0;
            const MAX_NEW_OFFERS = 3;

            for (const bot of idleComputers) {
                if (newOffersCount >= MAX_NEW_OFFERS) break;
                if (bot.isBusy()) continue;

                // Increase offer creation rate from 30% to 50%
                const shouldCreateOffer = Math.random() <= 0.5;
                if (!shouldCreateOffer) {
                    continue;
                }

                const match = TournamentAI.findBestMatch(bot, candidates, remainingTime, tournament);

                if (match) {
                    const requiredPlayers = getRequiredPlayersForVariant(match.variant);
                    if (players.length < requiredPlayers) {
                        console.log(`[MATCHMAKING] ${bot.getName()} skipping offer for ${match.variant} - requires ${requiredPlayers} players but tournament only has ${players.length}`);
                        continue;
                    }
                    const offer = {
                        id: offerIdCounter++,
                        player: bot.getName(),
                        elo: bot.getElo(),
                        timeControl: match.timeControl,
                        increment: match.increment,
                        variant: match.variant || 'standard',
                        targets: ['Any'],
                        timestamp: Date.now()
                    };

                    console.log(`Auto-offer: ${bot.getName()} offering ${offer.timeControl}m+${offer.increment}s [${offer.variant}]`);
                    gameOffers.push(offer);
                    newOffersCount++;
                } else {
                    console.log(`[MATCHMAKING] ${bot.getName()} failed to find match - candidates: ${candidates.length}, remaining: ${remainingTime}ms`);
                }
            }

            // Offer acceptance
            const now = Date.now();

            if (gameOffers.length > 0) {
                console.log(`[MATCHMAKING] Processing ${gameOffers.length} offers. Computers: ${players.filter(p => p.isComputerPlayer()).map(p => `${p.getName()}(busy=${p.isBusy()})`).join(', ')}`);
            }

            // Iterate over a copy to safely modify the original array
            const currentOffers1 = [...gameOffers];
            for (const offer of currentOffers1) {
                // Skip if already removed
                if (!gameOffers.some(o => o.id === offer.id)) continue;

                const offerAge = now - offer.timestamp;
                if (offerAge < HUMAN_PRIORITY_DELAY) {
                    console.log(`[MATCHMAKING] Offer ${offer.id} from ${offer.player} waiting (${Math.round(offerAge / 1000)}s/${HUMAN_PRIORITY_DELAY / 1000}s)`);
                    continue;
                }

                const creator = tournament.getPlayerByName(offer.player);
                if (!creator || creator.isBusy()) {
                    console.log(`[MATCHMAKING] Removing offer ${offer.id}: creator busy`);
                    gameOffers = gameOffers.filter(o => o.id !== offer.id);
                    continue;
                }

                const validBots = players.filter(p => {
                    if (!p.isComputerPlayer() || p.isBusy() || p.getName() === offer.player) return false;
                    if (offer.targets && offer.targets.length > 0 && !offer.targets.includes('Any')) {
                        return offer.targets.includes(p.getName());
                    }
                    return true;
                });

                console.log(`[MATCHMAKING] Offer ${offer.id} from ${offer.player}: ${validBots.length} valid bots`);

                if (validBots.length > 0) {
                    validBots.sort(() => Math.random() - 0.5);
                    const ai = new TournamentAI(tournament);

                    for (const bot of validBots) {
                        if (bot.isBusy()) continue; // extra safety check
                        const evalResult = ai.evaluateOffer(offer, bot);
                        console.log(`[MATCHMAKING] ${bot.getName()} eval: shouldAccept=${evalResult.shouldAccept}, reason=${evalResult.reason}`);

                        if (evalResult.shouldAccept) {
                            console.log(`Auto-accept: ${bot.getName()} accepting offer from ${offer.player}`);
                            const result = createGame(offer.player, bot.getName(), offer.timeControl, offer.increment, offer.timeStages, offer.variant, offer.startPos, offer.cooldown);
                            if (!result.success) {
                                console.error(`[MATCHMAKING ERROR] Failed: ${result.error}`);
                                continue;
                            }
                            gameOffers = gameOffers.filter(o => o.player !== offer.player && o.player !== bot.getName());
                            break;
                        }
                    }
                }
            }
        } catch (err) {
            console.error('[MATCHMAKING ERROR]', err);
        }
    }, 1000);
}

// Save state on interval
setInterval(saveState, 5000);

// Save on exit
process.on('SIGINT', () => { console.log('Saving state...'); saveState(); process.exit(); });
process.on('SIGTERM', () => { console.log('Saving state...'); saveState(); process.exit(); });


// ================= User Authentication & Management =================
const crypto = require('crypto');
const USERS_FILE = path.join(__dirname, 'users.json');
let users = {};
let activeSessions = {}; // token -> username

// Load users
function loadUsers() {
    try {
        if (fs.existsSync(USERS_FILE)) {
            const data = fs.readFileSync(USERS_FILE, 'utf8');
            users = JSON.parse(data);
            
            // Clean up old accounts (not logged in for 90 days)
            let changed = false;
            const now = Date.now();
            const NINETY_DAYS = 90 * 24 * 60 * 60 * 1000;
            
            for (const username in users) {
                const user = users[username];
                if (now - (user.lastLogin || 0) > NINETY_DAYS) {
                    delete users[username];
                    changed = true;
                }
            }
            if (changed) saveUsers();
        }
    } catch (err) {
        console.error('Error loading users:', err);
    }
}
function saveUsers() {
    try {
        fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
    } catch (err) {
        console.error('Error saving users:', err);
    }
}
loadUsers();

app.post('/api/signup', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password || username.trim() === '') {
        return res.status(400).json({ error: 'Username and password required' });
    }
    const lowerUser = username.trim().toLowerCase();
    
    // Case-insensitive username check
    const existing = Object.keys(users).find(u => u.toLowerCase() === lowerUser);
    if (existing) {
        return res.status(400).json({ error: 'Username already taken' });
    }
    
    const passwordHash = crypto.createHash('sha256').update(password).digest('hex');
    const actualUsername = username.trim();
    users[actualUsername] = {
        passwordHash,
        elo: 400,
        lastLogin: Date.now()
    };
    saveUsers();
    
    // Auto-login
    const token = crypto.randomBytes(32).toString('hex');
    activeSessions[token] = actualUsername;
    
    res.json({ success: true, token, username: actualUsername, elo: 400 });
});

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Missing credentials' });
    
    const lowerUser = username.trim().toLowerCase();
    const actualUsername = Object.keys(users).find(u => u.toLowerCase() === lowerUser);
    
    if (!actualUsername) return res.status(401).json({ error: 'Invalid username or password' });
    
    const user = users[actualUsername];
    const hash = crypto.createHash('sha256').update(password).digest('hex');
    
    if (user.passwordHash !== hash) {
        return res.status(401).json({ error: 'Invalid username or password' });
    }
    
    user.lastLogin = Date.now();
    saveUsers();
    
    const token = crypto.randomBytes(32).toString('hex');
    activeSessions[token] = actualUsername;
    
    res.json({ success: true, token, username: actualUsername, elo: user.elo });
});

app.post('/api/logout', (req, res) => {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.split(' ')[1];
        delete activeSessions[token];
    }
    res.json({ success: true });
});

app.get('/api/leaderboard', (req, res) => {
    const leaderboard = Object.keys(users).map(username => {
        const u = users[username];
        const avgPos = u.totalTournaments ? (u.totalPosition / u.totalTournaments) : null;
        return {
            username,
            elo: u.elo,
            avgEndingPosition: avgPos
        };
    }).sort((a, b) => b.elo - a.elo);
    res.json(leaderboard);
});

// API Routes

// Register a player
app.post('/api/register', (req, res) => {
    let { name, isComputer, level, browserId } = req.body;
    const clientIP = req.ip || req.connection.remoteAddress || 'unknown';
    console.log(`Register request: ${name}, isComputer: ${isComputer}, level: ${level}, IP: ${clientIP}`);

    let initialElo = null;

    if (!isComputer) {
        const authHeader = req.headers.authorization;
        let authUsername = null;
        
        if (authHeader && authHeader.startsWith('Bearer ')) {
            const token = authHeader.split(' ')[1];
            authUsername = activeSessions[token];
        }
        
        if (authUsername) {
            // Logged in: Ensure they register with their authenticated name
            if (name && name.toLowerCase() !== authUsername.toLowerCase()) {
                return res.status(400).json({ error: 'You can only register as your logged-in username' });
            }
            name = authUsername; // Force the exact case of the registered user
            
            if (users[name]) {
                initialElo = users[name].elo;
            }
        } else {
            // Not logged in: Guest player
            if (!name || name.trim() === '') {
                return res.status(400).json({ error: 'Player name is required' });
            }
            // Block if the name belongs to a registered user
            const lowerName = name.trim().toLowerCase();
            const existingUser = Object.keys(users).find(u => u.toLowerCase() === lowerName);
            if (existingUser) {
                return res.status(401).json({ error: 'This name belongs to a registered user. Please log in to use it.' });
            }
        }
    } else {
        if (!name || name.trim() === '') {
            return res.status(400).json({ error: 'Player name is required' });
        }
    }

    const existing = tournament.getPlayerByName(name);
    if (existing) {
        return res.status(400).json({ error: 'Player already exists' });
    }

    // Server-side check: One human player per browser ID
    if (!isComputer && browserId) {
        const existingByBrowserId = tournament.getPlayerByBrowserId(browserId);
        if (existingByBrowserId && !existingByBrowserId.isComputerPlayer()) {
            console.log(`[REGISTER] Rejected: browserId ${browserId} already has human player ${existingByBrowserId.getName()}`);
            return res.status(400).json({
                error: `This device is already registered as ${existingByBrowserId.getName()}`,
                existingPlayer: existingByBrowserId.getName()
            });
        }
    }

    if (!isComputer) {
        console.log(`[REGISTER] Human player "${name}" registering from IP: ${clientIP}, browserId: ${browserId} with Elo ${initialElo}`);
    }

    tournament.registerPlayer(name, isComputer || false, level !== undefined ? level : null, browserId || null, clientIP, initialElo);
    console.log(`Player registered: ${name} from IP: ${clientIP}`);
    res.json({ success: true, message: 'Player registered' });
});

// Reset tournament
app.post('/api/reset', (req, res) => {
    // Log who is resetting
    console.log(`[RESET] Request from IP: ${req.ip}, User-Agent: ${req.get('User-Agent')}`);

    tournament.reset();
    activeGames.forEach(game => game.cleanup());
    activeGames.clear();
    gameOffers.length = 0;


    if (tournamentMonitorInterval) { clearInterval(tournamentMonitorInterval); tournamentMonitorInterval = null; }
    if (autoMatchmakingInterval) { clearInterval(autoMatchmakingInterval); autoMatchmakingInterval = null; }
    if (timeoutMonitorInterval) { clearInterval(timeoutMonitorInterval); timeoutMonitorInterval = null; }

    console.log('Tournament reset via API');
    res.json({ success: true, message: 'Tournament reset successfully' });
});

// Get server info (LAN IPs for sharing)
app.get('/api/server-info', (req, res) => {
    const os = require('os');
    const networkInterfaces = os.networkInterfaces();
    const lanIPs = [];

    for (const interfaceName in networkInterfaces) {
        for (const iface of networkInterfaces[interfaceName]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                lanIPs.push(iface.address);
            }
        }
    }

    res.json({
        port: PORT,
        lanIPs,
        localUrl: `http://localhost:${PORT}`,
        lanUrls: lanIPs.map(ip => `http://${ip}:${PORT}`)
    });
});

// Clear scores only (keep players)
app.post('/api/clear-scores', (req, res) => {
    const players = tournament.getPlayers();
    players.forEach(player => {
        player.score = 0;
    });

    // Stop running tournament but keep players
    tournament.isRunning = false;
    activeGames.forEach(game => game.cleanup());
    activeGames.clear();
    gameOffers.length = 0;

    if (tournamentMonitorInterval) { clearInterval(tournamentMonitorInterval); tournamentMonitorInterval = null; }
    if (autoMatchmakingInterval) { clearInterval(autoMatchmakingInterval); autoMatchmakingInterval = null; }
    if (timeoutMonitorInterval) { clearInterval(timeoutMonitorInterval); timeoutMonitorInterval = null; }

    console.log('Scores cleared via API, players kept');
    res.json({ success: true, message: 'Scores cleared successfully' });
});

// Start tournament
app.post('/api/start', (req, res) => {
    const { durationMinutes, allowVariants, allowedVariants, hours, minutes, duration } = req.body;

    // Normalize duration logic (handle hours/minutes/duration fields)
    let durationMs = 0;
    if (durationMinutes) {
        durationMs = durationMinutes * 60 * 1000;
        console.log(`Start tournament request: ${durationMinutes} minutes`);
    } else if (duration) {
        durationMs = duration * 1000; // Assume seconds if just "duration"
        console.log(`Start tournament request: ${duration} seconds`);
    } else if (hours !== undefined || minutes !== undefined) {
        const h = parseInt(hours || 0);
        const m = parseInt(minutes || 0);
        durationMs = (h * 3600 + m * 60) * 1000;
        console.log(`Start tournament request: ${h}h ${m}m`);
    }

    if (durationMs <= 0) {
        return res.status(400).json({ error: 'Valid duration required' });
    }

    if (tournament.getPlayers().length < 2) {
        return res.status(400).json({ error: 'Need at least 2 players' });
    }

    // Pass allowVariants and specific allowedVariants
    const variantsAllowed = allowVariants !== undefined ? allowVariants : true;
    const specificVariants = allowedVariants || ['standard', 'freestyle', 'kungfu', 'crazyhouse', 'kingofthehill', 'atomic'];
    tournament.startTournament(durationMs, variantsAllowed, specificVariants);

    // Start tournament monitor to end games when tournament expires
    if (tournamentMonitorInterval) { clearInterval(tournamentMonitorInterval); tournamentMonitorInterval = null; }
    if (autoMatchmakingInterval) { clearInterval(autoMatchmakingInterval); autoMatchmakingInterval = null; }

    tournamentMonitorInterval = setInterval(() => {
        const isRunning = tournament.checkIsRunning();
        const remaining = tournament.getRemainingTime();

        // Log status occasionally
        if (Math.random() < 0.05) {
            console.log(`[MONITOR] Running: ${isRunning}, Remaining: ${(remaining / 60000).toFixed(1)}m, ActiveGames: ${activeGames.size}, Offers: ${gameOffers.length}`);
        }


        if (!isRunning) {
            // Clear pending game offers when tournament ends
            if (gameOffers.length > 0) {
                const clearedOffers = gameOffers.length;
                gameOffers.length = 0;
                console.log(`Cleared ${clearedOffers} pending game offers`);
            }

            // Terminate active games
            if (activeGames.size > 0) {
                console.log('Tournament ended. Terminating all active games...');

                for (const [gameId, game] of activeGames.entries()) {
                    if (!game.isGameOver) {
                        const whiteTime = game.whiteTimeRemaining;
                        const blackTime = game.blackTimeRemaining;
                        let winner = whiteTime > blackTime ? game.player1 : (blackTime > whiteTime ? game.player2 : null);

                        console.log(`Ending game ${gameId}: ${game.player1} (${whiteTime}ms) vs ${game.player2} (${blackTime}ms). Winner: ${winner || 'Draw'}`);
                        game.isGameOver = true;
                        game.winner = winner;
                        if (game.onGameOver) game.onGameOver({ winner, reason: 'tournament_timeout' });
                    }
                    // Clean up game resources
                    if (game.cleanup) game.cleanup();
                }
                // Clear all games immediately when tournament ends
                activeGames.clear();
                console.log('All active games cleared.');
                recordTournamentResults();
            }

            clearInterval(tournamentMonitorInterval);
            tournamentMonitorInterval = null;
            if (autoMatchmakingInterval) {
                clearInterval(autoMatchmakingInterval);
                autoMatchmakingInterval = null;
            }
        }
    }, 1000);

    // Timeout Monitor: Check for flagged games every second
    if (timeoutMonitorInterval) clearInterval(timeoutMonitorInterval);
    timeoutMonitorInterval = setInterval(() => {
        try {
            if (activeGames.size > 0) {
                for (const [gameId, game] of activeGames.entries()) {
                    if (!game.isGameOver) {
                        try {
                            game.checkTimeout();
                        } catch (err) {
                            console.error(`[TIMEOUT MONITOR] Error checking timeout for game ${gameId}:`, err);
                        }
                    }
                }
            }
        } catch (e) {
            console.error('[TIMEOUT MONITOR] Global error:', e);
        }
    }, 1000);

    // Auto-matchmaking loop
    autoMatchmakingInterval = setInterval(() => {
        try {
            if (!tournament.checkIsRunning()) return;

            const remainingTime = tournament.getRemainingTime();
            const players = tournament.getPlayers();

            // Self-healing: clear busy state if player is not in any active game
            for (const p of players) {
                if (p.isBusy()) {
                    const activeGameId = p.getActiveGameId();
                    if (!activeGameId || !activeGames.has(activeGameId)) {
                        let gameFound = false;
                        for (const [id, game] of activeGames.entries()) {
                            if (game.player1 === p.getName() || game.player2 === p.getName()) {
                                gameFound = true;
                                break;
                            }
                        }
                        if (!gameFound) {
                            console.log(`[Self-Healing] Clearing stuck busy state for ${p.getName()}`);
                            p.setBusy(false);
                        }
                    }
                }
            }

            // 1. Offer Creation Logic
            // Find idle computers who don't have an active offer
            const idleComputers = players.filter(p =>
                p.isComputerPlayer() &&
                !p.isBusy() &&
                !gameOffers.some(o => o.player === p.getName())
            );

            const candidates = players.filter(p => !p.isBusy());

            // Log matchmaking activity every 10 seconds (every 5th tick)
            if (Math.random() < 0.2) {
                console.log(`[Matchmaking] ${idleComputers.length} idle computers, ${gameOffers.length} active offers, ${candidates.length} available players`);
            }

            // Shuffle to avoid order bias
            idleComputers.sort(() => Math.random() - 0.5);

            // Limit number of new offers per tick to avoid flooding
            let newOffersCount = 0;
            const MAX_NEW_OFFERS = 3;

            for (const bot of idleComputers) {
                if (newOffersCount >= MAX_NEW_OFFERS) break;
                if (bot.isBusy()) continue;

                // 30% chance to create an offer per tick if idle (increased from 10% for more activity)
                const shouldCreateOffer = Math.random() <= 0.3;
                if (!shouldCreateOffer) continue;

                const match = TournamentAI.findBestMatch(bot, candidates, remainingTime, tournament);

                if (match) {
                    // Create offer with AI-selected variant for bonus points
                    const offer = {
                        id: offerIdCounter++,
                        player: bot.getName(),
                        elo: bot.getElo(),
                        timeControl: match.timeControl,
                        increment: match.increment,
                        variant: match.variant || 'standard', // AI strategically selects variant
                        targets: ['Any'], // Open to all, but AI targeted specific opponent in mind
                        timestamp: Date.now()
                    };

                    console.log(`Auto-offer: ${bot.getName()} offering ${offer.timeControl}m+${offer.increment}s [${offer.variant}]`);
                    gameOffers.push(offer);
                    newOffersCount++;
                }
            }

            // 2. Offer Acceptance Logic
            const now = Date.now();

            // Debug: Log offer count
            if (gameOffers.length > 0) {
                console.log(`[MATCHMAKING] Processing ${gameOffers.length} offers. Computers: ${players.filter(p => p.isComputerPlayer()).map(p => `${p.getName()}(busy=${p.isBusy()})`).join(', ')}`);
            }

            // Iterate over a copy to safely modify the original array
            const currentOffers2 = [...gameOffers];
            for (const offer of currentOffers2) {
                // Safety check to ensure it wasn't processed/removed
                if (!gameOffers.some(o => o.id === offer.id)) continue;

                // Human Priority Delay: Computers wait before accepting to give humans a chance
                const offerAge = now - offer.timestamp;
                if (offerAge < HUMAN_PRIORITY_DELAY) {
                    console.log(`[MATCHMAKING] Offer ${offer.id} from ${offer.player} waiting (${Math.round(offerAge / 1000)}s/${HUMAN_PRIORITY_DELAY / 1000}s)`);
                    continue;
                }

                const creator = tournament.getPlayerByName(offer.player);
                if (!creator || creator.isBusy()) {
                    console.log(`[MATCHMAKING] Removing offer ${offer.id}: creator ${offer.player} is busy or not found`);
                    gameOffers = gameOffers.filter(o => o.id !== offer.id);
                    continue;
                }

                // Find computers that can accept this offer
                const validBots = players.filter(p => {
                    // Must be a computer, not busy, and not the offer creator
                    if (!p.isComputerPlayer() || p.isBusy() || p.getName() === offer.player) return false;

                    // If offer is targeted, must be the target
                    if (offer.targets && offer.targets.length > 0 && !offer.targets.includes('Any')) {
                        return offer.targets.includes(p.getName());
                    }

                    return true;
                });

                if (Math.random() < 0.1) {
                    console.log(`[MATCHMAKING] Offer ${offer.id} from ${offer.player}: ${validBots.length} valid bots`);
                }

                if (validBots.length > 0) {
                    // Shuffle available bots
                    validBots.sort(() => Math.random() - 0.5);

                    // Re-instantiate AI to evaluate (lightweight)
                    const ai = new TournamentAI(tournament);

                    for (const bot of validBots) {
                        if (bot.isBusy()) continue; // extra safety check
                        const evalResult = ai.evaluateOffer(offer, bot);
                        // console.log(`[MATCHMAKING] Evaluating ${bot.getName()} for offer from ${offer.player}: shouldAccept=${evalResult.shouldAccept}, reason=${evalResult.reason}`);

                        if (evalResult.shouldAccept) {
                            console.log(`Auto-accept: ${bot.getName()} accepting offer from ${offer.player} (Reason: ${evalResult.reason})`);

                            const result = createGame(offer.player, bot.getName(), offer.timeControl, offer.increment, offer.timeStages, offer.variant, offer.startPos, offer.cooldown);
                            if (!result.success) {
                                console.error(`[MATCHMAKING ERROR] Failed to create game: ${result.error}`);
                                continue; // Try next bot if this failed
                            }

                            // Remove other offers from these players
                            gameOffers = gameOffers.filter(o => o.player !== offer.player && o.player !== bot.getName());

                            break; // Offer taken
                        }
                    }
                }
            }
        } catch (err) {
            console.error('[MATCHMAKING ERROR]', err);
        }
    }, 1000);

    res.json({ success: true, message: 'Tournament started' });
});

// Get tournament status
app.get('/api/status', (req, res) => {
    const isRunning = tournament.checkIsRunning();
    const players = tournament.getPlayers().map(p => ({
        name: p.getName(),
        score: p.getScore(),
        isComputer: p.isComputerPlayer(),
        level: p.getLevel(),
        elo: p.getElo()  // All players now have ELO
    }));

    // Sort by score descending
    players.sort((a, b) => b.score - a.score);

    res.json({
        isRunning,
        remainingTime: tournament.getRemainingTime(),
        startTime: tournament.startTime,
        durationLimit: tournament.durationLimit,
        players,
        offers: gameOffers,
        // Expose current config so UI can sync
        config: {
            durationLimit: tournament.durationLimit,
            allowVariants: tournament.allowVariants,
            allowedVariants: tournament.allowedVariants
        }
    });
});

// Record game result
app.post('/api/result', (req, res) => {
    const { player1, player2, winner, duration, variant } = req.body;

    if (!player1 || !player2) {
        return res.status(400).json({ error: 'Both players required' });
    }

    const p1 = tournament.getPlayerByName(player1);
    const p2 = tournament.getPlayerByName(player2);

    if (!p1 || !p2) {
        return res.status(400).json({ error: 'Player not found' });
    }

    const gameDuration = duration || 60000; // Default 1 minute

    // Use Tournament's recordGameResult for ELO and score multipliers
    tournament.recordGameResult(player1, player2, winner || null, gameDuration, variant || 'standard');

    res.json({ success: true, message: 'Result recorded' });
});

// Game Offer Routes

// Create a new game offer
app.post('/api/offers/create', (req, res) => {
    const { player1, timeControl, increment, targets, variant, startPos, cooldown } = req.body;

    console.log(`[OFFER_CREATE] Received: player1=${player1}, variant=${variant}, startPos=${startPos}`);

    // Check if tournament is running
    if (!tournament.checkIsRunning()) {
        return res.status(400).json({ error: 'Tournament is not running' });
    }

    if (!player1 || !timeControl) {
        return res.status(400).json({ error: 'Player name and time control required' });
    }

    const player = tournament.getPlayerByName(player1);
    if (!player) {
        return res.status(400).json({ error: 'Player not found' });
    }

    if (player.isBusy()) {
        return res.status(400).json({ error: 'Player is currently in a game' });
    }

    if (gameOffers.some(o => o.player === player1)) {
        return res.status(400).json({ error: 'Player already has a pending offer' });
    }

    // enforce variant restrictions - check against specific allowed variants
    const requestedVariant = variant || 'standard';
    if (!tournament.allowedVariants.includes(requestedVariant)) {
        return res.status(400).json({ error: `${requestedVariant} variant is not allowed in this tournament` });
    }

    // config parse
    const config = parseTimeControl(timeControl, increment);

    const offer = {
        id: offerIdCounter++,
        player: player1,
        elo: player.getElo(),
        timeControl: config.minutes,
        increment: config.increment,
        timeStages: config.stages,
        targets: targets || ['Any'],
        timestamp: Date.now(),
        variant: variant || 'standard',
        startPos: startPos || 'random',
        cooldown: cooldown || 10
    };

    gameOffers.push(offer);
    res.json({ success: true, gameStarted: false, offerId: offer.id, message: 'Offer created', offer: offer });
});

// Accept a game offer
app.post('/api/offers/accept', (req, res) => {
    const { offerId, player2 } = req.body; // Renamed playerName to player2

    // Check if tournament is running
    if (!tournament.checkIsRunning()) {
        return res.status(400).json({ error: 'Tournament is not running' });
    }

    const offerIndex = gameOffers.findIndex(o => o.id === parseInt(offerId)); // Used gameOffers and parseInt to match existing structure
    if (offerIndex === -1) {
        return res.status(404).json({ error: 'Offer not found' });
    }

    const offer = gameOffers[offerIndex];

    if (offer.player === player2) { // Used offer.player to match existing structure
        return res.status(400).json({ error: 'Cannot accept your own offer' });
    }

    // Check if player2 is allowed
    if (!offer.targets.includes('Any') && !offer.targets.includes(player2)) {
        return res.status(403).json({ error: 'You are not eligible to accept this offer' });
    }

    const creator = tournament.getPlayerByName(offer.player); // Used offer.player
    const acceptor = tournament.getPlayerByName(player2); // Used player2

    if (!creator || !acceptor) {
        return res.status(400).json({ error: 'Player not found' });
    }

    if (creator.isBusy() || acceptor.isBusy()) {
        return res.status(400).json({ error: 'One or both players are busy' });
    }

    // createGame handles color randomization internally
    console.log(`Creating game: ${offer.player} vs ${player2} (colors randomized by createGame)`);
    const result = createGame(offer.player, player2, offer.timeControl, offer.increment, offer.timeStages, offer.variant, offer.startPos, offer.cooldown);

    // Remove offer
    gameOffers.splice(offerIndex, 1);

    // Remove other offers from these players
    gameOffers = gameOffers.filter(o => o.player !== offer.player && o.player !== player2);

    if (!result.success) {
        return res.status(400).json(result);
    }

    res.json(result);
});

// Chess Game Routes

// Start a new game
app.post('/api/game/start', (req, res) => {
    const { player1, player2, timeControl, increment, variant } = req.body;

    // Config parse
    const config = parseTimeControl(timeControl, increment);

    const result = createGame(player1, player2, config.minutes, config.increment, config.stages, variant || 'standard');

    if (!result.success) {
        return res.status(400).json(result);
    }

    res.json(result);
});

// Get game state
app.get('/api/game/:gameId', (req, res) => {
    const { gameId } = req.params;
    const game = activeGames.get(gameId);

    if (!game) {
        return res.status(404).json({ error: 'Game not found' });
    }

    // Check for timeout
    if (!game.isGameOver) {
        game.checkTimeout();
    }

    const gameState = game.getState();

    // Inject ELOs
    const p1 = tournament.getPlayerByName(game.player1);
    const p2 = tournament.getPlayerByName(game.player2);

    gameState.player1Elo = p1 ? p1.getElo() : null;
    gameState.player2Elo = p2 ? p2.getElo() : null;

    // Add tournament time remaining
    gameState.tournamentTimeRemaining = tournament.getRemainingTime();
    gameState.tournamentIsRunning = tournament.isRunning;

    res.json(gameState);
});

// Get valid moves for a piece
app.get('/api/game/:gameId/valid-moves', (req, res) => {
    const { gameId } = req.params;
    const { x, y } = req.query;

    const game = activeGames.get(gameId);
    if (!game) {
        return res.status(404).json({ error: 'Game not found' });
    }

    const startX = parseInt(x);
    const startY = parseInt(y);

    if (isNaN(startX) || isNaN(startY)) {
        return res.status(400).json({ error: 'Invalid coordinates' });
    }

    const moves = game.getLegalMovesForPiece(startX, startY);
    res.json({ success: true, moves });
});

// Make a move
app.post('/api/game/:gameId/move', (req, res) => {
    const { gameId } = req.params;
    const { startX, startY, endX, endY, player, promotionPiece } = req.body;

    console.log(`Move request for game ${gameId}: ${startX},${startY} -> ${endX},${endY} by ${player} (promo: ${promotionPiece})`);

    const game = activeGames.get(gameId);
    if (!game) {
        return res.status(404).json({ error: 'Game not found' });
    }

    const result = game.makeMove(startX, startY, endX, endY, player, promotionPiece);
    console.log(`Move result:`, result);
    // Scoring is now handled by the callback passed to ChessGame constructor

    // After a successful move, check if it's now a computer's turn
    // Logic moved to ChessGame.js to avoid double scheduling
    if (result.success && !game.isGameOver) {
        // We rely on ChessGame.js to handle computer moves automatically
        // via its internal makeMove -> scheduleNextMove loop
    }

    res.json(result);
});

// Crazyhouse: Drop a piece from reserve
app.post('/api/game/:gameId/drop', (req, res) => {
    const { gameId } = req.params;
    const { pieceType, x, y, player } = req.body;

    console.log(`Drop request for game ${gameId}: ${pieceType} @ ${x},${y} by ${player}`);

    const game = activeGames.get(gameId);
    if (!game) {
        return res.status(404).json({ error: 'Game not found' });
    }

    const result = game.dropPiece(pieceType, x, y, player);
    console.log(`Drop result:`, result);

    res.json(result);
});

// Get valid moves for a piece
app.get('/api/game/:gameId/moves', (req, res) => {
    const { gameId } = req.params;
    const { x, y } = req.query;

    if (x === undefined || y === undefined) {
        return res.status(400).json({ error: 'Missing coordinates' });
    }

    const game = activeGames.get(gameId);
    if (!game) {
        return res.status(404).json({ error: 'Game not found' });
    }

    const moves = game.getValidMoves(parseInt(x), parseInt(y));
    res.json({ moves });
});

// Resign
app.post('/api/game/:gameId/resign', (req, res) => {
    const { gameId } = req.params;
    const { player } = req.body;

    const game = activeGames.get(gameId);
    if (!game) {
        return res.status(404).json({ error: 'Game not found' });
    }

    // Convert player name to color (case-insensitive)
    const color = player.toLowerCase() === game.player1.toLowerCase() ? 'white' : 'black';
    const result = game.resign(color);

    if (!result.success) {
        return res.status(400).json({ error: result.error });
    }

    res.json({ success: true, winner: game.winner });
});

// Offer draw
app.post('/api/game/:gameId/offer-draw', (req, res) => {
    const { gameId } = req.params;
    const { player } = req.body;

    const game = activeGames.get(gameId);
    if (!game) {
        return res.status(404).json({ error: 'Game not found' });
    }

    // Convert player name to color (case-insensitive)
    const color = player.toLowerCase() === game.player1.toLowerCase() ? 'white' : 'black';
    const result = game.offerDraw(color);

    if (!result.success) {
        return res.status(400).json({ error: result.error });
    }

    res.json({ success: true, message: 'Draw offered' });
});

// Accept draw
app.post('/api/game/:gameId/accept-draw', (req, res) => {
    const { gameId } = req.params;

    const game = activeGames.get(gameId);
    if (!game) {
        return res.status(404).json({ error: 'Game not found' });
    }

    const result = game.acceptDraw();

    if (!result.success) {
        return res.status(400).json({ error: result.error });
    }

    res.json({ success: true, message: 'Draw accepted' });
});

// Decline draw
app.post('/api/game/:gameId/decline-draw', (req, res) => {
    const { gameId } = req.params;

    const game = activeGames.get(gameId);
    if (!game) {
        return res.status(404).json({ error: 'Game not found' });
    }

    const result = game.declineDraw();

    if (!result.success) {
        return res.status(400).json({ error: result.error });
    }

    res.json({ success: true, message: 'Draw declined' });
});

// Get list of active games
app.get('/api/games', (req, res) => {
    const games = Array.from(activeGames.values())
        .filter(game => !game.isGameOver) // Hide completed games from the active games list
        .map(game => {
            const state = game.getState();
        return {
            gameId: state.gameId,
            player1: state.player1,
            player2: state.player2,
            isGameOver: state.isGameOver,
            winner: state.winner,
            currentPlayer: state.currentPlayer,
            timeControl: state.timeControl,
            increment: state.increment,
            duration: state.duration,
            variant: state.variant,
            player1Elo: state.player1Elo,
            player2Elo: state.player2Elo
        };
    });
    res.json({ games });
});

// Global Error Handlers to prevent server crash
process.on('uncaughtException', (err) => {
    console.error('CRITICAL: Uncaught Exception:', err);
    // Keep server alive if possible, or restart logic could go here
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('CRITICAL: Unhandled Rejection at:', promise, 'reason:', reason);
});

// Helper to parse time control inputs
function parseTimeControl(input, inputIncrement = 0) {
    if (typeof input === 'string') {
        switch (input.toLowerCase()) {
            case 'classical':
                return { minutes: 120, increment: 30, stages: [{ moves: 40, minutes: 60 }, { moves: 60, minutes: 15 }] };
            case 'uscf':
                return { minutes: 90, increment: 30, stages: [{ moves: 40, minutes: 30 }] };
            case 'g60':
                return { minutes: 60, increment: 0, stages: [] };
            case 'g90':
                return { minutes: 90, increment: 30, stages: [] };
        }
    }
    const minutes = parseFloat(input);
    const inc = parseFloat(inputIncrement);
    return { minutes: isNaN(minutes) ? 10 : minutes, increment: isNaN(inc) ? 0 : inc, stages: [] };
}


// Start server on 0.0.0.0 for LAN access
app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n╔══════════════════════════════════════════════════════════════╗`);
    console.log(`║           Chess Tournament Server Started!                   ║`);
    console.log(`╚══════════════════════════════════════════════════════════════╝`);
    console.log(`\nLocal:    http://localhost:${PORT}`);

    // Get and display LAN IP addresses
    const os = require('os');
    const networkInterfaces = os.networkInterfaces();
    const lanIPs = [];

    for (const interfaceName in networkInterfaces) {
        for (const iface of networkInterfaces[interfaceName]) {
            // Skip internal (loopback) and non-IPv4 addresses
            if (iface.family === 'IPv4' && !iface.internal) {
                lanIPs.push(iface.address);
            }
        }
    }

    if (lanIPs.length > 0) {
        console.log(`\nLAN Access (for other devices on same WiFi):`);
        lanIPs.forEach(ip => {
            console.log(`          http://${ip}:${PORT}`);
        });
        console.log(`\nShare these URLs with other players!`);
    }

    console.log(`\n────────────────────────────────────────────────────────────────`);
});

// Prevent event loop from emptying (Keep-Alive)
setInterval(() => { }, 1000 * 60 * 60); // 1 hour

// Exit logging
process.on('exit', (code) => {
    console.log(`[SERVER EXIT] Process exiting with code: ${code}`);
    require('fs').appendFileSync('server_exit.log', `[${new Date().toISOString()}] Process exited with code ${code}\n`);
});

process.on('beforeExit', (code) => {
    console.log(`[SERVER BEFORE_EXIT] Event loop empty? Code: ${code}`);
    require('fs').appendFileSync('server_exit.log', `[${new Date().toISOString()}] beforeExit (event loop empty) code ${code}\n`);
});
