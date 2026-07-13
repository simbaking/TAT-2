require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { MongoClient } = require('mongodb');

let dbClient;
let db;
let usersCollection;
let sessionsCollection;
let tournamentStateCollection;
let issuesCollection;
const mongoUri = process.env.MONGODB_URI;

async function connectDB() {
    if (!mongoUri) {
        console.error('[DB] No MONGODB_URI found.');
        return false;
    }
    try {
        dbClient = new MongoClient(mongoUri);
        await dbClient.connect();
        db = dbClient.db('chessDB');
        usersCollection = db.collection('users');
        sessionsCollection = db.collection('sessions');
        tournamentStateCollection = db.collection('tournament_state');
        issuesCollection = db.collection('issues');
        console.log('[DB] Connected to MongoDB');
        return true;
    } catch (err) {
        console.error('[DB] Failed to connect to MongoDB', err);
        return false;
    }
}

const express = require('express');
const nodemailer = require('nodemailer');
const path = require('path');
const Tournament = require('./lib/Tournament');
const { ChessGame } = require('./lib/ChessGame');
const ComputerPlayer = require('./lib/ComputerPlayer');
const TournamentAI = require('./lib/TournamentAI');
const GlobalAnalyzer = require('./lib/GlobalAnalyzer');

function getRequiredPlayersForVariant(variant) {
    if (!variant) return 2;
    const v = variant.toLowerCase();
    if (v.includes('4player') || v.includes('four') || v === 'bughouse') return 4;
    if (v.includes('3player') || v.includes('three')) return 3;
    return 2;
}

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

// Store issues in memory as a foolproof fallback
const globalIssues = [];

// Issue Reporting Endpoint
app.post('/api/report-issue', async (req, res) => {
    const { issue } = req.body;
    if (!issue) return res.status(400).json({ error: 'Issue text is required' });

    const issueDoc = {
        action: 'report',
        id: Date.now(),
        date: new Date().toISOString(),
        issue: issue
    };

    if (typeof issuesCollection !== 'undefined' && issuesCollection) {
        issuesCollection.insertOne(issueDoc).catch(e => console.error('Error saving issue to DB', e));
    } else {
        if (typeof globalIssues !== 'undefined') globalIssues.push(`[${new Date().toISOString()}] ${issue}`);
    }

    const webhookUrl = process.env.GOOGLE_SHEETS_WEBHOOK_URL;
    if (webhookUrl) {
        fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(issueDoc)
        }).catch(err => console.error('Error sending issue to Google Sheets webhook:', err));
    } else {
        console.warn('GOOGLE_SHEETS_WEBHOOK_URL is not set. Issue not saved to Google Sheets.');
    }

    try {
        const transporter = nodemailer.createTransport({
            host: 'smtp.gmail.com',
            port: 587,
            secure: false, // upgrade later with STARTTLS
            requireTLS: true,
            auth: {
                user: 'changfourafrica@gmail.com',
                pass: process.env.EMAIL_PASSWORD || 'zbenvnfttszofycj'
            },
            connectionTimeout: 10000, // 10 seconds timeout instead of 60s
            greetingTimeout: 10000,
            socketTimeout: 10000
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
        console.error('Error sending issue report email:', err);
        res.json({ success: true, message: 'Issue reported but email failed.' });
    }
});

// Admin Endpoint to view reported issues directly
app.get('/api/admin/issues', (req, res) => {
    res.setHeader('Content-Type', 'text/html');
    const sheetUrl = process.env.GOOGLE_SHEET_UI_URL || '#';
    res.send(`
        <html>
            <head>
                <title>Admin - Issues</title>
                <style>
                    body { font-family: Arial, sans-serif; padding: 40px; text-align: center; }
                    .btn { display: inline-block; padding: 10px 20px; background-color: #4CAF50; color: white; text-decoration: none; border-radius: 4px; font-weight: bold; }
                    .btn:hover { background-color: #45a049; }
                    p { font-size: 1.2em; color: #555; }
                </style>
            </head>
            <body>
                <h2>Tournament Issues Admin</h2>
                <p>Issues are tracked in MongoDB and synced to Google Sheets!</p>
                <p>You can view them, sort them, and mark them as "Dealt With" directly in the spreadsheet.</p>
                <br/>
                <a href="${sheetUrl}" class="btn" target="_blank">Open Google Sheets Dashboard</a>
            </body>
        </html>
    `);
});

// Admin Endpoint to view reported issues directly
app.get('/api/admin/issues', (req, res) => {
    res.setHeader('Content-Type', 'text/plain');
    if (globalIssues.length > 0) {
        res.send(globalIssues.join('\n\n'));
    } else {
        res.send('No issues reported yet. Submit a new issue on the website and refresh this page!');
    }
});

// Serve static files with standard browser caching
app.use(express.static(path.join(__dirname, 'public'), {
    maxAge: '1d' // Cache files for 1 day to improve load times
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
function createGame(playersArray, timeControlMinutes, incrementSeconds = 0, timeStages = [], variant = 'standard', startPos = 'random', cooldownSeconds = 10, gameId = null, secretOptions = null) {
    // Check if tournament is running before creating game
    if (!tournament.checkIsRunning()) {
        console.warn(`Cannot create game: Tournament is not running`);
        return { success: false, error: 'Tournament is not running' };
    }

    let gamePlayers = [...playersArray]; // Copy to avoid mutating original

    // Logic for New Game vs Restore
    if (!gameId) {
        // NEW GAME: Randomize player order (colors)
        for (let i = gamePlayers.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [gamePlayers[i], gamePlayers[j]] = [gamePlayers[j], gamePlayers[i]];
        }

        // Generate ID
        gameId = `game_${gameIdCounter++}`;

        console.log(`[COLOR] Matchup: original ${playersArray.join(' vs ')} -> randomized ${gamePlayers.join(', ')}`);
    } else {
        // RESTORE: Trust provided players order
        console.log(`[RESTORE] Game ${gameId}: ${gamePlayers.join(', ')}`);
    }

    const tPlayers = gamePlayers.map(name => tournament.getPlayerByName(name));
    if (tPlayers.some(p => !p)) return { success: false, error: 'One or more players not found' };

    // Get ELO ratings
    const elos = tPlayers.map(p => p.getElo());

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
    // Check busy status
    for (const p of tPlayers) {
        if (p.isBusy() && p.getActiveGameId() !== gameId) {
            console.warn(`Cannot create game: ${p.getName()} is busy in ${p.getActiveGameId()}`);
            return { success: false, error: `${p.getName()} is busy` };
        }
    }

    const handleGameEnd = (result) => {
        console.log(`Game ${gameId} ended. Winner: ${result.winner}, Reason: ${result.reason}`);

        const endedPlayers = gamePlayers.map(name => tournament.getPlayerByName(name));

        try {
            if (endedPlayers.every(p => p)) {
                const duration = game.getDuration();
                tournament.recordGameResult(game.players.map(p => p.name), result.winner, duration, game.variant);
            }
        } catch (e) {
            console.error(`Error recording game result for game ${gameId}:`, e);
        } finally {
            endedPlayers.forEach(p => { if (p) p.setBusy(false); });
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
    // Assign colors based on position in randomized array
    const colorNames = ['white', 'black', 'red', 'blue', 'green', 'yellow'];
    const assignedPlayers = gamePlayers.map((name, index) => ({
        name,
        color: colorNames[index] || `color${index}`
    }));

    const playerElosMap = {};
    tPlayers.forEach((p, idx) => {
        playerElosMap[assignedPlayers[idx].color] = p.getElo();
    });

    const game = new ChessGame(
        assignedPlayers,
        gameId,
        timeControlMinutes,
        handleGameEnd, // timeControlOrGameOver
        incrementSeconds,
        timeStages,
        variant,
        startPos,
        cooldownSeconds,
        playerElosMap
    );
    if (secretOptions) {
        game.secretOptions = secretOptions;
    }

    // Set busy state for all human players
    tPlayers.forEach(p => {
        if (!p.isComputerPlayer()) {
            p.setBusy(true);
        }
    });

    game.getTournamentTimeRemaining = () => tournament.getRemainingTime();

    // Use each player's persistent engine (already warm) instead of creating a
    // brand-new ComputerPlayer per game, which would trigger a Stockfish boot delay.
    let hasComputer = false;
    let isAllComputers = true;

    assignedPlayers.forEach((assigned, idx) => {
        const p = tPlayers[idx];
        if (p.isComputerPlayer()) {
            hasComputer = true;
            game.setPlayerType(assigned.color, 'computer', p.getLevel(), p.getEngine());
        } else {
            isAllComputers = false;
        }
        p.setBusy(true, gameId);
    });

    activeGames.set(gameId, game);

    if (hasComputer) {
        console.log(`Starting game ${gameId} (variant: ${variant}, players: ${assignedPlayers.map(p => p.name).join(', ')})`);
        game.startGame();
    }

    saveState(); // Save state after creation

    return { success: true, gameId, isComputerVsComputer: isAllComputers, message: 'Game started' };
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
        if (typeof tournamentStateCollection !== 'undefined' && tournamentStateCollection) {
            tournamentStateCollection.updateOne({ _id: 'stateData' }, { $set: { data: state } }, { upsert: true }).catch(err => console.error('[DB] Failed to save state', err));
        } else {
            fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
        }

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

async function loadState() {
    if (!fs.existsSync(STATE_FILE)) return;

    try {
    let data;
    if (typeof tournamentStateCollection !== 'undefined' && tournamentStateCollection) {
        const doc = await tournamentStateCollection.findOne({ _id: 'stateData' });
        if (doc) data = doc.data;
    }
    if (!data && fs.existsSync(STATE_FILE)) {
        data = JSON.parse(fs.readFileSync(STATE_FILE));
    }
    if (!data) return;
    console.log('[STATE_LOAD] Loading tournament state...');

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
                            tournament.recordGameResult(game.players.map(p => p.name), result.winner, game.getDuration(), game.variant);
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
// loadState();

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
        
        // Handle player eliminations in survival mode
        if (tournament.mode === 'survival') {
            const eliminatedNames = new Set(tournament.players.filter(p => p.eliminated).map(p => p.getName()));
            if (eliminatedNames.size > 0) {
                for (const [gameId, game] of activeGames.entries()) {
                    if (!game.isGameOver) {
                        const hasEliminated = game.players.some(p => eliminatedNames.has(p.name));
                        if (hasEliminated) {
                            console.log(`Ending game ${gameId} because a player was eliminated from survival tournament.`);
                            game.isGameOver = true;
                            // Find surviving players to assign win, or draw if all eliminated
                            const surviving = game.players.filter(p => !eliminatedNames.has(p.name));
                            let winner = null;
                            if (surviving.length === 1) winner = surviving[0].name;
                            if (game.onGameOver) game.onGameOver({ winner, reason: 'tournament_timeout' });
                            if (game.cleanup) game.cleanup();
                            activeGames.delete(gameId);
                        }
                    }
                }
            }
        }

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

    // Start auto-matchmaking
    autoMatchmakingInterval = setInterval(() => {
        try {
            if (!tournament.checkIsRunning()) return;

            const remainingTime = tournament.getRemainingTime();
            const players = tournament.getPlayers();

            // Ensure there are enough players in the tournament to play a game
            if (players.length < 2) return;

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

            // Find idle computers
            const idleComputers = players.filter(p =>
                p.isComputerPlayer() &&
                !p.isBusy() &&
                !gameOffers.some(o => o.acceptedBy && o.acceptedBy.includes(p.getName()))
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
                    const reqPlayers = getRequiredPlayersForVariant(match.variant);
                    if (players.length < reqPlayers) {
                        console.log(`[MATCHMAKING] ${bot.getName()} skipping offer for ${match.variant} - requires ${reqPlayers} players but tournament only has ${players.length}`);
                        continue;
                    }

                    const offer = {
                        id: offerIdCounter++,
                        creator: bot.getName(),
                        acceptedBy: [bot.getName()],
                        requiredPlayers: reqPlayers,
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

                const creator = tournament.getPlayerByName(offer.creator);
                if (!creator || creator.isBusy()) {
                    console.log(`[MATCHMAKING] Removing offer ${offer.id}: creator busy`);
                    gameOffers = gameOffers.filter(o => o.id !== offer.id);
                    continue;
                }

                const validBots = players.filter(p => {
                    if (!p.isComputerPlayer() || p.isBusy() || offer.acceptedBy.includes(p.getName())) return false;
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
                            console.log(`Auto-accept: ${bot.getName()} accepting offer from ${offer.creator}`);
                            
                            offer.acceptedBy.push(bot.getName());
                            
                            if (offer.acceptedBy.length >= offer.requiredPlayers) {
                                const result = createGame(offer.acceptedBy, offer.timeControl, offer.increment, offer.timeStages, offer.variant, offer.startPos, offer.cooldown);
                                if (!result.success) {
                                    console.error(`[MATCHMAKING ERROR] Failed: ${result.error}`);
                                    gameOffers = gameOffers.filter(o => o.id !== offer.id); // clear broken offer
                                    continue;
                                }
                                gameOffers = gameOffers.filter(o => o.id !== offer.id);
                                gameOffers = gameOffers.filter(o => !o.acceptedBy.some(p => offer.acceptedBy.includes(p)));
                            }
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
const SESSIONS_FILE = path.join(__dirname, 'sessions.json');

function loadSessions() {
    try {
        if (fs.existsSync(SESSIONS_FILE)) {
            const data = fs.readFileSync(SESSIONS_FILE, 'utf8');
            activeSessions = JSON.parse(data);
        }
    } catch (err) {
        console.error('Error loading sessions:', err);
    }
}

function saveSessions() {
    try {
        if (typeof sessionsCollection !== 'undefined' && sessionsCollection) {
            sessionsCollection.updateOne({ _id: 'sessionsData' }, { $set: { data: activeSessions } }, { upsert: true }).catch(err => console.error(err));
        } else {
            fs.writeFileSync(SESSIONS_FILE, JSON.stringify(activeSessions, null, 2), 'utf8');
        }
    } catch (err) {
        console.error('Error saving sessions:', err);
    }
}

// Load users
async function loadUsers() {
    try {
        if (typeof usersCollection !== 'undefined' && usersCollection) {
            const usersDoc = await usersCollection.findOne({ _id: 'usersData' });
            if (usersDoc && usersDoc.data) users = usersDoc.data;
            const sessionsDoc = await sessionsCollection.findOne({ _id: 'sessionsData' });
            if (sessionsDoc && sessionsDoc.data) activeSessions = sessionsDoc.data;
            
            let changed = false;
            const now = Date.now();
            for (const username in users) {
                if (now - (users[username].lastLogin || 0) > 90 * 24 * 60 * 60 * 1000) {
                    delete users[username];
                    changed = true;
                }
            }
            if (changed) {
                if (typeof saveUsers === 'function') saveUsers();
            }
            return;
        }
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
        if (typeof usersCollection !== 'undefined' && usersCollection) {
            usersCollection.updateOne({ _id: 'usersData' }, { $set: { data: users } }, { upsert: true }).catch(err => console.error(err));
        } else {
            fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
        }
    } catch (err) {
        console.error('Error saving users:', err);
    }
}
// loadUsers();
loadSessions();

// Clean up old sessions daily
setInterval(() => {
    let changed = false;
    // We don't have expiry on sessions yet, but we could add it.
    // For now, this is just a placeholder or we can implement real cleanup.
}, 86400000);

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
    saveSessions();
    
    res.json({ success: true, token, username: actualUsername, elo: 400 });
});

app.post('/api/login', (req, res) => {
    const { username, password, browserId } = req.body;
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
    
    // Remove previous human player from this browser if any
    if (browserId) {
        const existingPlayer = tournament.getPlayerByBrowserId(browserId);
        if (existingPlayer && !existingPlayer.isComputerPlayer()) {
            tournament.players = tournament.players.filter(p => p !== existingPlayer);
            console.log(`[LOGIN] Removed previous player ${existingPlayer.getName()} for browserId ${browserId}`);
        }
    }
    
    const token = crypto.randomBytes(32).toString('hex');
    activeSessions[token] = actualUsername;
    saveSessions();
    
    res.json({ success: true, token, username: actualUsername, elo: user.elo });
});

app.post('/api/logout', (req, res) => {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.split(' ')[1];
        const username = activeSessions[token];
        if (username) {
            if (typeof tournament !== 'undefined' && tournament.unregisterPlayer) {
                tournament.unregisterPlayer(username);
            }
            if (typeof gameOffers !== 'undefined') {
                gameOffers = gameOffers.filter(o => o.player !== username);
            }
            console.log(`[LOGOUT] Unregistered player ${username} from tournament and removed their game offers`);
        }
        delete activeSessions[token];
        if (typeof saveSessions === 'function') saveSessions();
        else saveUsers();
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

    if (tournament.checkIsRunning() && tournament.mode === 'survival') {
        return res.status(400).json({ error: 'Cannot join a survival tournament that has already started.' });
    }

    let initialElo = null;
    const authHeader = req.headers.authorization;
    let authUsername = null;

    if (!isComputer) {
        if (authHeader && authHeader.startsWith('Bearer ')) {
            const token = authHeader.split(' ')[1];
            authUsername = activeSessions[token];
            if (!authUsername) {
                return res.status(401).json({ error: 'Session expired or invalid. Please log out and log in again.' });
            }
        }
        
        if (authUsername) {
            // Logged in: Ensure they register with their authenticated name
            if (name && name.toLowerCase() !== authUsername.toLowerCase()) {
                return res.status(400).json({ error: 'You can only register as your logged-in username' });
            }
            name = authUsername; // Force the exact case of the registered user
            
            if (users[name]) {
                initialElo = users[name].elo !== null && users[name].elo !== undefined ? users[name].elo : 400;
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
            // Prevent multiple guest registrations from the same browser
            if (browserId) {
                const existingByBrowserId = tournament.getPlayerByBrowserId(browserId);
                if (existingByBrowserId && !existingByBrowserId.isComputerPlayer()) {
                    return res.status(400).json({ 
                        error: `This device is already registered as ${existingByBrowserId.getName()}`,
                        existingPlayer: existingByBrowserId.getName()
                    });
                }
            }
        }
    } else {
        if (!name || name.trim() === '') {
            return res.status(400).json({ error: 'Player name is required' });
        }
    }

    const existing = tournament.getPlayerByName(name);
    if (existing) {
        // If the user is logged in and they are already in the tournament, just sync their client
        if (authUsername && existing.getName().toLowerCase() === authUsername.toLowerCase()) {
            return res.json({ success: true, message: 'Re-synced with existing tournament registration', name: existing.getName() });
        }
        return res.status(400).json({ error: 'Player already exists' });
    }



    if (!isComputer) {
        console.log(`[REGISTER] Human player "${name}" registering from IP: ${clientIP}, browserId: ${browserId} with Elo ${initialElo}`);
    }

    tournament.registerPlayer(name, isComputer || false, level !== undefined ? level : null, browserId || null, clientIP, initialElo);
    console.log(`Player registered: ${name} from IP: ${clientIP}`);
    res.json({ success: true, message: 'Player registered', name: name });
});

// Reset tournament
app.post('/api/reset', (req, res) => {
    // Log who is resetting
    console.log(`[RESET] Request from IP: ${req.ip}, User-Agent: ${req.get('User-Agent')}`);

    tournament.reset();
    activeGames.forEach(game => {
        game.isGameOver = true;
        game.cleanup();
    });
    activeGames.clear();
    gameOffers.length = 0;


    if (tournamentMonitorInterval) { clearInterval(tournamentMonitorInterval); tournamentMonitorInterval = null; }
    if (autoMatchmakingInterval) { clearInterval(autoMatchmakingInterval); autoMatchmakingInterval = null; }
    if (timeoutMonitorInterval) { clearInterval(timeoutMonitorInterval); timeoutMonitorInterval = null; }

    saveState();
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
        player.eliminated = false;
        player.timeLeft = 0;
        player.eliminationPosition = null;
    });

    // Stop running tournament but keep players
    tournament.isRunning = false;
    tournament.startTime = null;
    tournament.durationLimit = 0;
    activeGames.forEach(game => {
        game.isGameOver = true;
        game.cleanup();
    });
    activeGames.clear();
    gameOffers.length = 0;

    if (tournamentMonitorInterval) { clearInterval(tournamentMonitorInterval); tournamentMonitorInterval = null; }
    if (autoMatchmakingInterval) { clearInterval(autoMatchmakingInterval); autoMatchmakingInterval = null; }
    if (timeoutMonitorInterval) { clearInterval(timeoutMonitorInterval); timeoutMonitorInterval = null; }

    saveState();
    console.log('Scores cleared via API, players kept');
    res.json({ success: true, message: 'Scores cleared successfully' });
});

// Start tournament
app.post('/api/start', (req, res) => {
    const { durationMinutes, allowVariants, allowedVariants, hours, minutes, duration, mode, secretOptions } = req.body;

    if (secretOptions) {
        tournament.secretOptions = secretOptions;
    }

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
    const tournamentMode = mode || 'survival';
    tournament.startTournament(durationMs, variantsAllowed, specificVariants, tournamentMode);

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

            // Ensure there are enough players in the tournament to play a game
            if (players.length < 2) return;

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
                !gameOffers.some(o => o.acceptedBy && o.acceptedBy.includes(p.getName()))
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
                    const reqPlayers = getRequiredPlayersForVariant(match.variant);
                    if (players.length < reqPlayers) {
                        console.log(`[MATCHMAKING] ${bot.getName()} skipping offer for ${match.variant} - requires ${reqPlayers} players but tournament only has ${players.length}`);
                        continue;
                    }

                    const offer = {
                        id: offerIdCounter++,
                        creator: bot.getName(),
                        acceptedBy: [bot.getName()],
                        requiredPlayers: reqPlayers,
                        elo: bot.getElo(),
                        timeControl: match.timeControl,
                        increment: match.increment,
                        variant: match.variant || 'standard', // AI strategically selects variant
                        targets: ['Any'], // Open to all, but AI targeted specific opponent in mind
                        timestamp: Date.now(),
                        secretOptions: tournament.secretOptions || { queens: 2, kings: 1, elizabeths: 0 }
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
                    console.log(`[MATCHMAKING] Offer ${offer.id} from ${offer.creator} waiting (${Math.round(offerAge / 1000)}s/${HUMAN_PRIORITY_DELAY / 1000}s)`);
                    continue;
                }

                const creator = tournament.getPlayerByName(offer.creator);
                if (!creator || creator.isBusy()) {
                    console.log(`[MATCHMAKING] Removing offer ${offer.id}: creator ${offer.creator} is busy or not found`);
                    gameOffers = gameOffers.filter(o => o.id !== offer.id);
                    continue;
                }

                // Find computers that can accept this offer
                const validBots = players.filter(p => {
                    // Must be a computer, not busy, and not already in the offer
                    if (!p.isComputerPlayer() || p.isBusy() || offer.acceptedBy.includes(p.getName())) return false;

                    // If offer is targeted, must be the target
                    if (offer.targets && offer.targets.length > 0 && !offer.targets.includes('Any')) {
                        return offer.targets.includes(p.getName());
                    }

                    return true;
                });

                if (Math.random() < 0.1) {
                    console.log(`[MATCHMAKING] Offer ${offer.id} from ${offer.creator}: ${validBots.length} valid bots`);
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
                            console.log(`Auto-accept: ${bot.getName()} accepting offer from ${offer.creator} (Reason: ${evalResult.reason})`);

                            offer.acceptedBy.push(bot.getName());
                            
                            if (offer.acceptedBy.length >= offer.requiredPlayers) {
                                const result = createGame(offer.acceptedBy, offer.timeControl, offer.increment, offer.timeStages, offer.variant, offer.startPos, offer.cooldown, null, offer.secretOptions);
                                if (!result.success) {
                                    console.error(`[MATCHMAKING ERROR] Failed to create game: ${result.error}`);
                                    gameOffers = gameOffers.filter(o => o.id !== offer.id); // clear broken offer
                                    continue; // Try next bot if this failed
                                }

                                // Remove the accepted offer
                                gameOffers = gameOffers.filter(o => o.id !== offer.id);

                                // Remove all other pending offers that contain ANY of these users
                                gameOffers = gameOffers.filter(o => !o.acceptedBy.some(p => offer.acceptedBy.includes(p)));
                            }

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
        elo: p.getElo(),  // All players now have ELO
        eliminated: p.eliminated || false,
        timeLeft: p.timeLeft || 0,
        eliminationPosition: p.eliminationPosition || null
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
            allowedVariants: tournament.allowedVariants,
            mode: tournament.mode
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
    tournament.recordGameResult([player1, player2], winner || null, gameDuration, variant || 'standard');

    res.json({ success: true, message: 'Result recorded' });
});

// Game Offer Routes

// Create a new game offer
app.post('/api/offers/create', (req, res) => {
    const { player1, timeControl, increment, targets, variant, startPos, cooldown, secretOptions } = req.body;

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
        // Player is busy, but maybe they are just waiting in an N-player offer that has been pending for >30s?
        // We will allow creating an offer only if they are not in an active game
        // And if they are in an offer, it must be >30s old.
        // Actually, busy means they are in a game or they just accepted something recently.
        // The prompt says: "players who have accepted should be able to acept other offers and make other offers after they have been waiting for offer with more than two people for 30 sec"
        // Let's implement this logic below.
    }

    const now = Date.now();
    
    // Check if player is in any ACTIVE game (not just an offer)
    let inActiveGame = false;
    for (const game of activeGames.values()) {
        if (!game.isGameOver && game.players.some(p => p.name === player1)) {
            inActiveGame = true;
            break;
        }
    }
    
    if (inActiveGame) {
        return res.status(400).json({ error: 'Player is currently in an active game' });
    }

    // Check if player has pending offers
    const playerOffers = gameOffers.filter(o => o.acceptedBy.includes(player1));
    for (const o of playerOffers) {
        // If they are in an offer that requires 2 players, they can't make new offers.
        // If they are in an N-player offer (N>2) and it's less than 30 seconds old, they can't.
        if (o.requiredPlayers <= 2) {
            return res.status(400).json({ error: 'Player already has a pending 1v1 offer' });
        } else if (now - o.timestamp < 30000) {
            return res.status(400).json({ error: 'Please wait 30 seconds before making another offer while in an N-player lobby' });
        }
    }

    // enforce variant restrictions
    const requestedVariant = variant || 'standard';
    const requestedVariantsList = requestedVariant.split(',');
    for (const v of requestedVariantsList) {
        if (!tournament.allowedVariants.includes(v.trim())) {
            return res.status(400).json({ error: `${v} variant is not allowed in this tournament` });
        }
    }

    // config parse
    const config = parseTimeControl(timeControl, increment);

    let reqPlayers = 2;
    if (requestedVariantsList.includes('4player')) reqPlayers = 4;
    else if (requestedVariantsList.includes('3player_hex')) reqPlayers = 3;

    const offer = {
        id: offerIdCounter++,
        creator: player1, // creator of the offer
        acceptedBy: [player1], // array of players who have joined
        requiredPlayers: reqPlayers,
        elo: player.getElo(),
        timeControl: config.minutes,
        increment: config.increment,
        timeStages: config.stages,
        targets: targets || ['Any'],
        timestamp: now,
        variant: requestedVariant,
        startPos: startPos || 'random',
        cooldown: cooldown || 10,
        secretOptions
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

    if (offer.acceptedBy.includes(player2)) {
        return res.status(400).json({ error: 'You have already accepted this offer' });
    }

    // Check if player2 is allowed
    if (!offer.targets.includes('Any') && !offer.targets.includes(player2)) {
        return res.status(403).json({ error: 'You are not eligible to accept this offer' });
    }

    const acceptor = tournament.getPlayerByName(player2);
    if (!acceptor) {
        return res.status(400).json({ error: 'Player not found' });
    }

    const now = Date.now();
    let inActiveGame = false;
    for (const game of activeGames.values()) {
        if (!game.isGameOver && game.players.some(p => p.name === player2)) {
            inActiveGame = true;
            break;
        }
    }
    if (inActiveGame) {
        return res.status(400).json({ error: 'You are currently in an active game' });
    }

    // We no longer block accepting if they have pending offers, as starting a game cleans them up.

    // Add player to the offer
    offer.acceptedBy.push(player2);
    
    // Check if we have enough players to start the game
    if (offer.acceptedBy.length < offer.requiredPlayers) {
        // Not enough players yet, just return success that they joined the lobby
        return res.json({ success: true, gameStarted: false, message: `Joined lobby (${offer.acceptedBy.length}/${offer.requiredPlayers})` });
    }

    // We have enough players! Start the game.
    console.log(`Creating game: ${offer.acceptedBy.join(' vs ')} (colors randomized by createGame)`);
    const result = createGame(offer.acceptedBy, offer.timeControl, offer.increment, offer.timeStages, offer.variant, offer.startPos, offer.cooldown, null, offer.secretOptions);

    if (!result.success) {
        // If game creation failed, remove the last player so they can try again? Or remove the offer?
        // Let's remove the offer if creation failed fundamentally, to avoid it being stuck.
        gameOffers.splice(offerIndex, 1);
        return res.status(400).json(result);
    }

    // Remove the offer that successfully started
    gameOffers.splice(offerIndex, 1);

    // Remove all other pending offers that contain ANY of these users
    gameOffers = gameOffers.filter(o => !o.acceptedBy.some(p => offer.acceptedBy.includes(p)));

    // Since the format changed, we return the game start payload
    res.json(result);
});

// Chess Game Routes

// Start a new game
app.post('/api/game/start', (req, res) => {
    const { player1, player2, timeControl, increment, variant } = req.body;

    // Config parse
    const config = parseTimeControl(timeControl, increment);

    const result = createGame([player1, player2], config.minutes, config.increment, config.stages, variant || 'standard');

    if (!result.success) {
        return res.status(400).json(result);
    }

    res.json(result);
});

// Send custom action (e.g., Secret Chess setup)
app.post('/api/game/:gameId/action', (req, res) => {
    const { gameId } = req.params;
    const { player, action } = req.body;
    
    const game = activeGames.get(gameId);
    if (!game) return res.status(404).json({ error: 'Game not found' });
    
    const playerObj = game.players.find(p => p.name === player);
    if (!playerObj) return res.status(400).json({ error: 'Player not in game' });

    let handled = false;
    for (const strategy of game.variantStrategies) {
        if (strategy.handleAction && strategy.handleAction(action, playerObj.color)) {
            handled = true;
            break;
        }
    }
    
    if (handled) {
        game.lastMoveTime = Date.now(); // Reset timeout
        // Save state immediately
        saveGameState(game);
        return res.json({ success: true });
    } else {
        return res.status(400).json({ error: 'Action not handled by any variant' });
    }
});

// Get game state
app.get('/api/game/:gameId', (req, res) => {
    const { gameId } = req.params;
    const { player } = req.query;
    const game = activeGames.get(gameId);

    if (!game) {
        return res.status(404).json({ error: 'Game not found' });
    }

    // Check for timeout
    if (!game.isGameOver) {
        game.checkTimeout();
    }

    const gameState = game.getState(player);

    // Inject ELOs
    const p1 = tournament.getPlayerByName(game.player1);
    const p2 = tournament.getPlayerByName(game.player2);

    gameState.player1Elo = p1 ? p1.getElo() : null;
    gameState.player2Elo = p2 ? p2.getElo() : null;

    // Add tournament time remaining
    if (tournament.mode === 'survival' && player) {
        const playerObj = tournament.getPlayerByName(player);
        if (playerObj) {
            const elapsed = Date.now() - tournament.startTime;
            gameState.tournamentTimeRemaining = Math.max(0, tournament.durationLimit + playerObj.score - elapsed);
        } else {
            gameState.tournamentTimeRemaining = tournament.getRemainingTime();
        }
    } else {
        gameState.tournamentTimeRemaining = tournament.getRemainingTime();
    }
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
            player2Elo: state.player2Elo,
            tournamentTimeRemaining: tournament.getRemainingTime(),
            player1TimeLeft: tournament.getPlayerByName(state.player1)?.timeLeft || 0,
            player2TimeLeft: tournament.getPlayerByName(state.player2)?.timeLeft || 0
        };
    });
    res.json({ games, mode: tournament.mode });
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
async function startServer() {
    if (typeof connectDB === 'function') await connectDB();
    if (typeof loadUsers === 'function') await loadUsers();
    if (typeof loadState === 'function') await loadState();

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
}
startServer();

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
