/**
 * ComputerPlayer - Stockfish integration with intelligent timing
 * 
 * Timing Logic:
 * 1. Think until Stockfish gives consistent move for 1/1000th of remaining time
 * 2. Wait (total thinking time × 10) before making the move
 * 
 * Level -1: Random moves (SimpleEngine)
 * Level 0: Minimax depth 2 (SimpleEngine)
 * Level 1-20: Stockfish with skill level adjustment
 */

const { Worker } = require('worker_threads');
const path = require('path');

class ComputerPlayer {
    constructor(level = 10) {
        this.level = level;
        this.worker = null;
        this.isReady = false;
        this.lastEvaluation = 0;
        this.lastWdl = { w: 0, d: 0, l: 0 };
        this.pendingCallback = null;
        this.moveHistory = [];  // Track recent moves for consistency check
        this.thinkingStartTime = 0;
        this.heartbeatInterval = null;
        this.lastHeartbeat = Date.now();
        this.isTerminating = false;
        this.simpleEngine = null;
        this.chess960Mode = false;  // Chess960 (Freestyle) mode flag

        // Use SimpleEngine for level -1 and -0.5
        if (level === -1 || level === -0.5) {
            const SimpleEngine = require('./SimpleEngine');
            this.simpleEngine = new SimpleEngine();
            this.isReady = true;
        } else {
            // Use Stockfish for levels 0-20
            this.currentWorkerVariant = 'standard';
            // Lazy load worker when actually needed in getBestMove
        }
    }

    static getElo(level) {
        if (level === -1) return 200;
        if (level === -0.5) return 300;
        if (level === 0) return 400;
        if (level === 0.5) return 600;
        // Stockfish levels 1-25 -> ELO 800-3680
        return 800 + (Math.max(1, Math.min(25, level)) - 1) * 120;
    }

    getElo() {
        return ComputerPlayer.getElo(this.level);
    }

    getLastEvaluation() {
        return this.lastEvaluation || 0;
    }

    init(workerVariant = 'standard') {
        this.currentWorkerVariant = workerVariant;
        console.log(`[COMPUTER] Initializing Stockfish level ${this.level} (worker: ${workerVariant})`);

        if (this.worker) {
            this.terminateWorker();
        }

        try {
            const workerScript = workerVariant === 'crazyhouse' ? 'fairy_worker.js' : 'stockfish_worker.js';
            const workerPath = path.join(__dirname, workerScript);
            this.worker = new Worker(workerPath);
            this.lastHeartbeat = Date.now();
            this.isTerminating = false;

            this.worker.on('error', (err) => {
                console.error('[COMPUTER] Worker error:', err.message);
            });

            const myWorker = this.worker;
            this.worker.on('exit', (code) => {
                if (this.worker !== myWorker) return;
                if (code !== 0 && !this.isTerminating) {
                    console.error(`[COMPUTER] Worker exited ${code}, restarting...`);
                    // Safeguard: fire any pending callbacks to prevent the engine from freezing
                    if (this.pendingCallback) {
                        try { this.pendingCallback({ move: null, evaluation: 0 }); } catch (e) { /* ignore */ }
                        this.pendingCallback = null;
                    }
                    if (this.pendingRequest) {
                        try { this.pendingRequest.callback({ move: null, evaluation: 0 }); } catch (e) { /* ignore */ }
                        this.pendingRequest = null;
                    }
                    setTimeout(() => this.init(this.currentWorkerVariant), 1000);
                }
            });

            this.worker.on('message', (msg) => this.handleMessage(msg));

            // Start heartbeat monitor
            this.startHeartbeatMonitor();

        } catch (e) {
            console.error('[COMPUTER] Init error:', e.message);
            // Fallback to SimpleEngine
            const SimpleEngine = require('./SimpleEngine');
            this.simpleEngine = new SimpleEngine();
            this.isReady = true;
        }
    }

    startHeartbeatMonitor() {
        if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
        this.heartbeatInterval = setInterval(() => {
            const elapsed = Date.now() - this.lastHeartbeat;
            if (elapsed > 30000 && !this.isTerminating && (this.pendingCallback || this.isPondering)) {
                console.error('[COMPUTER] Worker stuck, restarting...');
                this.terminateWorker(); // Bug 3 fix: terminateWorker now fires pendingCallback
                setTimeout(() => this.init(this.currentWorkerVariant), 1000);
            }
        }, 10000);
    }

    terminateWorker() {
        this.isTerminating = true;
        if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
        if (this.safetyTimeout) { clearTimeout(this.safetyTimeout); this.safetyTimeout = null; }
        if (this.ponderStopTimeout) { clearTimeout(this.ponderStopTimeout); this.ponderStopTimeout = null; }

        // Bug 3 fix: Fire pending callback so scheduleComputerMove can retry
        if (this.pendingCallback) {
            console.error('[COMPUTER] Worker terminated with pending callback — firing with null move');
            const cb = this.pendingCallback;
            this.pendingCallback = null;
            try { cb({ move: null, evaluation: 0 }); } catch (e) { /* ignore */ }
        }
        // Also handle queued ponder request
        if (this.pendingRequest) {
            console.error('[COMPUTER] Worker terminated with pending ponder request — dropping');
            const req = this.pendingRequest;
            this.pendingRequest = null;
            try { req.callback({ move: null, evaluation: 0 }); } catch (e) { /* ignore */ }
        }

        if (this.worker) {
            this.worker.terminate();
            this.worker = null;
        }
        this.isReady = false;
        this.stoppingPonder = false;
        this.isPondering = false;
    }

    handleMessage(msg) {
        if (!msg) return;

        if (msg.type === 'ready') {
            console.log('[COMPUTER] Stockfish ready');
            // Configure Stockfish
            this.sendCommand('uci');
            this.sendCommand('setoption name UCI_ShowWDL value true');
            this.sendCommand('setoption name Hash value 16');
            this.sendCommand('setoption name Threads value 1');
            setTimeout(() => {
                this.setSkillLevel(this.level);
                this.isReady = true;
            }, 200);
        } else if (msg.type === 'heartbeat') {
            this.lastHeartbeat = Date.now();
        } else if (msg.type === 'stockfish') {
            this.handleStockfishOutput(msg.data);
        }
    }

    handleStockfishOutput(text) {
        if (!text || typeof text !== 'string') return;

        // Parse evaluation
        if (text.startsWith('info') && text.includes('score cp')) {
            const match = text.match(/score cp (-?\d+)/);
            if (match) this.lastEvaluation = parseInt(match[1]);
        }

        // Parse mate score
        if (text.startsWith('info') && text.includes('score mate')) {
            const match = text.match(/score mate (-?\d+)/);
            if (match) {
                this.lastEvaluation = parseInt(match[1]) > 0 ? 10000 : -10000;
            }
        }

        // Parse WDL (Win, Draw, Loss per mille)
        if (text.startsWith('info') && text.includes(' wdl ')) {
            const match = text.match(/ wdl (\d+) (\d+) (\d+)/);
            if (match) {
                this.lastWdl = { w: parseInt(match[1]), d: parseInt(match[2]), l: parseInt(match[3]) };
            }
        }

        if (this.level === 0 && text.startsWith('info') && text.includes('multipv')) {
            const pvMatch = text.match(/ pv (\w+)/);
            let evalScore = 0;
            const cpMatch = text.match(/score cp (-?\d+)/);
            if (cpMatch) evalScore = parseInt(cpMatch[1]);
            const mateMatch = text.match(/score mate (-?\d+)/);
            if (mateMatch) {
                const mateIn = parseInt(mateMatch[1]);
                evalScore = mateIn > 0 ? 10000 - mateIn : -10000 - mateIn;
            }
            if (pvMatch) {
                const move = pvMatch[1];
                if (!this.multiPvEvals) this.multiPvEvals = [];
                const existing = this.multiPvEvals.find(m => m.move === move);
                if (existing) {
                    existing.eval = evalScore;
                } else {
                    this.multiPvEvals.push({ move, eval: evalScore });
                }
            }
        }

        // Track current best move during search - CUMULATIVE TIME tracking
        // Each move accumulates time as "best", first to reach 5x consistency wins
        if (text.startsWith('info') && text.includes(' pv ')) {
            const pvMatch = text.match(/ pv (\w+)/);
            if (pvMatch && this.pendingCallback) {
                const currentMove = pvMatch[1];
                const now = Date.now();

                // Initialize cumulative tracking map if needed
                if (!this.moveTimeAccumulator) {
                    this.moveTimeAccumulator = new Map();
                }

                // Add time to previous best move (if any)
                if (this.currentPvMove && this.pvLastUpdate) {
                    const elapsed = now - this.pvLastUpdate;
                    const prevTime = this.moveTimeAccumulator.get(this.currentPvMove) || 0;
                    this.moveTimeAccumulator.set(this.currentPvMove, prevTime + elapsed);
                }

                // Update current tracking
                this.currentPvMove = currentMove;
                this.pvLastUpdate = now;

                // Check if this move has accumulated enough total time (5x consistency)
                const accumulatedTime = this.moveTimeAccumulator.get(currentMove) || 0;
                const requiredTime = this.currentConsistencyTime * 5;

                if (accumulatedTime >= requiredTime) {
                    console.log(`[COMPUTER] Move ${currentMove} accumulated ${accumulatedTime}ms (need ${requiredTime}ms). Choosing it.`);
                    this.sendCommand('stop');
                }

                // Also check for fast consecutive stability (original behavior)
                if (currentMove === this.lastPvMove) {
                    const stableDuration = now - this.pvStableSince;
                    if (stableDuration >= this.currentConsistencyTime) {
                        console.log(`[COMPUTER] PV stable for ${stableDuration}ms: ${currentMove}. Stopping search.`);
                        this.sendCommand('stop');
                    }
                } else {
                    this.lastPvMove = currentMove;
                    this.pvStableSince = now;
                }

                this.moveHistory.push({ move: currentMove, time: now });
            }
        }

        // Parse bestmove
        if (text.startsWith('bestmove')) {
            const parts = text.split(' ');
            let move = parts[1];

            if (this.level === 0 && this.multiPvEvals && this.multiPvEvals.length > 0) {
                const buckets = {
                    mate: [],
                    high: [],     // 200+
                    medium: [],   // 100 to 200
                    low: [],      // 50 to 100
                    balanced: [], // 0 to 50
                    negative: []  // < 0
                };
                for (const m of this.multiPvEvals) {
                    const val = m.eval;
                    if (val >= 9000 || val <= -9000) buckets.mate.push(m);
                    else if (val >= 200) buckets.high.push(m);
                    else if (val >= 100) buckets.medium.push(m);
                    else if (val >= 50) buckets.low.push(m);
                    else if (val >= 0) buckets.balanced.push(m);
                    else buckets.negative.push(m);
                }
                const candidateBuckets = [];
                if (buckets.balanced.length > 0) candidateBuckets.push(buckets.balanced);
                if (buckets.low.length > 0) candidateBuckets.push(buckets.low);
                if (buckets.medium.length > 0) candidateBuckets.push(buckets.medium);
                if (buckets.high.length > 0) candidateBuckets.push(buckets.high);
                if (buckets.mate.length > 0) candidateBuckets.push(buckets.mate);
                
                if (candidateBuckets.length > 0) {
                    const chosenBucket = candidateBuckets[Math.floor(Math.random() * candidateBuckets.length)];
                    const chosenMove = chosenBucket[Math.floor(Math.random() * chosenBucket.length)];
                    move = chosenMove.move;
                    this.lastEvaluation = chosenMove.eval;
                }
                this.sendCommand('setoption name MultiPV value 1'); // reset
            }

            // Check for ponder move
            const ponderIndex = parts.indexOf('ponder');
            let ponderMove = null;
            if (ponderIndex !== -1 && parts[ponderIndex + 1]) {
                ponderMove = parts[ponderIndex + 1];
            }

            // Ignore bestmove if we are just stopping the ponder search
            if (this.stoppingPonder) {
                console.log('[COMPUTER] Ponder search stopped.');
                this.stoppingPonder = false;
                this.isPondering = false;
                this.clearPonderState();

                // Now that ponder is stopped, we can proceed with the pending request if any
                if (this.pendingRequest) {
                    const req = this.pendingRequest;
                    this.pendingRequest = null;
                    this.getBestMove(req.fen, req.callback, req.remainingTimeMs, req.variant);
                }
                return;
            }

            // Route ponder cycle results (no pending callback means we're pondering)
            if (this.isPondering && !this.pendingCallback) {
                this.handlePonderResult(move, this.lastEvaluation);
                return;
            }

            const thinkingTime = Date.now() - this.thinkingStartTime;

            console.log(`[COMPUTER] Bestmove: ${move}, eval: ${this.lastEvaluation}, took: ${thinkingTime}ms`);

            if (this.pendingCallback) {
                const callback = this.pendingCallback;
                this.pendingCallback = null;

                // Clear safety timeout since we got a bestmove
                if (this.safetyTimeout) { clearTimeout(this.safetyTimeout); this.safetyTimeout = null; }

                console.log(`[COMPUTER] Move '${move}' confirmed after ${thinkingTime}ms. Playing immediately.`);

                // Parse Fairy-Stockfish Crazyhouse drops (e.g. N@e4 or P@e4)
                if (move && move.includes('@')) {
                    const [pieceChar, square] = move.split('@');
                    const charMap = { 'p': 'pawn', 'n': 'knight', 'b': 'bishop', 'r': 'rook', 'q': 'queen' };
                    const pieceType = charMap[pieceChar.toLowerCase()];
                    const x = square.charCodeAt(0) - 97;
                    const y = 8 - parseInt(square[1]);
                    
                    callback({
                        move,
                        evaluation: this.lastEvaluation,
                        wdl: this.lastWdl,
                        isDrop: true,
                        pieceType,
                        x, y
                    });
                } else {
                    callback({ move, evaluation: this.lastEvaluation, wdl: this.lastWdl });
                }

                if (this.pendingRequest) {
                    const req = this.pendingRequest;
                    this.pendingRequest = null;
                    this.getBestMove(req.fen, req.callback, req.remainingTimeMs, req.variant);
                } else {
                    // START MULTI-MOVE PONDERING
                    console.log(`[COMPUTER] Starting multi-move ponder...`);
                    this.startMultiPondering(this.currentFen, move);
                }
            }
        }
    }

    /**
     * Start multi-move pondering: analyze responses to multiple likely opponent moves
     * Time is allocated proportionally to move likelihood (inverse-rank weighting)
     */
    startMultiPondering(fen, myMove) {
        try {
            if (!this.simpleEngine) {
                const SimpleEngine = require('./SimpleEngine');
                this.simpleEngine = new SimpleEngine();
            }

            // Get position after my move (opponent's turn)
            const afterMyMoveFen = this.getPonderFen(fen, myMove);
            this.ponderBaseFen = afterMyMoveFen;

            // Get opponent's legal moves as ponder candidates
            const opponentMoves = this.simpleEngine.getLegalMoves(afterMyMoveFen);
            if (!opponentMoves || opponentMoves.length === 0) {
                console.log('[COMPUTER] No opponent moves to ponder (checkmate/stalemate?)');
                return;
            }

            // Calculate probability weights using inverse-rank^2 
            // Move list is already roughly ordered by SimpleEngine (captures first)
            const weights = opponentMoves.map((_, idx) => 1 / Math.pow(idx + 1, 2));
            const totalWeight = weights.reduce((a, b) => a + b, 0);
            const probabilities = weights.map(w => w / totalWeight);

            // Initialize ponder cache: { oppMove: { myResponse, eval, depth } }
            this.ponderCache = new Map();
            this.ponderCandidates = opponentMoves.slice(0, 8).map((m, i) => ({
                move: m.move,
                probability: probabilities[i] || 0.01,
                timeAllocated: 0,
                bestResponse: null,
                eval: 0
            }));

            console.log(`[COMPUTER] Multi-pondering ${this.ponderCandidates.length} moves: ${this.ponderCandidates.map(c => c.move).join(', ')}`);

            // Start cycling through candidates
            this.isPondering = true;
            this.currentPonderIndex = 0;
            this.ponderCycleTime = 200; // ms per slice
            this.ponderNextCandidate();

        } catch (e) {
            console.error('[COMPUTER] Multi-ponder failed:', e);
        }
    }

    /**
     * Ponder the next candidate move in the cycle
     */
    ponderNextCandidate() {
        if (!this.isPondering || !this.ponderCandidates || this.ponderCandidates.length === 0) {
            return;
        }

        // Find candidate with highest (probability * (1 / (timeAllocated + 1))) to balance exploration
        let bestIdx = 0;
        let bestScore = -1;
        for (let i = 0; i < this.ponderCandidates.length; i++) {
            const c = this.ponderCandidates[i];
            const score = c.probability / (c.timeAllocated + 1);
            if (score > bestScore) {
                bestScore = score;
                bestIdx = i;
            }
        }

        const candidate = this.ponderCandidates[bestIdx];
        this.currentPonderIndex = bestIdx;

        try {
            // Calculate FEN after opponent plays this candidate move
            const afterOppMoveFen = this.getPonderFen(this.ponderBaseFen, candidate.move);

            // Start analysis for this position
            this.ponderingMove = candidate.move;
            this.ponderThinkStart = Date.now();
            this.sendCommand(`position fen ${afterOppMoveFen}`);
            this.sendCommand(`go movetime ${this.ponderCycleTime}`);

        } catch (e) {
            console.error(`[COMPUTER] Failed to ponder ${candidate.move}:`, e);
            // Skip this candidate and try next
            this.ponderCandidates.splice(bestIdx, 1);
            if (this.ponderCandidates.length > 0) {
                this.ponderNextCandidate();
            } else {
                this.isPondering = false;
            }
        }
    }

    /**
     * Handle ponder search result and cycle to next candidate
     */
    handlePonderResult(move, evaluation) {
        const thinkTime = Date.now() - this.ponderThinkStart;
        const candidate = this.ponderCandidates[this.currentPonderIndex];

        if (candidate) {
            candidate.timeAllocated += thinkTime;
            candidate.bestResponse = move;
            candidate.eval = evaluation;

            // Update cache
            this.ponderCache.set(candidate.move, {
                response: move,
                eval: evaluation,
                time: candidate.timeAllocated
            });

            console.log(`[COMPUTER] Ponder ${candidate.move} -> ${move} (${candidate.timeAllocated}ms total)`);
        }

        // Continue cycling if still pondering
        if (this.isPondering) {
            // Small delay to prevent tight loop
            setTimeout(() => this.ponderNextCandidate(), 10);
        }
    }

    /**
     * Check if we have a prepared response for the opponent's move
     * Returns { move, eval } if cached, null otherwise
     */
    checkPonderCache(opponentMove) {
        if (!this.ponderCache) return null;
        const cached = this.ponderCache.get(opponentMove);
        if (cached) {
            console.log(`[COMPUTER] Cache hit for ${opponentMove}: ${cached.response} (${cached.time}ms prep)`);
            return { move: cached.response, evaluation: cached.eval };
        }
        return null;
    }

    /**
     * Clear ponder state
     */
    clearPonderState() {
        this.isPondering = false;
        this.ponderCache = null;
        this.ponderCandidates = null;
        this.ponderBaseFen = null;
    }

    getPonderFen(fen, uciMove) {
        // Use SimpleEngine internals to calculate next FEN
        // This relies on SimpleEngine being available and stateless enough or us resetting it
        // Actually SimpleEngine.parseFEN returns a new Board, so it's safe.
        const { board, isWhiteTurn } = this.simpleEngine.parseFEN(fen);

        const fromFile = uciMove.charCodeAt(0) - 97;
        const fromRank = 8 - parseInt(uciMove[1]);
        const toFile = uciMove.charCodeAt(2) - 97;
        const toRank = 8 - parseInt(uciMove[3]);
        const promo = uciMove.length === 5 ? uciMove[4] : null;

        const moveObj = { startX: fromFile, startY: fromRank, endX: toFile, endY: toRank, promotion: promo };
        const newBoard = this.simpleEngine.makeMove(board, moveObj);
        return newBoard.toFEN(!isWhiteTurn);
    }

    sendCommand(cmd) {
        if (this.worker) {
            this.worker.postMessage(cmd);
        }
    }

    setSkillLevel(level) {
        const skill = Math.max(0, Math.min(20, level));
        this.sendCommand(`setoption name Skill Level value ${skill}`);
    }

    /**
     * Enable or disable Chess960 (Fischer Random) mode
     * Must be called before sending position commands
     */
    setChess960Mode(enabled) {
        this.chess960Mode = enabled;
        const value = enabled ? 'true' : 'false';
        console.log(`[COMPUTER] Setting UCI_Chess960 to ${value}`);
        this.sendCommand(`setoption name UCI_Chess960 value ${value}`);
    }

    /**
     * Map game variant names to UCI_Variant values supported by multi-variant Stockfish
     * Variants supported: chess, atomic, 3check, horde, kingofthehill, racingkings
     */
    getUciVariant(variant) {
        const variantMap = {
            'standard': 'chess',
            'freestyle': 'chess',  // Chess960 is handled via UCI_Chess960 option
            'chess960': 'chess',
            'atomic': 'atomic',
            '3check': '3check',
            'threecheck': '3check',
            'horde': 'horde',
            'kingofthehill': 'kingofthehill',
            'koth': 'kingofthehill',
            'racingkings': 'racingkings',
            'kungfu': 'chess',      // Kung Fu uses standard chess evaluation
            'crazyhouse': 'crazyhouse'
        };
        return variantMap[variant] || 'chess';
    }

    /**
     * Get best move with timing logic:
     * - Think for 1/250th of remaining time until consistent move
     * - Wait thinking_time * 1.0 before returning
     */
    getBestMove(fen, callback, remainingTimeMs = 60000, variant = 'standard') {
        // Switch worker dynamically if needed
        const uciVariant = this.getUciVariant(variant);
        const requiredWorker = ['chess', 'chess960'].includes(uciVariant) ? 'standard' : 'crazyhouse';
        if (this.level > 0 && this.currentWorkerVariant !== requiredWorker) {
            console.log(`[COMPUTER] Switching worker from ${this.currentWorkerVariant} to ${requiredWorker}`);
            this.init(requiredWorker);
            this.pendingRequest = { fen, callback, remainingTimeMs, variant };
            return;
        }

        // Stop pondering if active
        if (this.isPondering) {
            console.log('[COMPUTER] Stopping ponder to start search');
            this.sendCommand('stop');
            this.stoppingPonder = true;
            this.isPondering = false;
            // Queue this request to run after stop completes
            this.pendingRequest = { fen, callback, remainingTimeMs, variant };

            // Bug 2 fix: Timeout for ponder-stop phase — if bestmove never comes, force proceed
            if (this.ponderStopTimeout) clearTimeout(this.ponderStopTimeout);
            this.ponderStopTimeout = setTimeout(() => {
                if (this.stoppingPonder) {
                    console.error('[COMPUTER] Ponder stop timed out after 5s — forcing proceed');
                    this.stoppingPonder = false;
                    this.isPondering = false;
                    this.clearPonderState();
                    if (this.pendingRequest) {
                        const req = this.pendingRequest;
                        this.pendingRequest = null;
                        this.getBestMove(req.fen, req.callback, req.remainingTimeMs, req.variant);
                    }
                }
            }, 5000);
            return;
        }

        // Use SimpleEngine only for level -1 and -0.5
        if (this.simpleEngine && (this.level === -1 || this.level === -0.5)) {
            if (this.level === -1) {
                // Level -1: keep original proportional delay + 1 extra second
                const divisor = (variant === 'kungfu') ? 1000 : 250;
                const thinkDelay = Math.max(100, Math.floor(remainingTimeMs / divisor) * 2) + 1000;

                console.log(`[COMPUTER] Level -1 (random), thinking for ${thinkDelay}ms (base + 1s bonus)`);

                setTimeout(() => {
                    this.simpleEngine.getRandomMove(fen, callback, variant);
                }, thinkDelay);
            } else {
                // Level -0.5: Use SimpleEngine (minimax depth 2, basically material counting)
                const calcStart = Date.now();
                this.simpleEngine.getMinimaxMove(fen, (result) => {
                    const calcTime = Date.now() - calcStart;
                    const MAX_WAIT = 5000; // Cap at 5s to prevent freeze if calc takes too long
                    const waitTime = Math.min(calcTime * 50, MAX_WAIT);

                    console.log(`[COMPUTER] Level -0.5 (minimax), calc took ${calcTime}ms, waiting ${waitTime}ms (50x, capped at ${MAX_WAIT}ms)`);

                    setTimeout(() => {
                        callback(result);
                    }, waitTime);
                }, 2, variant);
            }
            return;
        }

        // Stockfish for level 0+
        if (!this.worker) {
            const isFairy = ['crazyhouse', 'kingofthehill', 'atomic'].includes(variant);
            this.currentWorkerVariant = isFairy ? 'crazyhouse' : 'standard';
            this.init(this.currentWorkerVariant);
        }

        // If the worker isn't ready yet, retry for up to 15s before falling back.
        // This handles the race between game start and async Stockfish initialisation.
        if (!this.isReady) {
            const MAX_WAIT_ATTEMPTS = 150;
            const waitAttempt = (this._waitReadyAttempts || 0) + 1;
            this._waitReadyAttempts = waitAttempt;

            if (waitAttempt <= MAX_WAIT_ATTEMPTS) {
                // Don't log every 100ms to avoid spam, just occasionally
                if (waitAttempt % 10 === 0) {
                    console.log(`[COMPUTER] Not ready yet (attempt ${waitAttempt}/${MAX_WAIT_ATTEMPTS}), retrying in 100ms...`);
                }
                setTimeout(() => this.getBestMove(fen, callback, remainingTimeMs, variant, uciVariant), 100);
            } else {
                // Give up waiting — use SimpleEngine random move as a safe one-time fallback
                this._waitReadyAttempts = 0;
                console.warn('[COMPUTER] Worker never became ready — falling back to random move');
                const SimpleEngine = require('./SimpleEngine');
                const engine = new SimpleEngine();
                engine.getRandomMove(fen, callback, variant);
            }
            return;
        }
        this._waitReadyAttempts = 0;  // Reset counter once ready

        // Check ponder cache - see if we already analyzed a response to this position
        // If found, seed the consistency check with the pondered response (helps reach consensus faster)
        let ponderSeed = null;
        if (this.ponderCache && this.ponderBaseFen) {
            // Find which opponent move led to this FEN
            for (const [oppMove, cached] of this.ponderCache.entries()) {
                try {
                    const afterOppFen = this.getPonderFen(this.ponderBaseFen, oppMove);
                    // Compare board part of FEN (ignore move counters)
                    const fenBoard = fen.split(' ')[0];
                    const afterBoard = afterOppFen.split(' ')[0];
                    if (fenBoard === afterBoard) {
                        console.log(`[COMPUTER] Ponder cache HIT for ${oppMove}! Seeding with ${cached.response}`);
                        ponderSeed = cached.response;
                        break;
                    }
                } catch (e) {
                    // FEN calculation failed, skip this entry
                }
            }
            if (!ponderSeed) {
                console.log('[COMPUTER] Ponder cache MISS - starting fresh search');
            }
        }
        this.clearPonderState();

        // Calculate thinking time
        // Standard: 1/250th of remaining time
        // Kung Fu: 1/1000th (4x faster sampling) to handle real-time pressure
        // No max cap - cumulative tracking handles oscillation prevention
        const divisor = (variant === 'kungfu') ? 1000 : 250;
        const consistencyTime = Math.max(50, Math.floor(remainingTimeMs / divisor));

        // Store for later use in consistency loop
        this.currentConsistencyTime = consistencyTime;
        // Seed consistency check with pondered response (if available) or reset
        this.lastBestMove = ponderSeed;
        this.totalThinkingTime = 0;
        this.currentFen = fen; // Track for pondering

        console.log(`[COMPUTER] Level ${this.level}, remaining: ${remainingTimeMs}ms, consistency: ${consistencyTime}ms`);

        if (this.pendingCallback) {
            console.error('[COMPUTER] Overlapping request! Queuing new request and stopping current search.');
            this.pendingRequest = { fen, callback, remainingTimeMs, variant };
            this.sendCommand('stop');
            return;
        }
        this.pendingCallback = callback;
        this.thinkingStartTime = Date.now();
        this.moveHistory = [];

        // Initialize real-time consistency tracking
        this.currentPvMove = ponderSeed;  // Seed with pondered move if available
        this.pvStableSince = Date.now();
        this.lastPvMove = ponderSeed;
        this.pvLastUpdate = Date.now();
        this.moveTimeAccumulator = new Map();  // Reset cumulative tracking for new search

        // Set UCI_Variant for multi-variant stockfish (atomic, horde, etc.)
        // Must be set BEFORE sending the position
        // Must be set BEFORE sending the position
        if (this.currentUciVariant !== uciVariant) {
            if (uciVariant !== 'chess') {
                console.log(`[COMPUTER] Setting UCI_Variant to ${uciVariant}`);
            }
            this.sendCommand(`setoption name UCI_Variant value ${uciVariant}`);
            this.sendCommand('ucinewgame');
            this.currentUciVariant = uciVariant;
        }

        // Send position and start search
        this.sendCommand(`position fen ${fen}`);
        if (this.level === 0.5) {
            this.sendCommand('go depth 1');
        } else if (this.level === -0.5) {
            this.multiPvEvals = [];
            this.sendCommand('setoption name MultiPV value 200');
            this.sendCommand('go depth 1');
        } else {
            this.sendCommand('go infinite');
        }

        // Bug 1 fix: Safety timeout — if Stockfish never responds (e.g. checkmate position),
        // fire the callback with null after 15s so scheduleComputerMove can retry
        if (this.safetyTimeout) clearTimeout(this.safetyTimeout);
        this.safetyTimeout = setTimeout(() => {
            if (this.pendingCallback) {
                console.error('[COMPUTER] Safety timeout: no bestmove in 15s — firing callback with null');
                this.sendCommand('stop');
                const cb = this.pendingCallback;
                this.pendingCallback = null;
                try { cb({ move: null, evaluation: 0 }); } catch (e) { /* ignore */ }
            }
        }, 15000);
    }

    /**
     * Crazyhouse: Get best move including drops
     * Uses SimpleEngine which understands drops
     * @param {string} fen - Board FEN
     * @param {Array} reserve - Current player's reserve pieces
     * @param {Function} callback - Callback with result
     * @param {number} remainingTimeMs - Optional remaining time
     */
    getCrazyhouseMove(fen, reserve, callback, remainingTimeMs = 60000) {
        if (this.level <= 0) {
            if (!this.simpleEngine) {
                const SimpleEngine = require('./SimpleEngine');
                this.simpleEngine = new SimpleEngine();
            }
            // Add a small delay for level 0 to simulate thinking
            setTimeout(() => {
                this.simpleEngine.getCrazyhouseMove(fen, reserve, callback, this.level);
            }, 500);
            return;
        }

        // For level > 0, delegate to Fairy-Stockfish!
        this.getBestMove(fen, callback, remainingTimeMs, 'crazyhouse');
    }

    quit() {
        this.terminateWorker();
    }

    terminateProcess() {
        this.terminateWorker();
    }

    /**
     * Reset all per-game state so this engine can be safely reused for a new game.
     * Does NOT terminate the worker — the Stockfish thread stays alive and warm.
     */
    resetForNewGame() {
        // Stop any ongoing search or ponder
        if (this.isPondering || this.pendingCallback) {
            this.sendCommand('stop');
        }
        this.clearPonderState();
        this.pendingCallback = null;
        this.pendingRequest = null;
        this.moveHistory = [];
        this.thinkingStartTime = 0;
        this.lastEvaluation = 0;
        this.currentPvMove = null;
        this.lastPvMove = null;
        this.pvStableSince = 0;
        this.pvLastUpdate = 0;
        this.moveTimeAccumulator = null;
        this.currentConsistencyTime = 0;
        this.currentFen = null;
        this._waitReadyAttempts = 0;
        if (this.safetyTimeout) { clearTimeout(this.safetyTimeout); this.safetyTimeout = null; }
        if (this.ponderStopTimeout) { clearTimeout(this.ponderStopTimeout); this.ponderStopTimeout = null; }
        console.log('[COMPUTER] Engine reset for new game — worker remains alive');
    }
}

module.exports = ComputerPlayer;
