// Get game ID from URL
const urlParams = new URLSearchParams(window.location.search);
const gameId = urlParams.get('gameId') || urlParams.get('id');
const currentPlayerName = urlParams.get('player') || localStorage.getItem('chess_tournament_player_name') || "Spectator";

if (!gameId) {
    console.error('Missing gameId, redirecting to index');
    window.location.href = 'index.html';
}

// DOM elements
const chessboard = document.getElementById('chessboard');
const whitePlayerName = document.getElementById('white-player-name');
const blackPlayerName = document.getElementById('black-player-name');
const whiteTimer = document.getElementById('white-timer');
const blackTimer = document.getElementById('black-timer');
const turnIndicator = document.getElementById('turn-indicator');
const resignBtn = document.getElementById('resign-btn');
const drawBtn = document.getElementById('draw-btn');
const gameOverCard = document.getElementById('game-over-card');
const gameResult = document.getElementById('game-result');
const returnBtn = document.getElementById('return-btn');
const flipBtn = document.getElementById('flip-btn');
const messageDiv = document.getElementById('message');
const drawOfferCard = document.getElementById('draw-offer-card');
const drawOfferText = document.getElementById('draw-offer-text');
const acceptDrawBtn = document.getElementById('accept-draw-btn');
const declineDrawBtn = document.getElementById('decline-draw-btn');

let gameState = null;
let selectedSquare = null;
let validMoves = []; // Store valid moves for selected piece
let updateInterval = null;
let timerInterval = null;
let lastTickTime = Date.now();
let isFlipped = false;
let hasAutoFlipped = false;
let pendingMove = null;
let selectedDropPiece = null;
let previousBoardState = null; // For diffing - only update changed squares
let boardInitialized = false; // Track if board DOM has been built
let gameEnded = false; // Track if game over is being handled

// History navigation state
let historyViewIndex = -1; // -1 means viewing current position, 0+ means viewing move at that index
let boardHistory = []; // Array of board states for each move

// BroadcastChannel for notifying tournament tab when game closes
const gameChannel = new BroadcastChannel('chess_games');

// Notify tournament tab when this tab is closed (manually or otherwise)
window.addEventListener('beforeunload', () => {
    gameChannel.postMessage({ type: 'GAME_CLOSED', gameId: gameId });
});

// Touch drag state for mobile
let touchDragState = null; // { startX, startY, pieceEl, ghostEl }

// Helper to prevent rapid layout thrashing from innerHTML assignments
function safeUpdateHtml(el, newHtml) {
    if (!el) return;
    if (el._lastHtml !== newHtml) {
        el.innerHTML = newHtml;
        el._lastHtml = newHtml;
    }
}

// Get variant badge HTML
function getVariantBadge(variant) {
    if (!variant || variant === 'standard') {
        return '';
    }

    const badges = {
        'freestyle': { text: '♟️ 960', color: '#3b82f6' },
        'kungfu': { text: '⚡ Kung Fu', color: '#ff4500' },
        'crazyhouse': { text: '🏠 Crazy', color: '#9333ea' },
        'kingofthehill': { text: '⛰️ KOTH', color: '#22c55e' }
    };

    const badge = badges[variant] || { text: variant, color: '#666' };
    return `<span class="variant-badge" style="display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 0.75rem; font-weight: 600; background: ${badge.color}; color: white; margin-left: 5px;">${badge.text}</span>`;
}

// Promotion dialog handling
const promotionDialog = document.getElementById('promotion-dialog');
document.querySelectorAll('.promo-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const piece = btn.dataset.piece;
        if (pendingMove) {
            makeMove(pendingMove.startX, pendingMove.startY, pendingMove.endX, pendingMove.endY, piece);
            pendingMove = null;
            promotionDialog.classList.remove('show');
        }
    });
});

// Show message
function showMessage(text, type = 'success') {
    messageDiv.textContent = text;
    messageDiv.className = `message ${type} show`;
    setTimeout(() => {
        messageDiv.classList.remove('show');
    }, 3000);
}

let isFetchingState = false;

// Fetch game state
async function updateGameState() {
    if (isFetchingState) return;
    isFetchingState = true;
    try {
        const response = await fetch(`/api/game/${gameId}?player=${encodeURIComponent(playerName)}`);
        if (!response.ok) {
            console.error('[GAME] Failed to fetch game state:', response.status);
            // Game was likely terminated server-side (tournament ended)
            // Treat this as game over: close tab and return to tournament
            if (!gameEnded) {
                gameEnded = true;
                clearInterval(updateInterval);
                clearInterval(timerInterval);
                showMessage('Game ended - returning to tournament', 'info');

                // Notify tournament tab and close
                gameChannel.postMessage({ type: 'GAME_CLOSED', gameId: gameId });
                setTimeout(() => {
                    // window.close() often fails if script didn't open window
                    window.location.href = 'index.html';
                }, 1500);
            }
            return;
        }

        gameState = await response.json();

        // Debug: Log variant and board setup
        console.log('[GAME] Variant:', gameState.variant, 'StartPosId:', gameState.startPosId);
        if (gameState.board && gameState.board[0] && gameState.board[0][7]) {
            const whiteRank = [];
            for (let x = 0; x < 8; x++) {
                whiteRank.push(gameState.board[x][7]?.type || 'empty');
            }
            console.log('[GAME] White back rank (y=7):', whiteRank.join(', '));
        }

        // Track move count to detect new moves
        const previousMoveCount = window.lastMoveCount || 0;
        const currentMoveCount = gameState.moveHistory ? gameState.moveHistory.length : 0;
        if (currentMoveCount > previousMoveCount) {
            console.log(`New move detected! Move count: ${previousMoveCount} -> ${currentMoveCount}`);
            console.log(`Current turn: ${gameState.currentPlayer}`);
        }
        window.lastMoveCount = currentMoveCount;

        // Auto-flip board if playing as Black
        if (!hasAutoFlipped && gameState) {
            const isPlayer1 = currentPlayerName.toLowerCase() === gameState.player1.toLowerCase();
            const isPlayer2 = currentPlayerName.toLowerCase() === gameState.player2.toLowerCase();

            if (isPlayer2) {
                isFlipped = true;
                updateBoardOrientation();
            }
            hasAutoFlipped = true;
        }

        // Adjust polling for Kung Fu Chess
        if (gameState.variant === 'kungfu' && (!window.fastPollingEnabled)) {
            console.log('Kung Fu Chess detected: Switching to fast polling (100ms)');
            clearInterval(updateInterval);
            updateInterval = setInterval(updateGameState, 100);
            window.fastPollingEnabled = true;
        }

        // Only restart the client-side timer when the active side changes.
        // Restarting every poll causes a stutter/flicker in the timer display.
        const newActiveSide = gameState.isWhiteTurn ? 'white' : 'black';
        if (newActiveSide !== window._lastActiveSide || !timerInterval) {
            window._lastActiveSide = newActiveSide;
            startClientTimer();
        }

        renderGame();

        // Fetch tournament status for timer
        updateTournamentTimer();
    } catch (error) {
        console.error('Error fetching game state:', error);
        // Don't stop polling - just log the error and continue
        // The next poll will try again
    } finally {
        isFetchingState = false;
    }
}

// Render the game
function renderGame() {
    // Update player names
    const p1You = (currentPlayerName && gameState.player1 && gameState.player1.toLowerCase() === currentPlayerName.toLowerCase()) ? ' (You)' : '';
    const p2You = (currentPlayerName && gameState.player2 && gameState.player2.toLowerCase() === currentPlayerName.toLowerCase()) ? ' (You)' : '';

    whitePlayerName.textContent = gameState.player1 + (gameState.player1Elo ? ` (${Math.round(gameState.player1Elo)})` : '') + p1You;
    blackPlayerName.textContent = gameState.player2 + (gameState.player2Elo ? ` (${Math.round(gameState.player2Elo)})` : '') + p2You;

    // Update variant badge (only when variant actually changes to avoid reflow)
    const variantBadgeEl = document.getElementById('game-variant-badge');
    if (variantBadgeEl) {
        const newBadge = getVariantBadge(gameState.variant);
        safeUpdateHtml(variantBadgeEl, newBadge);
    }

    // Kung Fu Chess: Hide timers and update turn indicator
    const isKungFu = gameState.variant === 'kungfu';

    if (isKungFu) {
        // Hide timer displays for Kung Fu
        document.querySelectorAll('.timer-display').forEach(el => el.style.display = 'none');
        turnIndicator.textContent = '⚡ Kung Fu Chess - Move Anytime!';
        turnIndicator.classList.remove('time-scramble');
    } else {
        // Show timers for other variants
        document.querySelectorAll('.timer-display').forEach(el => el.style.display = '');
        // Update turn indicator
        const activeTimeMs = gameState.isWhiteTurn ? gameState.whiteTimeRemaining : gameState.blackTimeRemaining;
        const isTimeScramble = activeTimeMs < 180000; // < 3 minutes
        if (isTimeScramble) {
            turnIndicator.textContent = `⚠️ ${gameState.currentPlayer}'s Turn – Time Scramble!`;
            turnIndicator.classList.add('time-scramble');
        } else {
            turnIndicator.textContent = `${gameState.currentPlayer}'s Turn`;
            turnIndicator.classList.remove('time-scramble');
        }
    }

    // Highlight active player (not for Kung Fu since both can move)
    document.querySelectorAll('.player').forEach(p => {
        p.classList.remove('active');
        p.classList.remove('time-scramble');
    });
    if (!isKungFu) {
        const activeTimeMs = gameState.isWhiteTurn ? gameState.whiteTimeRemaining : gameState.blackTimeRemaining;
        const isTimeScramble = activeTimeMs < 180000;
        if (gameState.isWhiteTurn) {
            const whitePlayerEl = document.querySelector('.white-player');
            if (whitePlayerEl) {
                whitePlayerEl.classList.add('active');
                if (isTimeScramble) whitePlayerEl.classList.add('time-scramble');
            }
        } else {
            const blackPlayerEl = document.querySelector('.black-player');
            if (blackPlayerEl) {
                blackPlayerEl.classList.add('active');
                if (isTimeScramble) blackPlayerEl.classList.add('time-scramble');
            }
        }
    }

    // Update timers (skip for Kung Fu)
    if (!isKungFu) {
        updateTimerDisplay(whiteTimer, gameState.whiteTimeRemaining);
        updateTimerDisplay(blackTimer, gameState.blackTimeRemaining);
    }

    renderEvalBar();

    // Render board (with diffing to prevent flicker)
    // Skip if viewing history - don't overwrite the historical view
    if (!boardInitialized) {
        initBoard();
        boardInitialized = true;
    }

    // Only update board display if we're viewing the live position
    if (typeof isViewingHistory !== 'function' || !isViewingHistory()) {
        updateBoard();
    }

    // Render captured pieces and material advantage
    renderMaterial();

    // Render Crazyhouse pockets
    renderPockets();

    // Check if game is over (only trigger once)
    if (gameState.isGameOver && !gameEnded) {
        handleGameOver();
    }

    // Update last updated time (game-timer is hidden; skip fontSize to avoid reflow)
    const gameTimerEl = document.getElementById('game-timer');
    if (gameTimerEl && gameTimerEl.style.display !== 'none') {
        const now = new Date();
        gameTimerEl.textContent = `Last update: ${now.toLocaleTimeString()}`;
    }

    // Debug log
    console.log('State updated:', {
        turn: gameState.isWhiteTurn ? 'White' : 'Black',
        currentPlayer: gameState.currentPlayer,
        myName: currentPlayerName,
        canMove: gameState.currentPlayer.toLowerCase() === currentPlayerName.toLowerCase()
    });

    if (gameState.drawOfferedBy && !gameState.isGameOver) {
        const offeredBy = gameState.drawOfferedBy === 'white' ? gameState.player1 : gameState.player2;
        const canRespond = (gameState.drawOfferedBy === 'white' && currentPlayerName.toLowerCase() === gameState.player2.toLowerCase()) ||
            (gameState.drawOfferedBy === 'black' && currentPlayerName.toLowerCase() === gameState.player1.toLowerCase());

        if (canRespond) {
            drawOfferCard.style.display = 'block';
            drawOfferText.textContent = `${offeredBy} has offered a draw.`;
        } else {
            drawOfferCard.style.display = 'none';
        }
    } else {
        drawOfferCard.style.display = 'none';
    }

    // Update navigation UI (always keep button states current)
    if (typeof updateNavigationUI === 'function') {
        updateNavigationUI();
    }
}

function renderEvalBar() {
    const fillEl = document.getElementById('eval-bar-fill');
    const textEl = document.getElementById('eval-bar-text');
    if (!fillEl || !textEl || !gameState) return;

    // gameState.evaluation is in centipawns (positive = white advantage).
    const evalVal = gameState.evaluation ?? 0;

    let percentage = 50;
    const SCALE = 600;
    const clamped = Math.max(-SCALE, Math.min(SCALE, evalVal));

    if (evalVal >= 9000) {
        percentage = 98;
    } else if (evalVal <= -9000) {
        percentage = 2;
    } else {
        percentage = 50 + (clamped / SCALE) * 48; // ±48% so never fully hidden
    }

    // Round to avoid triggering sub-pixel repaints on every frame
    percentage = Math.round(percentage * 10) / 10;

    const newHeight = `${percentage}%`;
    if (fillEl.style.height !== newHeight) {
        fillEl.style.height = newHeight;
    }

    // Text always displays absolute engine eval (White advantage = positive)
    let text;

    if (evalVal >= 9000) {
        text = evalVal >= 30000 ? 'M#' : 'M' + (10000 - evalVal);
    } else if (evalVal <= -9000) {
        text = evalVal <= -30000 ? '-M#' : '-M' + (10000 + evalVal);
    } else {
        const pawns = Math.abs(evalVal / 100).toFixed(2);
        if (evalVal > 0) text = '+' + pawns;
        else if (evalVal < 0) text = '−' + pawns;
        else text = '0.00';
    }

    if (textEl.textContent !== text) {
        textEl.textContent = text;
    }
}

// Convert board state array to FEN
// Initialize the board DOM once (called only on first render)
function initBoard() {
    console.log('[BOARD] initBoard called');

    if (typeof updateBoardCanvas === 'function') {
        updateBoardCanvas();
        return;
    }

    chessboard.innerHTML = '';

    const boardWidth = gameState.board.length;
    const boardHeight = gameState.board[0].length;
    
    chessboard.style.setProperty('--board-cols', boardWidth);
    chessboard.style.setProperty('--board-rows', boardHeight);

    const startY = isFlipped ? boardHeight - 1 : 0;
    const endY = isFlipped ? -1 : boardHeight;
    const stepY = isFlipped ? -1 : 1;

    const startX = isFlipped ? boardWidth - 1 : 0;
    const endX = isFlipped ? -1 : boardWidth;
    const stepX = isFlipped ? -1 : 1;

    for (let y = startY; y !== endY; y += stepY) {
        for (let x = startX; x !== endX; x += stepX) {
            const square = document.createElement('div');
            square.className = 'square';
            square.className += (x + y) % 2 === 0 ? ' light' : ' dark';
            square.dataset.x = x;
            square.dataset.y = y;
            square.id = `square-${x}-${y}`;

            // Event listeners (permanent, don't need to recreate)
            square.addEventListener('click', () => handleSquareClick(x, y));

            // Touch support for mobile - position-based detection
            // Touch activates drag, release on same square = click-to-move, different square = move

            square.addEventListener('touchstart', (e) => {
                e.preventDefault();

                // Check if there's a piece to potentially drag
                const piece = gameState.board[x][y];
                const amIWhite = (gameState.player1.toLowerCase() === currentPlayerName.toLowerCase());

                if (piece && piece.isWhite === amIWhite) {
                    // Start drag mode immediately
                    touchDragState = {
                        startX: x,
                        startY: y,
                        pieceEl: square.querySelector('.piece'),
                        ghostEl: null
                    };

                    // Show valid moves immediately
                    selectedSquare = { x, y };
                    highlightSquare(x, y);
                    fetchValidMoves(x, y);

                    // Dim the piece to show it's being moved
                    if (touchDragState.pieceEl) {
                        touchDragState.pieceEl.style.opacity = '0.5';
                    }
                } else if (selectedSquare) {
                    // Tapped on empty square or opponent piece - try to move
                    const isValidMove = validMoves.some(m => m.x === x && m.y === y);
                    if (isValidMove) {
                        const startX = selectedSquare.x;
                        const startY = selectedSquare.y;
                        clearSelection();
                        makeMove(startX, startY, x, y);
                    } else {
                        clearSelection();
                    }
                }
            }, { passive: false });

            square.addEventListener('touchmove', (e) => {
                e.preventDefault();
                if (!touchDragState || !touchDragState.pieceEl) return;

                const touch = e.touches[0];

                // Create ghost piece if not exists
                if (!touchDragState.ghostEl) {
                    const ghost = touchDragState.pieceEl.cloneNode(true);
                    ghost.style.position = 'fixed';
                    ghost.style.width = '60px';
                    ghost.style.height = '60px';
                    ghost.style.pointerEvents = 'none';
                    ghost.style.zIndex = '9999';
                    ghost.style.opacity = '0.8';
                    ghost.style.transform = 'translate(-50%, -50%)';
                    document.body.appendChild(ghost);
                    touchDragState.ghostEl = ghost;
                }

                // Move ghost to touch position
                touchDragState.ghostEl.style.left = touch.clientX + 'px';
                touchDragState.ghostEl.style.top = touch.clientY + 'px';

                // Highlight square under finger
                highlightSquareUnderTouch(touch.clientX, touch.clientY);
            }, { passive: false });

            square.addEventListener('touchend', (e) => {
                e.preventDefault();

                // Clear drag-over highlights
                document.querySelectorAll('.square.drag-over').forEach(sq => {
                    sq.classList.remove('drag-over');
                });

                if (touchDragState) {
                    // Clean up ghost
                    if (touchDragState.ghostEl) {
                        touchDragState.ghostEl.remove();
                    }
                    if (touchDragState.pieceEl) {
                        touchDragState.pieceEl.style.opacity = '1';
                    }

                    // Find where finger was released
                    if (e.changedTouches.length > 0) {
                        const touch = e.changedTouches[0];
                        const targetSquare = getSquareAtPosition(touch.clientX, touch.clientY);

                        if (targetSquare) {
                            const targetX = parseInt(targetSquare.dataset.x);
                            const targetY = parseInt(targetSquare.dataset.y);

                            // Released on same square = keep selection (click-to-move mode)
                            if (targetX === touchDragState.startX && targetY === touchDragState.startY) {
                                // Piece stays selected, valid moves are shown
                                // User can tap another square to complete the move
                            } else {
                                // Released on different square = try to move
                                const isValidMove = validMoves.some(m => m.x === targetX && m.y === targetY);
                                if (isValidMove) {
                                    const startX = touchDragState.startX;
                                    const startY = touchDragState.startY;
                                    clearSelection();
                                    makeMove(startX, startY, targetX, targetY);
                                } else {
                                    clearSelection();
                                }
                            }
                        } else {
                            clearSelection();
                        }
                    }

                    touchDragState = null;
                }
            }, { passive: false });

            square.addEventListener('dragover', handleDragOver);
            square.addEventListener('dragenter', handleDragEnter);
            square.addEventListener('dragleave', handleDragLeave);
            square.addEventListener('dragend', handleDragEnd);
            square.addEventListener('drop', (e) => handleDrop(e, x, y));

            chessboard.appendChild(square);
        }
    }

    // Initialize previous state
    previousBoardState = {
        board: null,
        lastMoveHash: null,
        validMovesHash: null,
        cooldowns: null,
        isFlipped: isFlipped
    };

    updateBoardOrientation();
}

// Update board by diffing - only update squares that changed
function updateBoard(forceRefresh = false) {
    if (!gameState || !gameState.board) return;

    if (typeof updateBoardCanvas === 'function') {
        updateBoardCanvas();
        return;
    }

    // Force full refresh if requested (e.g., returning from history view)
    if (forceRefresh) {
        previousBoardState = null;
    }

    // Check if board orientation changed - if so, rearrange squares
    if (previousBoardState && previousBoardState.isFlipped !== isFlipped) {
        reorderSquaresForFlip();
        previousBoardState.isFlipped = isFlipped;
    }

    // Get last move for highlighting
    let lastMove = null;
    if (gameState.moveHistory && gameState.moveHistory.length > 0) {
        lastMove = gameState.moveHistory[gameState.moveHistory.length - 1];
    }
    const lastMoveHash = lastMove ? `${lastMove.startX},${lastMove.startY},${lastMove.endX},${lastMove.endY}` : null;
    const validMovesHash = validMoves.map(m => `${m.x},${m.y}`).join(';');

    const boardWidth = gameState.board.length;
    const boardHeight = gameState.board[0].length;

    // Iterate through all squares and update only what changed
    for (let y = 0; y < boardHeight; y++) {
        for (let x = 0; x < boardWidth; x++) {
            const square = document.getElementById(`square-${x}-${y}`);
            if (!square) continue;

            const piece = gameState.board[x][y];
            const prevPiece = previousBoardState?.board?.[x]?.[y];

            // Check if piece changed
            const pieceChanged = JSON.stringify(piece) !== JSON.stringify(prevPiece);

            // Check if this square is part of last move (for highlighting)
            const isLastMoveSquare = lastMove && (
                (x === lastMove.startX && y === lastMove.startY) ||
                (x === lastMove.endX && y === lastMove.endY)
            );

            // Check if this square has a valid move indicator
            const hasValidMove = validMoves.some(m => m.x === x && m.y === y);

            // Update piece if changed
            if (pieceChanged) {
                const existingPieces = square.querySelectorAll('.piece');

                if (piece) {
                    const color = piece.isWhite ? 'white' : 'black';
                    const src = `pieces/${color}-${piece.type}.png`;
                    const alt = `${color} ${piece.type}`;

                    if (existingPieces.length > 0) {
                        // Recycle the first existing piece element
                        const pieceImg = existingPieces[0];
                        if (pieceImg.src !== src) pieceImg.src = src;
                        if (pieceImg.alt !== alt) pieceImg.alt = alt;
                        
                        // Remove any accidental duplicates
                        for (let i = 1; i < existingPieces.length; i++) {
                            existingPieces[i].remove();
                        }
                    } else {
                        // Create a new piece element
                        const pieceImg = document.createElement('img');
                        pieceImg.className = 'piece';
                        pieceImg.src = src;
                        pieceImg.alt = alt;
                        pieceImg.draggable = true;
                        pieceImg.addEventListener('dragstart', (e) => handleDragStart(e, x, y));
                        square.appendChild(pieceImg);
                    }
                    square.classList.add('has-piece');
                } else {
                    // Square became empty, remove all piece images
                    existingPieces.forEach(p => p.remove());
                    square.classList.remove('has-piece');
                }
            }

            // Update last-move highlight - only change if needed
            const hasLastMove = square.classList.contains('last-move');
            if (isLastMoveSquare && !hasLastMove) {
                square.classList.add('last-move');
            } else if (!isLastMoveSquare && hasLastMove) {
                square.classList.remove('last-move');
            }

            // Preserve selected square highlight - only change if needed
            const isSelectedSquare = selectedSquare && selectedSquare.x === x && selectedSquare.y === y;
            const hasSelected = square.classList.contains('selected');
            if (isSelectedSquare && !hasSelected) {
                square.classList.add('selected');
            } else if (!isSelectedSquare && hasSelected) {
                square.classList.remove('selected');
            }

            // Update valid move indicators - only change if needed
            const existingMarker = square.querySelector('.valid-move-marker');
            const hasValidMoveClass = square.classList.contains('valid-move');

            if (hasValidMove) {
                if (!hasValidMoveClass) {
                    square.classList.add('valid-move');
                }
                if (!existingMarker) {
                    const marker = document.createElement('div');
                    marker.className = 'valid-move-marker';
                    square.appendChild(marker);
                }
            } else {
                if (hasValidMoveClass) {
                    square.classList.remove('valid-move');
                }
                if (existingMarker) existingMarker.remove();
                // Also remove old class if present
                const oldIndicator = square.querySelector('.valid-move-indicator');
                if (oldIndicator) oldIndicator.remove();
            }

            // King of the Hill: Highlight center squares
            if (gameState.variant === 'kingofthehill') {
                if ((x === 3 || x === 4) && (y === 3 || y === 4)) {
                    square.classList.add('koth-center');
                }
            }

            // Update cooldown visualization (Kung Fu Chess)
            if (gameState.cooldowns) {
                const key = `${x},${y}`;
                const cooldownEnd = gameState.cooldowns[key];
                if (cooldownEnd > Date.now()) {
                    if (!square.classList.contains('cooldown')) {
                        square.classList.add('cooldown');
                    }
                    const remainingMs = cooldownEnd - Date.now();
                    const totalMs = gameState.cooldownMs || 10000;
                    const progressPercent = Math.min(100, (remainingMs / totalMs) * 100);
                    
                    let progressEl = square.querySelector('.cooldown-progress');
                    if (!progressEl) {
                        progressEl = document.createElement('div');
                        progressEl.className = 'cooldown-progress';
                        square.appendChild(progressEl);
                    }
                    progressEl.style.height = `${progressPercent}%`;
                } else {
                    square.classList.remove('cooldown');
                    const existingCooldown = square.querySelector('.cooldown-progress');
                    if (existingCooldown) existingCooldown.remove();
                }
            } else {
                square.classList.remove('cooldown');
                const existingCooldown = square.querySelector('.cooldown-progress');
                if (existingCooldown) existingCooldown.remove();
            }
        }
    }

    // Store current state for next diff
    previousBoardState = {
        board: JSON.parse(JSON.stringify(gameState.board)),
        lastMoveHash: lastMoveHash,
        validMovesHash: validMovesHash,
        cooldowns: gameState.cooldowns ? { ...gameState.cooldowns } : null,
        isFlipped: isFlipped
    };
}

// Reorder squares in DOM when board is flipped
function reorderSquaresForFlip() {
    const squares = Array.from(chessboard.children);
    chessboard.innerHTML = '';

    if (isFlipped) {
        // Reverse order for flipped board
        squares.reverse();
    }

    // Re-append in correct order
    const startY = isFlipped ? 7 : 0;
    const endY = isFlipped ? -1 : 8;
    const stepY = isFlipped ? -1 : 1;
    const startX = isFlipped ? 7 : 0;
    const endX = isFlipped ? -1 : 8;
    const stepX = isFlipped ? -1 : 1;

    for (let y = startY; y !== endY; y += stepY) {
        for (let x = startX; x !== endX; x += stepX) {
            const squareId = `square-${x}-${y}`;
            const square = squares.find(el => el.id === squareId);
            if (square) {
                chessboard.appendChild(square);
            }
        }
    }
}

// Render the chess board (legacy - kept for compatibility but not used in normal flow)
function renderBoard() {
    chessboard.innerHTML = '';

    // Highlight last move
    let lastMove = null;
    if (gameState.moveHistory && gameState.moveHistory.length > 0) {
        lastMove = gameState.moveHistory[gameState.moveHistory.length - 1];
    }

    const startY = isFlipped ? 7 : 0;
    const endY = isFlipped ? -1 : 8;
    const stepY = isFlipped ? -1 : 1;

    const startX = isFlipped ? 7 : 0;
    const endX = isFlipped ? -1 : 8;
    const stepX = isFlipped ? -1 : 1;

    for (let y = startY; y !== endY; y += stepY) {
        for (let x = startX; x !== endX; x += stepX) {
            const square = document.createElement('div');
            square.className = 'square';
            square.className += (x + y) % 2 === 0 ? ' light' : ' dark';
            square.dataset.x = x;
            square.dataset.y = y;

            // Highlight last move
            if (lastMove) {
                if ((x === lastMove.startX && y === lastMove.startY) ||
                    (x === lastMove.endX && y === lastMove.endY)) {
                    square.classList.add('last-move');
                }
            }

            // King of the Hill: Highlight center "hill" squares
            if (gameState.variant === 'kingofthehill') {
                if ((x === 3 || x === 4) && (y === 3 || y === 4)) {
                    square.classList.add('koth-center');
                }
            }

            const piece = gameState.board[x][y];
            if (piece) {
                const pieceImg = document.createElement('img');
                pieceImg.className = 'piece';
                const color = piece.isWhite ? 'white' : 'black';
                pieceImg.src = `pieces/${color}-${piece.type}.png`;
                pieceImg.alt = `${color} ${piece.type}`;

                // Make piece draggable
                pieceImg.draggable = true;
                pieceImg.addEventListener('dragstart', (e) => handleDragStart(e, x, y));

                square.appendChild(pieceImg);
                square.classList.add('has-piece');
            }

            // Cooldown visualization with progress bar
            if (gameState.cooldowns) {
                const key = `${x},${y}`;
                const cooldownEnd = gameState.cooldowns[key];
                if (cooldownEnd > Date.now()) {
                    square.classList.add('cooldown');

                    // Calculate progress percentage
                    const remainingMs = cooldownEnd - Date.now();
                    const totalMs = gameState.cooldownMs || 10000;
                    const progressPercent = Math.min(100, (remainingMs / totalMs) * 100);

                    // Create progress overlay (fills from bottom, shrinks as cooldown completes)
                    const progressEl = document.createElement('div');
                    progressEl.className = 'cooldown-progress';
                    progressEl.style.height = `${progressPercent}%`;
                    square.appendChild(progressEl);
                }
            }

            square.addEventListener('click', () => handleSquareClick(x, y));

            // Drag and Drop
            square.addEventListener('dragover', handleDragOver);
            square.addEventListener('dragenter', handleDragEnter);
            square.addEventListener('dragleave', handleDragLeave);
            square.addEventListener('dragend', handleDragEnd);
            square.addEventListener('drop', (e) => handleDrop(e, x, y));

            // Valid Move Indicator
            if (validMoves.some(m => m.x === x && m.y === y)) {
                const indicator = document.createElement('div');
                indicator.className = 'valid-move-indicator';
                square.appendChild(indicator);
            }

            chessboard.appendChild(square);
        }
    }
}

// Handle square click
async function handleSquareClick(x, y) {
    if (gameState.isGameOver) return;

    // If viewing history, return to current position before allowing interaction
    if (isViewingHistory()) {
        navigateToEnd();
        return;
    }

    // Secret setup phase intercept
    if (gameState.secretSetupPhase && !gameState.setupComplete) {
        const piece = gameState.board[x][y];
        const amIWhite = (gameState.player1.toLowerCase() === currentPlayerName.toLowerCase());
        // In team modes, color check might be different, but for now we check player color
        // Wait, the client is 'white' or 'black' based on player1/player2 or we can just check if they own the piece.
        // Actually, piece.color exists!
        // We can just use the server's validation, but client-side it's good to prevent mis-clicks.
        if (piece && piece.type === 'pawn') {
            const role = prompt("Make this pawn a secret [Q]ueen or [K]ing? (Cancel to ignore)");
            if (role) {
                let secretType = null;
                if (role.toLowerCase() === 'q') secretType = 'queen';
                if (role.toLowerCase() === 'k') secretType = 'king';
                
                if (secretType) {
                    await fetch(`/api/game/${gameId}/action`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            player: currentPlayerName,
                            action: { type: 'secret_setup', secrets: [{ x, y, type: secretType }] }
                        })
                    });
                    showMessage('Secret setup sent.', 'success');
                } else {
                    showMessage('Invalid secret type.', 'error');
                }
            }
        } else if (piece) {
            showMessage('You can only select pawns for secret setup.', 'info');
        }
        return;
    }

    // Crazyhouse: If a pocket piece is selected, drop it
    if (selectedDropPiece && gameState.variant === 'crazyhouse') {
        const piece = gameState.board[x][y];
        if (!piece) {
            // Empty square - drop the piece
            await dropPiece(x, y);
            selectedDropPiece = null;
            renderPockets();
            return;
        } else {
            // Square has a piece - cancel drop mode
            selectedDropPiece = null;
            renderPockets();
            // Continue to normal click handling
        }
    }

    const piece = gameState.board[x][y];
    const amIWhite = (gameState.player1.toLowerCase() === currentPlayerName.toLowerCase());

    // If no piece selected yet: SELECT
    if (selectedSquare === null) {
        if (!piece) return;
        if (piece.isWhite !== amIWhite) return;

        // Kung Fu Cooldown Check
        if (gameState.variant === 'kungfu' && gameState.cooldowns) {
            const key = `${x},${y}`;
            if (gameState.cooldowns[key] > Date.now()) {
                showMessage('Piece is recharging!', 'warning');
                return;
            }
        }

        // Select it
        selectedSquare = { x, y };
        highlightSquare(x, y);
        fetchValidMoves(x, y);
        return;
    }

    // If piece already selected: MOVE or DESELECT
    else {
        // 1. Clicked same square: Deselect
        if (selectedSquare.x === x && selectedSquare.y === y) {
            clearSelection();
            return;
        }

        // 2. Clicked valid move: EXECUTE
        let isValidMove = validMoves.some(m => m.x === x && m.y === y);
        let moveX = x;
        let moveY = y;

        // Check if this is a click-on-rook-to-castle attempt
        if (piece && piece.isWhite === amIWhite && piece.type === 'rook') {
            const selectedPiece = gameState.board[selectedSquare.x][selectedSquare.y];
            if (selectedPiece && selectedPiece.type === 'king') {
                // Determine castling direction
                const isKingside = x > selectedSquare.x;
                const targetX = isKingside ? 6 : 2;
                
                // If the castling destination is a valid move, allow it
                if (validMoves.some(m => m.x === targetX && m.y === y)) {
                    isValidMove = true;
                    moveX = targetX;
                    moveY = y;
                }
            }
        }

        // Switch selection to own piece, UNLESS it's a valid castling move via clicking the rook
        if (piece && piece.isWhite === amIWhite && !isValidMove) {
            selectedSquare = { x, y };
            highlightSquare(x, y);
            fetchValidMoves(x, y);
            return;
        }

        // Only proceed if VALID
        if (isValidMove) {
            const initialMinutes = gameState.timeControl || 10;
            const needsConfirmation = initialMinutes > 30 && !gameState.isGameOver;

            if (needsConfirmation) {
                // Show confirmation modal
                pendingMove = { startX: selectedSquare.x, startY: selectedSquare.y, endX: moveX, endY: moveY };

                // Convert coords to algebraic for display
                const files = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
                const target = `${files[moveX]}${8 - moveY}`;

                document.getElementById('confirm-move-target').textContent = target;
                document.getElementById('confirmation-modal').classList.add('show');
                return;
            }

            // Move immediately
            const startX = selectedSquare.x;
            const startY = selectedSquare.y;
            clearSelection();
            await makeMove(startX, startY, moveX, moveY);
        } else {
            // Invalid move click -> Deselect
            clearSelection();
        }
    }
}

// Highlight selected square (visual only - does NOT clear state)
function highlightSquare(x, y) {
    if (typeof updateBoardCanvas === 'function') {
        updateBoardCanvas();
        return;
    }

    // Remove selected class from all squares (visual only)
    document.querySelectorAll('.square.selected').forEach(sq => {
        sq.classList.remove('selected');
    });

    const square = document.querySelector(`[data-x="${x}"][data-y="${y}"]`);
    if (square) {
        square.classList.add('selected');
    }
}

// Clear selection
function clearSelection() {
    selectedSquare = null;
    selectedDropPiece = null;
    validMoves = []; // Clear valid moves

    if (typeof updateBoardCanvas === 'function') {
        updateBoardCanvas();
    }

    // Clear visual styles for selection only (not last-move - that's handled by updateBoard)
    document.querySelectorAll('.square.selected').forEach(sq => {
        sq.classList.remove('selected');
    });
    document.querySelectorAll('.valid-move-marker').forEach(m => m.remove());
    document.querySelectorAll('.square.valid-move').forEach(sq => {
        sq.classList.remove('valid-move');
    });

    renderPockets();
}

// Fetch valid moves from server
async function fetchValidMoves(x, y, skipFullRender = false) {
    if (!gameId) return;

    try {
        const response = await fetch(`/api/game/${gameId}/valid-moves?x=${x}&y=${y}`);
        const data = await response.json();

        if (data.success && data.moves) {
            validMoves = data.moves;
            if (skipFullRender) {
                updateMoveIndicators();
            } else {
                updateBoard(); // Show indicators via diffing update
            }
        }
    } catch (err) {
        console.error('Error fetching valid moves:', err);
    }
}

// Update valid move indicators without full re-render (for drag support)
function updateMoveIndicators() {
    // Remove existing markers and classes
    document.querySelectorAll('.valid-move-marker, .valid-move-indicator').forEach(el => el.remove());
    document.querySelectorAll('.square.valid-move').forEach(sq => sq.classList.remove('valid-move'));

    // Add new ones
    validMoves.forEach(move => {
        const square = document.querySelector(`.square[data-x="${move.x}"][data-y="${move.y}"]`);
        if (square) {
            square.classList.add('valid-move');
            const marker = document.createElement('div');
            marker.className = 'valid-move-marker';
            square.appendChild(marker);
        }
    });
}

// Get square element at screen position (for touch drag)
function getSquareAtPosition(clientX, clientY) {
    const elements = document.elementsFromPoint(clientX, clientY);
    for (const el of elements) {
        if (el.classList.contains('square')) {
            return el;
        }
    }
    return null;
}

// Highlight square under touch during drag
function highlightSquareUnderTouch(clientX, clientY) {
    // Remove drag-over class from all squares
    document.querySelectorAll('.square.drag-over').forEach(sq => {
        sq.classList.remove('drag-over');
    });

    // Add to square under finger
    const square = getSquareAtPosition(clientX, clientY);
    if (square) {
        // Only highlight if it's a valid move target
        const x = parseInt(square.dataset.x);
        const y = parseInt(square.dataset.y);
        if (validMoves.some(m => m.x === x && m.y === y)) {
            square.classList.add('drag-over');
        }
    }
}

// Drag and Drop Handlers
function handleDragStart(e, x, y) {
    if (gameState.isGameOver) {
        e.preventDefault();
        return;
    }

    // If viewing history, return to current position
    if (isViewingHistory()) {
        e.preventDefault();
        navigateToEnd();
        return;
    }

    const piece = gameState.board[x][y];
    if (!piece) {
        e.preventDefault();
        return;
    }

    // Determine if I am White
    const amIWhite = (gameState.player1.toLowerCase() === currentPlayerName.toLowerCase());

    // Check piece ownership - can only drag my own pieces
    if (piece.isWhite !== amIWhite) {
        e.preventDefault();
        return;
    }

    // Kung Fu: Check cooldown instead of turn
    if (gameState.variant === 'kungfu') {
        if (gameState.cooldowns) {
            const key = `${x},${y}`;
            if (gameState.cooldowns[key] > Date.now()) {
                e.preventDefault();
                return; // Piece on cooldown
            }
        }
    } else {
        // Standard: Check if current player is a computer
        const currentPlayerType = gameState.isWhiteTurn ? gameState.whitePlayerType : gameState.blackPlayerType;
        if (currentPlayerType === 'computer') {
            e.preventDefault();
            return;
        }

        // Standard: Check if it's my turn
        if (gameState.currentPlayer.toLowerCase() !== currentPlayerName.toLowerCase()) {
            e.preventDefault();
            return;
        }
    }

    e.dataTransfer.setData('text/plain', JSON.stringify({ x, y }));
    e.dataTransfer.effectAllowed = 'move';

    // Add dragging classes
    const square = document.getElementById(`square-${x}-${y}`);
    if (square) square.classList.add('dragging');
    document.body.classList.add('is-dragging');

    // Fetch valid moves and show dots, BUT do not re-render (skipFullRender=true)
    fetchValidMoves(x, y, true);
}

function handleDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
}

function handleDragEnter(e) {
    e.preventDefault();
    const square = e.target.closest('.square');
    if (square) {
        square.classList.add('drag-over');
    }
}

function handleDragLeave(e) {
    const square = e.target.closest('.square');
    if (square) {
        square.classList.remove('drag-over');
    }
}

function handleDragEnd(e) {
    // Clean up all drag states
    document.querySelectorAll('.square').forEach(sq => {
        sq.classList.remove('dragging', 'drag-over');
    });
    document.body.classList.remove('is-dragging');
}

async function handleDrop(e, x, y) {
    e.preventDefault();

    // Clean up drag states
    document.querySelectorAll('.square').forEach(sq => {
        sq.classList.remove('dragging', 'drag-over');
    });
    document.body.classList.remove('is-dragging');

    const data = e.dataTransfer.getData('text/plain');
    if (!data) return;

    const start = JSON.parse(data);
    if (start.x === x && start.y === y) return;

    // Check for promotion on drop
    const movingPiece = gameState.board[start.x][start.y];
    if (movingPiece && movingPiece.type === 'pawn') {
        const isPromotion = (movingPiece.isWhite && y === 0) || (!movingPiece.isWhite && y === 7);
        if (isPromotion) {
            pendingMove = { startX: start.x, startY: start.y, endX: x, endY: y };
            promotionDialog.classList.add('show');

            // Clean up drag visual states
            document.querySelectorAll('.square').forEach(sq => {
                sq.classList.remove('dragging', 'drag-over');
            });
            clearSelection();
            return;
        }
    }

    clearSelection();
    await makeMove(start.x, start.y, x, y);
}

// Make a move
async function makeMove(startX, startY, endX, endY, promotionPiece = 'queen') {
    try {
        const response = await fetch(`/api/game/${gameId}/move`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                startX,
                startY,
                endX,
                endY,
                player: currentPlayerName,
                promotionPiece
            })
        });

        const result = await response.json();

        if (result.success) {
            await updateGameState();
            if (result.gameOver) {
                handleGameOver();
            }
        } else {
            showMessage(result.message || 'Invalid move', 'error');
        }
    } catch (error) {
        showMessage('Error making move', 'error');
    }
}

// Handle game over
async function handleGameOver() {
    gameEnded = true; // Prevent 404 redirect during close countdown
    clearInterval(updateInterval);
    clearInterval(timerInterval);
    gameOverCard.style.display = 'block';

    if (gameState.winner) {
        gameResult.textContent = `${gameState.winner} wins!`;
    } else {
        gameResult.textContent = 'Draw!';
    }

    // Fetch updated scores
    try {
        const response = await fetch('/api/status');
        const data = await response.json();

        const p1 = data.players.find(p => p.name === gameState.player1);
        const p2 = data.players.find(p => p.name === gameState.player2);

        if (p1 && p2) {
            const p1Score = (p1.score / 1000).toFixed(2);
            const p2Score = (p2.score / 1000).toFixed(2);

            const scoreDiv = document.createElement('div');
            scoreDiv.className = 'final-scores';
            scoreDiv.innerHTML = `
                <p>Updated Scores:</p>
                <p>${p1.name}: ${p1Score}s</p>
                <p>${p2.name}: ${p2Score}s</p>
            `;
            gameResult.appendChild(scoreDiv);
        }
    } catch (error) {
        console.error('Error fetching updated scores:', error);
    }

    // Show celebration modal
    showCelebration();
}

// Show celebration modal
function showCelebration() {
    console.log("Triggering showCelebration");
    const modal = document.getElementById('celebration-modal');
    const title = document.getElementById('celebration-title');
    const details = document.getElementById('celebration-details');
    const closeBtn = document.getElementById('celebration-close-btn');

    if (!modal || !title || !details) {
        console.error("Missing celebration elements:", { modal, title, details });
        return;
    }

    // Set Header based on termination reason
    if (gameState.winner) {
        // Determine who viewing is
        const viewerNameLower = (currentPlayerName || '').toLowerCase();
        const winnerLower = gameState.winner.toLowerCase();
        const p1Lower = (gameState.player1 || '').toLowerCase();
        const p2Lower = (gameState.player2 || '').toLowerCase();
        
        const isPlayer = viewerNameLower === p1Lower || viewerNameLower === p2Lower;
        const viewerWon = winnerLower === viewerNameLower;
        const loserName = gameState.winner === gameState.player1 ? gameState.player2 : gameState.player1;

        if (isPlayer) {
            // Player view
            switch (gameState.termination) {
                case 'checkmate':
                    title.textContent = viewerWon ? 'Checkmate! You Win!' : 'Checkmate! You Lose!';
                    break;
                case 'resignation':
                    title.textContent = viewerWon ? 'Opponent Resigned!' : 'You Resigned';
                    break;
                case 'timeout':
                    title.textContent = viewerWon ? 'Opponent Timed Out!' : 'Time Out! You Lose!';
                    break;
                case 'atomic_explosion':
                case 'king_capture':
                    title.textContent = viewerWon ? 'King Destroyed! You Win!' : 'King Destroyed! You Lose!';
                    break;
                case 'koth':
                    title.textContent = viewerWon ? 'King of the Hill! You Win!' : 'Opponent Reached the Hill!';
                    break;
                default:
                    title.textContent = viewerWon ? 'Victory!' : `${gameState.winner} Wins!`;
            }
        } else {
            // Spectator view
            switch (gameState.termination) {
                case 'checkmate':
                    title.textContent = `Checkmate! ${gameState.winner} Wins!`;
                    break;
                case 'resignation':
                    title.textContent = `${loserName} Resigned!`;
                    break;
                case 'timeout':
                    title.textContent = `${loserName} Timed Out!`;
                    break;
                case 'atomic_explosion':
                case 'king_capture':
                    title.textContent = `King Destroyed! ${gameState.winner} Wins!`;
                    break;
                case 'koth':
                    title.textContent = `${gameState.winner} Reached the Hill!`;
                    break;
                default:
                    title.textContent = `${gameState.winner} Wins!`;
            }
        }
    } else {
        // No winner = draw
        switch (gameState.termination) {
            case 'stalemate':
                title.textContent = 'Stalemate!';
                break;
            case 'draw_agreement':
                title.textContent = 'Draw Agreed';
                break;
            default:
                title.textContent = 'Game Drawn';
        }
    }

    title.className = 'celebration-title'; // Ensure animation class

    // Auto-close after 20 seconds (gives players plenty of time to review results)
    const AUTO_CLOSE_SECONDS = 20;
    let closeCountdown = AUTO_CLOSE_SECONDS;

    // Create countdown display element
    const countdownEl = document.createElement('div');
    countdownEl.id = 'close-countdown';
    countdownEl.className = 'close-countdown';
    countdownEl.style.cssText = 'text-align: center; margin-top: 15px; font-size: 0.9rem; color: #888;';
    countdownEl.textContent = `Auto-close in ${closeCountdown}s...`;

    // Insert after celebration-details
    details.parentNode.insertBefore(countdownEl, details.nextSibling);

    // Countdown timer
    const countdownInterval = setInterval(() => {
        closeCountdown--;
        if (closeCountdown <= 0) {
            clearInterval(countdownInterval);
            gameChannel.postMessage({ type: 'GAME_CLOSED', gameId: gameId });
            window.location.href = 'index.html';
        } else {
            countdownEl.textContent = `Auto-close in ${closeCountdown}s...`;
            if (closeCountdown <= 5) {
                countdownEl.style.color = '#ff6b6b';
            }
        }
    }, 1000);

    // Prepare player data for ranking
    const p1 = {
        name: gameState.player1,
        isMe: gameState.player1.toLowerCase() === currentPlayerName.toLowerCase(),
        time: gameState.whiteTimeRemaining,
        color: 'White'
    };
    const p2 = {
        name: gameState.player2,
        isMe: gameState.player2.toLowerCase() === currentPlayerName.toLowerCase(),
        time: gameState.blackTimeRemaining,
        color: 'Black'
    };

    let ranked = [];
    if (gameState.winner) {
        if (gameState.winner === p1.name) {
            ranked = [p1, p2];
        } else {
            ranked = [p2, p1];
        }
    } else {
        // Draw - sort by time remaining? Or just P1/P2
        ranked = [p1, p2];
    }

    // Generate Cards
    let html = '';

    // 1. Winner / First Place
    const winner = ranked[0];
    const winnerTimeObj = formatTimeMsObj(winner.time);
    const winnerTimeText = `${winnerTimeObj} left`;

    html += `
        <div class="result-card gold">
            <span class="result-medal">${gameState.winner ? '🥇' : '🤝'}</span>
            <div class="result-info">
                <div class="result-name">${formatPlayerName(winner.name)}</div>
                <div class="result-position">${gameState.winner ? 'Winner' : 'Draw'}</div>
            </div>
            <span class="result-score">${winnerTimeText}</span>
        </div>
    `;

    // 2. Loser / Second Place
    const loser = ranked[1];
    const loserTimeObj = formatTimeMsObj(loser.time);
    const loserTimeText = `${loserTimeObj} left`;

    html += `
        <div class="result-card silver">
            <span class="result-medal">${gameState.winner ? '🥈' : '🤝'}</span>
            <div class="result-info">
                <div class="result-name">${formatPlayerName(loser.name)}</div>
                <div class="result-position">${gameState.winner ? 'Runner Up' : 'Draw'}</div>
            </div>
            <span class="result-score">${loserTimeText}</span>
        </div>
    `;

    // 3. Stats Footer
    const moveCount = Math.ceil((gameState.moveHistory ? gameState.moveHistory.length : 0) / 2);
    const duration = formatTime(gameState.duration || 0);

    html += `
        <div class="result-card bronze">
            <span class="result-medal">📊</span>
            <div class="result-info">
                <div class="result-name">Game Stats</div>
                <div class="result-position">${moveCount} moves • ${duration} duration</div>
            </div>
        </div>
    `;

    details.innerHTML = html;

    // Show with animation (requires display:flex then class add)
    modal.style.display = 'flex';
    // Small delay to allow browser to register display:flex before adding opacity class
    setTimeout(() => {
        modal.classList.add('show');
    }, 50);

    // Trigger confetti
    createConfetti();

    // Periodic confetti blasts
    const confettiInterval = setInterval(createConfetti, 3000);

    // Setup close button
    closeBtn.onclick = () => {
        clearInterval(confettiInterval);
        clearInterval(countdownInterval);
        gameChannel.postMessage({ type: 'GAME_CLOSED', gameId: gameId });
        if (window.opener) {
            window.close();
        } else {
            window.location.href = '/';
        }
    };
}

// Helper: Format milliseconds to mm:ss string
function formatTimeMsObj(ms) {
    if (ms < 0) ms = 0;
    const minutes = Math.floor(ms / 60000);
    const seconds = Math.floor((ms % 60000) / 1000);
    return `${minutes}m ${seconds}s`;
}

// Helper: Format player name
function formatPlayerName(name) {
    if (name && name.toLowerCase() === currentPlayerName.toLowerCase()) {
        return `${name} (You)`;
    }
    return name;
}

// Helper: Format milliseconds to mm:ss
function formatTimeMs(ms) {
    if (ms < 0) ms = 0;
    const minutes = Math.floor(ms / 60000);
    const seconds = Math.floor((ms % 60000) / 1000);
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

// Helper: Format duration (seconds/minutes)
function formatTime(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes > 0) return `${minutes}m ${seconds}s`;
    return `${seconds}s`;
}

// Create confetti animation
function createConfetti() {
    const container = document.getElementById('confetti-container');
    if (!container) return;

    container.innerHTML = '';
    const colors = ['gold', 'orange', 'blue', 'green', 'pink', 'purple'];
    const shapes = ['square', 'circle', 'rect'];

    for (let i = 0; i < 150; i++) {
        const confetti = document.createElement('div');
        const color = colors[Math.floor(Math.random() * colors.length)];
        const shape = shapes[Math.floor(Math.random() * shapes.length)];

        confetti.className = `confetti ${color} ${shape}`;
        confetti.style.left = Math.random() * 100 + '%';

        // Randomize duration for more natural feel (matches tournament)
        const duration = 3 + Math.random() * 2;
        confetti.style.animationDuration = `${duration}s`;

        confetti.style.animationDelay = Math.random() * 2 + 's';
        confetti.style.opacity = Math.random();

        container.appendChild(confetti);
    }
}

// Resign
resignBtn.addEventListener('click', async () => {
    if (!confirm('Are you sure you want to resign?')) return;

    try {
        const response = await fetch(`/api/game/${gameId}/resign`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ player: currentPlayerName })
        });

        const result = await response.json();
        if (result.success) {
            await updateGameState();
            handleGameOver();
        }
    } catch (error) {
        showMessage('Error resigning', 'error');
    }
});

// Offer draw
drawBtn.addEventListener('click', async () => {
    if (!confirm('Offer a draw?')) return;

    try {
        const response = await fetch(`/api/game/${gameId}/offer-draw`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ player: currentPlayerName })
        });

        const result = await response.json();
        if (result.success) {
            showMessage('Draw offered', 'success');
            await updateGameState();
        } else {
            showMessage(result.error || 'Error offering draw', 'error');
        }
    } catch (error) {
        showMessage('Error offering draw', 'error');
    }
});

// Accept draw
acceptDrawBtn.addEventListener('click', async () => {
    try {
        const response = await fetch(`/api/game/${gameId}/accept-draw`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });

        const result = await response.json();
        if (result.success) {
            await updateGameState();
            handleGameOver();
        } else {
            showMessage(result.error || 'Error accepting draw', 'error');
        }
    } catch (error) {
        showMessage('Error accepting draw', 'error');
    }
});

// Decline draw
declineDrawBtn.addEventListener('click', async () => {
    try {
        const response = await fetch(`/api/game/${gameId}/decline-draw`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });

        const result = await response.json();
        if (result.success) {
            showMessage('Draw declined', 'success');
            await updateGameState();
        } else {
            showMessage(result.error || 'Error declining draw', 'error');
        }
    } catch (error) {
        showMessage('Error declining draw', 'error');
    }
});

// Return to tournament
returnBtn.addEventListener('click', () => {
    window.location.href = 'index.html';
});

const actionsReturnBtn = document.getElementById('actions-return-btn');
if (actionsReturnBtn) {
    actionsReturnBtn.addEventListener('click', () => {
        window.location.href = 'index.html';
    });
}

// Flip board logic
function updateBoardOrientation() {
    const evalBarContainer = document.getElementById('eval-bar-container');
    if (evalBarContainer) {
        if (isFlipped) {
            evalBarContainer.classList.add('flipped');
        } else {
            evalBarContainer.classList.remove('flipped');
        }
    }

    const gameInfoDiv = document.querySelector('.info-card .game-info');
    const blackPlayerDiv = document.querySelector('.player.black-player');
    const whitePlayerDiv = document.querySelector('.player.white-player');
    const gameStatusDiv = document.querySelector('.game-status');

    if (gameInfoDiv && blackPlayerDiv && whitePlayerDiv && gameStatusDiv) {
        gameInfoDiv.style.display = 'flex';
        gameInfoDiv.style.flexDirection = 'column';
        if (isFlipped) {
            // Flipped: White on top, Black on bottom
            whitePlayerDiv.style.order = 1;
            gameStatusDiv.style.order = 2;
            blackPlayerDiv.style.order = 3;
        } else {
            // Normal: Black on top, White on bottom
            blackPlayerDiv.style.order = 1;
            gameStatusDiv.style.order = 2;
            whitePlayerDiv.style.order = 3;
        }
    }

    // Also flip mobile player bars if present
    const boardArea = document.querySelector('.board-area');
    const opponentBar = document.querySelector('.mobile-player-bar.opponent-bar');
    const playerBar = document.querySelector('.mobile-player-bar.player-bar');
    const mobileTournamentTime = document.querySelector('.mobile-tournament-time');
    const boardContainer = document.querySelector('.board-container');
    const moveNavigation = document.querySelector('.move-navigation');

    if (boardArea && opponentBar && playerBar && mobileTournamentTime && boardContainer && moveNavigation) {
        boardArea.style.display = 'flex';
        boardArea.style.flexDirection = 'column';
        mobileTournamentTime.style.order = 2;
        boardContainer.style.order = 3;
        moveNavigation.style.order = 4;
        
        const isPlayerBlack = currentPlayerName && gameState && gameState.player2.toLowerCase() === currentPlayerName.toLowerCase();
        
        if (isFlipped) {
            if (isPlayerBlack) {
                playerBar.style.order = 5;
                opponentBar.style.order = 1;
            } else {
                playerBar.style.order = 1;
                opponentBar.style.order = 5;
            }
        } else {
            if (isPlayerBlack) {
                playerBar.style.order = 1;
                opponentBar.style.order = 5;
            } else {
                playerBar.style.order = 5;
                opponentBar.style.order = 1;
            }
        }
    }
}

flipBtn.addEventListener('click', () => {
    isFlipped = !isFlipped;
    reorderSquaresForFlip();
    updateBoard();
    updateBoardOrientation();
});

// Update timer display with abbreviated format (h, m, s, ms)
function updateTimerDisplay(element, ms) {
    const totalMs = Math.max(0, ms);
    const hours = Math.floor(totalMs / 3600000);
    const minutes = Math.floor((totalMs % 3600000) / 60000);
    const seconds = Math.floor((totalMs % 60000) / 1000);
    const milliseconds = totalMs % 1000;

    const parts = [];
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0 || hours > 0) parts.push(`${minutes.toString().padStart(2, '0')}m`);
    parts.push(`${seconds.toString().padStart(2, '0')}s`);
    parts.push(`${milliseconds.toString().padStart(3, '0')}ms`);

    element.textContent = parts.join(' ');

    if (ms < 30000) {
        element.style.color = '#ff4444';
    } else {
        element.style.color = '';
    }
}

// Client-side timer for smooth updates
function startClientTimer() {
    if (timerInterval) clearInterval(timerInterval);

    lastTickTime = Date.now();

    timerInterval = setInterval(() => {
        if (!gameState || gameState.isGameOver) return;

        const now = Date.now();
        const delta = now - lastTickTime;
        lastTickTime = now;

        if (gameState.isWhiteTurn) {
            gameState.whiteTimeRemaining -= delta;
            updateTimerDisplay(whiteTimer, gameState.whiteTimeRemaining);
        } else {
            gameState.blackTimeRemaining -= delta;
            updateTimerDisplay(blackTimer, gameState.blackTimeRemaining);
        }

        // Keep time-scramble classes in sync during smooth tick
        const activeTimeMs = gameState.isWhiteTurn ? gameState.whiteTimeRemaining : gameState.blackTimeRemaining;
        const isScramble = activeTimeMs < 180000;

        // Desktop player cards
        const whiteEl = document.querySelector('.white-player');
        const blackEl = document.querySelector('.black-player');
        if (whiteEl) whiteEl.classList.toggle('time-scramble', gameState.isWhiteTurn && isScramble);
        if (blackEl) blackEl.classList.toggle('time-scramble', !gameState.isWhiteTurn && isScramble);

        // Turn indicator
        if (turnIndicator) turnIndicator.classList.toggle('time-scramble', isScramble);

        // Mobile bars
        const playerBar = document.querySelector('.player-bar');
        const opponentBar = document.querySelector('.opponent-bar');
        if (playerBar && opponentBar) {
            if (playerBar.classList.contains('active')) {
                playerBar.classList.toggle('time-scramble', isScramble);
                opponentBar.classList.remove('time-scramble');
            } else {
                opponentBar.classList.toggle('time-scramble', isScramble);
                playerBar.classList.remove('time-scramble');
            }
        }
    }, 100);
}

// Update tournament timer
function updateTournamentTimer() {
    if (!gameState) return;

    const tournamentTimerEl = document.getElementById('tournament-timer');
    const mobileTournamentTimerEl = document.getElementById('mobile-tournament-timer');

    if (!tournamentTimerEl && !mobileTournamentTimerEl) return;

    let timeText = 'Not Running';
    let color = 'var(--text-muted)';

    const isRunning = gameState.tournamentIsRunning;
    const remainingTime = gameState.tournamentTimeRemaining || 0;

    if (isRunning && remainingTime > 0) {
        timeText = formatTimeMs(remainingTime);
        color = remainingTime < 60000 ? '#ff4444' : 'var(--gold)';
    } else if (isRunning) {
        timeText = 'Ending...';
        color = '#ff4444';
    }

    if (tournamentTimerEl) {
        tournamentTimerEl.textContent = timeText;
        tournamentTimerEl.style.color = color;
    }
    if (mobileTournamentTimerEl) {
        mobileTournamentTimerEl.textContent = timeText;
        mobileTournamentTimerEl.style.color = color;
    }
}

// Initialize only after the page has fully loaded
// This prevents the browser from thinking the page is still loading (tab spinner)
// if the fetch requests take time or overlap.
window.addEventListener('load', () => {
    updateGameState();
    updateInterval = setInterval(updateGameState, 1000);
});

// Material values for pieces
const MATERIAL_VALUES = {
    'pawn': 1,
    'knight': 3,
    'bishop': 3,
    'rook': 5,
    'queen': 9,
    'king': 0
};

// Helper function to get piece image HTML
function getPieceImgHtml(type, isWhite, size = 20) {
    const color = isWhite ? 'white' : 'black';
    return `<img src="pieces/${color}-${type}.png" alt="${color} ${type}" class="captured-piece-img" style="width: ${size}px; height: ${size}px;">`;
}

// Calculate material difference
function calculateMaterialDifference() {
    if (!gameState || !gameState.capturedByWhite || !gameState.capturedByBlack) return 0;

    const whiteMaterial = gameState.capturedByWhite.reduce((sum, p) => sum + MATERIAL_VALUES[p.type], 0);
    const blackMaterial = gameState.capturedByBlack.reduce((sum, p) => sum + MATERIAL_VALUES[p.type], 0);

    // Advantage > 0: White is ahead
    // Advantage < 0: Black is ahead
    return whiteMaterial - blackMaterial;
}

// Render captured pieces and material advantage
function renderMaterial() {
    if (!gameState.capturedByWhite || !gameState.capturedByBlack) return;

    const whiteCapturedDiv = document.getElementById('white-captured');
    const blackCapturedDiv = document.getElementById('black-captured');
    const materialAdvDiv = document.getElementById('material-advantage');

    // Only write innerHTML when captured pieces actually changed (prevents layout reflow / scroll jump)
    const newWhiteHtml = gameState.capturedByWhite
        .map(p => getPieceImgHtml(p.type, false, 18))
        .join('');
    safeUpdateHtml(whiteCapturedDiv, newWhiteHtml);

    const newBlackHtml = gameState.capturedByBlack
        .map(p => getPieceImgHtml(p.type, true, 18))
        .join('');
    safeUpdateHtml(blackCapturedDiv, newBlackHtml);

    // Calculate material advantage
    const advantage = calculateMaterialDifference();

    // Display material advantage
    let newAdvHtml;
    if (advantage > 0) {
        newAdvHtml = `<span style="color: var(--primary);">White +${advantage}</span>`;
    } else if (advantage < 0) {
        newAdvHtml = `<span style="color: var(--accent);">Black +${Math.abs(advantage)}</span>`;
    } else {
        newAdvHtml = '<span style="color: var(--text-muted);">Equal</span>';
    }
    safeUpdateHtml(materialAdvDiv, newAdvHtml);
}

// Render Crazyhouse pocket pieces
function renderPockets() {
    const isCrazyhouse = gameState.variant === 'crazyhouse';
    const whitePocketDiv = document.getElementById('white-pocket');
    const blackPocketDiv = document.getElementById('black-pocket');
    const whitePiecesSpan = document.getElementById('white-pocket-pieces');
    const blackPiecesSpan = document.getElementById('black-pocket-pieces');

    if (!isCrazyhouse || !whitePocketDiv || !blackPocketDiv) {
        if (whitePocketDiv && whitePocketDiv.style.display !== 'none') whitePocketDiv.style.display = 'none';
        if (blackPocketDiv && blackPocketDiv.style.display !== 'none') blackPocketDiv.style.display = 'none';
        return;
    }

    // Show pocket areas
    if (whitePocketDiv.style.display !== 'flex') whitePocketDiv.style.display = 'flex';
    if (blackPocketDiv.style.display !== 'flex') blackPocketDiv.style.display = 'flex';

    // Render white's pocket pieces (only when changed)
    const whiteReserve = gameState.whiteReserve || [];
    const newWhitePocket = whiteReserve.length === 0
        ? '<span style="color: var(--text-muted);">empty</span>'
        : whiteReserve.map((type, idx) =>
            `<span class="pocket-piece ${selectedDropPiece?.color === 'white' && selectedDropPiece?.type === type ? 'selected' : ''}" 
                   data-type="${type}" data-color="white" 
                   onclick="selectDropPiece('${type}', 'white')">${getPieceImgHtml(type, true, 24)}</span>`
        ).join('');
    safeUpdateHtml(whitePiecesSpan, newWhitePocket);

    // Render black's pocket pieces (only when changed)
    const blackReserve = gameState.blackReserve || [];
    const newBlackPocket = blackReserve.length === 0
        ? '<span style="color: var(--text-muted);">empty</span>'
        : blackReserve.map((type, idx) =>
            `<span class="pocket-piece ${selectedDropPiece?.color === 'black' && selectedDropPiece?.type === type ? 'selected' : ''}" 
                   data-type="${type}" data-color="black" 
                   onclick="selectDropPiece('${type}', 'black')">${getPieceImgHtml(type, false, 24)}</span>`
        ).join('');
    safeUpdateHtml(blackPiecesSpan, newBlackPocket);
}

// Select a piece from pocket for dropping
function selectDropPiece(type, color) {
    const isMyPiece = (color === 'white' && currentPlayerName.toLowerCase() === gameState.player1.toLowerCase()) ||
        (color === 'black' && currentPlayerName.toLowerCase() === gameState.player2.toLowerCase());
    const isMyTurn = gameState.currentPlayer.toLowerCase() === currentPlayerName.toLowerCase();

    if (!isMyPiece) {
        console.log('Not your piece to drop');
        return;
    }
    if (!isMyTurn) {
        console.log('Not your turn');
        return;
    }

    // Toggle selection
    if (selectedDropPiece?.type === type && selectedDropPiece?.color === color) {
        selectedDropPiece = null;
        selectedSquare = null;
    } else {
        selectedDropPiece = { type, color };
        selectedSquare = null; // Clear any board selection
    }

    renderPockets();
    updateBoard(); // Update to show drop targets
}

// Drop a piece from pocket onto the board
async function dropPiece(x, y) {
    if (!selectedDropPiece) return;

    const response = await fetch(`/api/game/${gameId}/drop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            pieceType: selectedDropPiece.type,
            x,
            y,
            player: currentPlayerName
        })
    });

    const result = await response.json();
    if (result.success) {
        selectedDropPiece = null;
        updateGameState();
    } else {
        console.error('Drop failed:', result.message);
        showMessage(result.message || 'Drop failed', 'error');
    }
}

// Update mobile player bars with game data
function updateMobilePlayerBars() {
    if (!gameState) return;

    // Get mobile elements
    const mobileOpponentName = document.getElementById('mobile-opponent-name');
    const mobileOpponentElo = document.getElementById('mobile-opponent-elo');
    const mobileOpponentTimer = document.getElementById('mobile-opponent-timer');
    const mobileOpponentCaptured = document.getElementById('mobile-opponent-captured');
    const mobileOpponentColor = document.getElementById('mobile-opponent-color');
    const mobileOpponentMaterial = document.getElementById('mobile-opponent-material');
    const mobilePlayerName = document.getElementById('mobile-player-name');
    const mobilePlayerElo = document.getElementById('mobile-player-elo');
    const mobilePlayerTimer = document.getElementById('mobile-player-timer');
    const mobilePlayerCaptured = document.getElementById('mobile-player-captured');
    const mobilePlayerColor = document.getElementById('mobile-player-color');
    const mobilePlayerMaterial = document.getElementById('mobile-player-material');
    const mobileVariantBadge = document.getElementById('mobile-variant-badge');
    const mobileTournamentTimer = document.getElementById('mobile-tournament-timer');
    const mobileMaterialAdvantage = document.getElementById('mobile-material-advantage');

    if (!mobileOpponentName) return; // Mobile elements don't exist

    // Determine who is opponent and who is current player
    const amIWhite = (gameState.player1.toLowerCase() === currentPlayerName.toLowerCase());

    // If board is flipped, swap the display
    const showWhiteOnBottom = amIWhite !== isFlipped;

    // Calculate material difference
    const materialDiff = calculateMaterialDifference();

    // Update central material advantage display
    if (mobileMaterialAdvantage) {
        if (materialDiff > 0) {
            mobileMaterialAdvantage.textContent = `White +${materialDiff}`;
            mobileMaterialAdvantage.className = 'material-advantage white-ahead';
        } else if (materialDiff < 0) {
            mobileMaterialAdvantage.textContent = `Black +${Math.abs(materialDiff)}`;
            mobileMaterialAdvantage.className = 'material-advantage black-ahead';
        } else {
            mobileMaterialAdvantage.textContent = 'Equal';
            mobileMaterialAdvantage.className = 'material-advantage equal';
        }
    }

    if (showWhiteOnBottom) {
        // White on bottom (player bar), Black on top (opponent bar)
        mobilePlayerName.textContent = gameState.player1 + p1You;
        mobilePlayerElo.textContent = gameState.player1Elo ? `(${Math.round(gameState.player1Elo)})` : '';
        if (mobilePlayerColor) mobilePlayerColor.textContent = '(White)';
        document.getElementById('mobile-player-captured').innerHTML = document.getElementById('white-captured').innerHTML;

        mobileOpponentName.textContent = gameState.player2 + p2You;
        mobileOpponentElo.textContent = gameState.player2Elo ? `(${Math.round(gameState.player2Elo)})` : '';
        if (mobileOpponentColor) mobileOpponentColor.textContent = '(Black)';

        // Material advantage
        if (mobilePlayerMaterial && mobileOpponentMaterial) {
            if (materialDiff > 0) {
                mobilePlayerMaterial.textContent = `+${materialDiff}`;
                mobilePlayerMaterial.className = 'material-mobile ahead';
                mobileOpponentMaterial.textContent = '';
                mobileOpponentMaterial.className = 'material-mobile';
            } else if (materialDiff < 0) {
                mobileOpponentMaterial.textContent = `+${Math.abs(materialDiff)}`;
                mobileOpponentMaterial.className = 'material-mobile ahead';
                mobilePlayerMaterial.textContent = '';
                mobilePlayerMaterial.className = 'material-mobile';
            } else {
                mobilePlayerMaterial.textContent = '';
                mobileOpponentMaterial.textContent = '';
                mobilePlayerMaterial.className = 'material-mobile';
                mobileOpponentMaterial.className = 'material-mobile';
            }
        }

        // Captured pieces - White's captures shown on White's bar (captured black pieces)
        if (mobilePlayerCaptured && gameState.capturedByWhite) {
            const newHtml = gameState.capturedByWhite
                .map(p => getPieceImgHtml(p.type, false, 16))
                .join('');
            safeUpdateHtml(mobilePlayerCaptured, newHtml);
        }
        if (mobileOpponentCaptured && gameState.capturedByBlack) {
            const newHtml = gameState.capturedByBlack
                .map(p => getPieceImgHtml(p.type, true, 16))
                .join('');
            safeUpdateHtml(mobileOpponentCaptured, newHtml);
        }

        // Timers
        updateTimerDisplay(mobilePlayerTimer, gameState.whiteTimeRemaining);
        updateTimerDisplay(mobileOpponentTimer, gameState.blackTimeRemaining);

        // Active player highlight
        document.querySelector('.player-bar').classList.toggle('active', gameState.isWhiteTurn);
        document.querySelector('.opponent-bar').classList.toggle('active', !gameState.isWhiteTurn);
    } else {
        // Black on bottom (player bar), White on top (opponent bar)
        mobilePlayerName.textContent = gameState.player2 + p2You;
        mobilePlayerElo.textContent = gameState.player2Elo ? `(${Math.round(gameState.player2Elo)})` : '';
        if (mobilePlayerColor) mobilePlayerColor.textContent = '(Black)';
        document.getElementById('mobile-player-captured').innerHTML = document.getElementById('black-captured').innerHTML;

        mobileOpponentName.textContent = gameState.player1 + p1You;
        mobileOpponentElo.textContent = gameState.player1Elo ? `(${Math.round(gameState.player1Elo)})` : '';
        if (mobileOpponentColor) mobileOpponentColor.textContent = '(White)';

        // Material advantage
        if (mobilePlayerMaterial && mobileOpponentMaterial) {
            if (materialDiff < 0) {
                mobilePlayerMaterial.textContent = `+${Math.abs(materialDiff)}`;
                mobilePlayerMaterial.className = 'material-mobile ahead';
                mobileOpponentMaterial.textContent = '';
                mobileOpponentMaterial.className = 'material-mobile';
            } else if (materialDiff > 0) {
                mobileOpponentMaterial.textContent = `+${materialDiff}`;
                mobileOpponentMaterial.className = 'material-mobile ahead';
                mobilePlayerMaterial.textContent = '';
                mobilePlayerMaterial.className = 'material-mobile';
            } else {
                mobilePlayerMaterial.textContent = '';
                mobileOpponentMaterial.textContent = '';
                mobilePlayerMaterial.className = 'material-mobile';
                mobileOpponentMaterial.className = 'material-mobile';
            }
        }

        // Captured pieces - Black's captures shown on Black's bar (captured white pieces)
        if (mobilePlayerCaptured && gameState.capturedByBlack) {
            const newHtml = gameState.capturedByBlack
                .map(p => getPieceImgHtml(p.type, true, 16))
                .join('');
            safeUpdateHtml(mobilePlayerCaptured, newHtml);
        }
        if (mobileOpponentCaptured && gameState.capturedByWhite) {
            const newHtml = gameState.capturedByWhite
                .map(p => getPieceImgHtml(p.type, false, 16))
                .join('');
            safeUpdateHtml(mobileOpponentCaptured, newHtml);
        }

        // Timers
        updateTimerDisplay(mobilePlayerTimer, gameState.blackTimeRemaining);
        updateTimerDisplay(mobileOpponentTimer, gameState.whiteTimeRemaining);

        // Active player highlight
        document.querySelector('.player-bar').classList.toggle('active', !gameState.isWhiteTurn);
        document.querySelector('.opponent-bar').classList.toggle('active', gameState.isWhiteTurn);
    }

    // Update variant badge
    if (mobileVariantBadge && gameState.variant && gameState.variant !== 'standard') {
        const variants = {
            'freestyle': '960',
            'kungfu': '⚡KF',
            'crazyhouse': '🏠',
            'kingofthehill': '⛰️'
        };
        mobileVariantBadge.textContent = variants[gameState.variant] || gameState.variant;
        mobileVariantBadge.style.display = 'inline';
    } else if (mobileVariantBadge) {
        mobileVariantBadge.style.display = 'none';
    }
}

// Call updateMobilePlayerBars in renderGame
const originalRenderGame = renderGame;
renderGame = function () {
    originalRenderGame();
    updateMobilePlayerBars();
};

// Mobile button event handlers
const mobileFlipBtn = document.getElementById('mobile-flip-btn');
const mobileDrawBtn = document.getElementById('mobile-draw-btn');
const mobileResignBtn = document.getElementById('mobile-resign-btn');

if (mobileFlipBtn) {
    mobileFlipBtn.addEventListener('click', () => {
        isFlipped = !isFlipped;
        reorderSquaresForFlip();
        updateBoard();
        updateBoardOrientation();
        updateMobilePlayerBars();
    });
}

if (mobileDrawBtn) {
    mobileDrawBtn.addEventListener('click', () => {
        drawBtn.click(); // Trigger the existing draw button
    });
}

if (mobileResignBtn) {
    mobileResignBtn.addEventListener('click', () => {
        resignBtn.click(); // Trigger the existing resign button
    });
}

// Confirmation Modal Handlers
const confirmMoveBtn = document.getElementById('confirm-move-btn');
const cancelMoveBtn = document.getElementById('cancel-move-btn');
const confirmationModal = document.getElementById('confirmation-modal');

if (confirmMoveBtn) {
    confirmMoveBtn.addEventListener('click', async () => {
        if (pendingMove) {
            await makeMove(pendingMove.startX, pendingMove.startY, pendingMove.endX, pendingMove.endY);
            pendingMove = null;
            confirmationModal.classList.remove('show');
            clearSelection();
        }
    });
}

if (cancelMoveBtn) {
    cancelMoveBtn.addEventListener('click', () => {
        pendingMove = null;
        confirmationModal.classList.remove('show');
    });
}

// ==================== Move History Navigation ====================

const navStartBtn = document.getElementById('nav-start');
const navBackBtn = document.getElementById('nav-back');
const navForwardBtn = document.getElementById('nav-forward');
const navEndBtn = document.getElementById('nav-end');
const moveCounterEl = document.getElementById('move-counter');
const moveNavigation = document.querySelector('.move-navigation');

// Check if we're viewing history (not the current position)
function isViewingHistory() {
    return historyViewIndex >= 0;
}

// Update the move counter display and button states
function updateNavigationUI() {
    const totalMoves = gameState?.moveHistory?.length || 0;
    const currentView = historyViewIndex < 0 ? totalMoves : historyViewIndex;

    console.log(`[NAV] updateNavigationUI: historyViewIndex=${historyViewIndex}, totalMoves=${totalMoves}, currentView=${currentView}`);

    if (moveCounterEl) {
        moveCounterEl.textContent = `${currentView}/${totalMoves}`;
    }

    // Update button states
    // Back/Start are disabled at position 0 (starting position)
    if (navStartBtn) navStartBtn.disabled = currentView === 0;
    if (navBackBtn) navBackBtn.disabled = currentView === 0;
    // Forward/End are disabled when at live position (historyViewIndex < 0)
    if (navForwardBtn) navForwardBtn.disabled = historyViewIndex < 0;
    if (navEndBtn) navEndBtn.disabled = historyViewIndex < 0;

    // Visual indicator for history mode
    if (moveNavigation) {
        moveNavigation.classList.toggle('viewing-history', isViewingHistory());
    }
    if (chessboard) {
        chessboard.classList.toggle('viewing-history', isViewingHistory());
    }
}

// Render a specific board state from history
function renderHistoricalBoard(moveIndex) {
    if (!gameState || !gameState.moveHistory) return;

    console.log(`[NAV] renderHistoricalBoard(${moveIndex}), totalMoves: ${gameState.moveHistory.length}`);

    // Build the board state at a specific move index
    // moveIndex = 0 means starting position (no moves applied)
    // moveIndex = N means board after moves 0..N-1 have been applied
    const board = buildBoardAtMove(moveIndex);
    if (!board) return;

    // Get the move for highlighting - this is the move that was just made to reach this position
    let lastMove = null;
    if (moveIndex > 0 && gameState.moveHistory[moveIndex - 1]) {
        lastMove = gameState.moveHistory[moveIndex - 1];
        console.log(`[NAV] Highlighting move ${moveIndex - 1}:`, lastMove);
    } else {
        console.log(`[NAV] No move to highlight (starting position)`);
    }

    if (typeof updateBoardCanvas === 'function') {
        updateBoardCanvas(board, lastMove);
        return;
    }

    // Render the historical board (legacy DOM)
    for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
            const square = document.getElementById(`square-${x}-${y}`);
            if (!square) continue;

            // Clear existing piece
            const existingPiece = square.querySelector('.piece');
            if (existingPiece) existingPiece.remove();

            // Remove valid move indicators
            const existingIndicator = square.querySelector('.valid-move-indicator');
            if (existingIndicator) existingIndicator.remove();

            // Update last-move highlight
            const isLastMoveSquare = lastMove && (
                (x === lastMove.startX && y === lastMove.startY) ||
                (x === lastMove.endX && y === lastMove.endY)
            );
            square.classList.toggle('last-move', isLastMoveSquare);

            // Add piece if present
            const piece = board[x][y];
            if (piece) {
                const pieceImg = document.createElement('img');
                pieceImg.className = 'piece';
                const color = piece.isWhite ? 'white' : 'black';
                pieceImg.src = `pieces/${color}-${piece.type}.png`;
                pieceImg.alt = `${color} ${piece.type}`;
                pieceImg.draggable = false; // Disable dragging in history mode
                square.appendChild(pieceImg);
                square.classList.add('has-piece');
            } else {
                square.classList.remove('has-piece');
            }
        }
    }
}

// Build the board state at a specific move index (0 = starting position)
function buildBoardAtMove(moveIndex) {
    if (!gameState) return null;

    // Start with the initial board setup - use variant and startPosId for Chess960
    const board = createInitialBoard(gameState.variant, gameState.startPosId);

    // Apply moves up to (but not including) moveIndex
    for (let i = 0; i < moveIndex && i < gameState.moveHistory.length; i++) {
        const move = gameState.moveHistory[i];
        applyMoveToBoard(board, move);
    }

    return board;
}

// Get Chess960 position from ID (Scharnagl's method)
function get960Position(id) {
    const pieceArr = new Array(8).fill(null);

    // 1. Place Bishops
    const lightSquares = [1, 3, 5, 7];
    const darkSquares = [0, 2, 4, 6];

    const r1 = id % 4;
    const q1 = Math.floor(id / 4);

    const r2 = q1 % 4;
    const q2 = Math.floor(q1 / 4);

    pieceArr[lightSquares[r1]] = 'bishop';
    pieceArr[darkSquares[r2]] = 'bishop';

    // 2. Place Queen
    const r3 = q2 % 6;
    const q3 = Math.floor(q2 / 6);

    let empty = pieceArr.map((p, i) => p === null ? i : -1).filter(i => i !== -1);
    pieceArr[empty[r3]] = 'queen';

    // 3. Place Knights (10 combinations for 2 knights in 5 slots)
    const knightConfigs = [
        [0, 1], [0, 2], [0, 3], [0, 4],
        [1, 2], [1, 3], [1, 4],
        [2, 3], [2, 4],
        [3, 4]
    ];

    const kConfig = knightConfigs[q3];
    empty = pieceArr.map((p, i) => p === null ? i : -1).filter(i => i !== -1);

    pieceArr[empty[kConfig[0]]] = 'knight';
    pieceArr[empty[kConfig[1]]] = 'knight';

    // 4. Place Rooks and King (remaining 3 slots: Rook, King, Rook)
    empty = pieceArr.map((p, i) => p === null ? i : -1).filter(i => i !== -1);
    pieceArr[empty[0]] = 'rook';
    pieceArr[empty[1]] = 'king';
    pieceArr[empty[2]] = 'rook';

    return pieceArr;
}

// Create an initial chess board (supports standard and Chess960 positions)
function createInitialBoard(variant, startPosId) {
    const board = Array(8).fill(null).map(() => Array(8).fill(null));

    // Setup pawns (same for all variants)
    for (let x = 0; x < 8; x++) {
        board[x][1] = { type: 'pawn', isWhite: false };
        board[x][6] = { type: 'pawn', isWhite: true };
    }

    // Setup back rows
    let backRow;
    if (variant === 'freestyle' && startPosId !== undefined && startPosId !== null) {
        // Chess960: Use the position ID to get the correct piece arrangement
        backRow = get960Position(startPosId);
    } else {
        // Standard chess position
        backRow = ['rook', 'knight', 'bishop', 'queen', 'king', 'bishop', 'knight', 'rook'];
    }

    for (let x = 0; x < 8; x++) {
        board[x][0] = { type: backRow[x], isWhite: false };
        board[x][7] = { type: backRow[x], isWhite: true };
    }

    return board;
}


// Apply a single move to a board state
function applyMoveToBoard(board, move) {
    // Handle Crazyhouse drop moves
    if (move.drop) {
        const isWhite = move.player && gameState ?
            (move.player.toLowerCase() === gameState.player1?.toLowerCase()) : true;
        board[move.x][move.y] = { type: move.pieceType, isWhite };
        return;
    }

    if (move.castling) {
        // Handle castling (supports Chess960 via rookStartX)
        const rank = move.startY;
        const isKingside = move.castling === 'kingside';

        // Use rookStartX from move history if available (Chess960), fall back to standard
        const rookFromX = move.rookStartX !== undefined ? move.rookStartX : (isKingside ? 7 : 0);
        const rookToX = isKingside ? 5 : 3;

        // Get pieces before clearing
        const king = board[move.startX][rank];
        const rook = board[rookFromX][rank];

        // Clear both starting squares first (handles cases where king/rook overlap destinations)
        board[move.startX][rank] = null;
        board[rookFromX][rank] = null;

        // Place pieces at destinations
        board[move.endX][rank] = king;
        board[rookToX][rank] = rook;
    } else if (move.enPassant) {
        // Handle en passant
        const piece = board[move.startX][move.startY];
        board[move.startX][move.startY] = null;
        board[move.endX][move.endY] = piece;
        // Remove captured pawn (same file as destination, same rank as start)
        board[move.endX][move.startY] = null;
    } else if (move.atomic) {
        // Handle atomic moves (captures cause explosions)
        const piece = board[move.startX][move.startY];
        const targetPiece = board[move.endX][move.endY];
        board[move.startX][move.startY] = null;

        if (targetPiece) {
            // Capture occurred — explosion!
            // Remove the capturing piece (it explodes too)
            board[move.endX][move.endY] = null;

            // Remove all adjacent non-pawn pieces
            for (let dx = -1; dx <= 1; dx++) {
                for (let dy = -1; dy <= 1; dy++) {
                    if (dx === 0 && dy === 0) continue;
                    const nx = move.endX + dx;
                    const ny = move.endY + dy;
                    if (nx >= 0 && nx < 8 && ny >= 0 && ny < 8) {
                        const adj = board[nx][ny];
                        if (adj && adj.type !== 'pawn') {
                            board[nx][ny] = null;
                        }
                    }
                }
            }
        } else {
            // Non-capture atomic move — just move the piece normally
            board[move.endX][move.endY] = piece;
        }
    } else {
        // Normal move
        const piece = board[move.startX][move.startY];
        board[move.startX][move.startY] = null;
        board[move.endX][move.endY] = piece;

        // Handle promotion
        if (piece && piece.type === 'pawn') {
            if ((piece.isWhite && move.endY === 0) || (!piece.isWhite && move.endY === 7)) {
                piece.type = move.promotionPiece || 'queen';
            }
        }
    }
}

// Navigate to start (position 0 = before any moves)
function navigateToStart() {
    console.log('[NAV] navigateToStart called');
    if (!gameState?.moveHistory?.length) {
        console.log('[NAV] No move history, returning');
        return;
    }
    historyViewIndex = 0;
    console.log(`[NAV] Set historyViewIndex to 0, calling renderHistoricalBoard(0)`);
    renderHistoricalBoard(0);
    updateNavigationUI();
    clearSelection();
}

// Navigate back one move
function navigateBack() {
    console.log('[NAV] navigateBack called');
    if (!gameState?.moveHistory?.length) {
        console.log('[NAV] No move history, returning');
        return;
    }

    const totalMoves = gameState.moveHistory.length;
    console.log(`[NAV] Current historyViewIndex=${historyViewIndex}, totalMoves=${totalMoves}`);

    let targetIndex;

    if (historyViewIndex === -1) {
        // Currently at live position (all moves applied)
        // Going back means showing state after totalMoves-1 moves
        targetIndex = totalMoves - 1;
        console.log(`[NAV] At live, going back to position ${targetIndex}`);
    } else if (historyViewIndex > 0) {
        // Already in history, go back one more
        targetIndex = historyViewIndex - 1;
        console.log(`[NAV] In history, going back from ${historyViewIndex} to ${targetIndex}`);
    } else {
        // Already at position 0, can't go back further
        console.log('[NAV] Already at position 0, cannot go back');
        return;
    }

    historyViewIndex = targetIndex;
    console.log(`[NAV] Rendering historical board at position ${historyViewIndex}`);
    renderHistoricalBoard(historyViewIndex);
    updateNavigationUI();
    clearSelection();
}

// Navigate forward one move  
function navigateForward() {
    console.log('[NAV] navigateForward called');
    if (!gameState?.moveHistory?.length) {
        console.log('[NAV] No move history, returning');
        return;
    }

    if (historyViewIndex === -1) {
        console.log('[NAV] Already at live position, cannot go forward');
        return;
    }

    const totalMoves = gameState.moveHistory.length;
    console.log(`[NAV] Current historyViewIndex=${historyViewIndex}, totalMoves=${totalMoves}`);

    const targetIndex = historyViewIndex + 1;
    console.log(`[NAV] Target index after increment: ${targetIndex}`);

    if (targetIndex >= totalMoves) {
        // Reached the live position
        console.log('[NAV] Reached live position, setting historyViewIndex=-1 and calling updateBoard');
        historyViewIndex = -1;
        updateBoard(true); // Force refresh to ensure board is restored correctly
    } else {
        // Still in history
        console.log(`[NAV] Moving forward to position ${targetIndex}`);
        historyViewIndex = targetIndex;
        renderHistoricalBoard(historyViewIndex);
    }

    updateNavigationUI();
    clearSelection();
}

// Navigate to end (live position)
function navigateToEnd() {
    console.log('[NAV] navigateToEnd called');
    if (historyViewIndex === -1) {
        console.log('[NAV] Already at live position');
        return;
    }

    console.log('[NAV] Returning to live position');
    historyViewIndex = -1;
    updateBoard(true); // Force refresh to ensure board is restored correctly
    updateNavigationUI();
    clearSelection();
}

// Event listeners for navigation buttons
if (navStartBtn) navStartBtn.addEventListener('click', navigateToStart);
if (navBackBtn) navBackBtn.addEventListener('click', navigateBack);
if (navForwardBtn) navForwardBtn.addEventListener('click', navigateForward);
if (navEndBtn) navEndBtn.addEventListener('click', navigateToEnd);

// Keyboard navigation
document.addEventListener('keydown', (e) => {
    // Only handle arrow keys if not typing in an input
    if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA') return;

    if (e.key === 'ArrowLeft') {
        e.preventDefault();
        navigateBack();
    } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        navigateForward();
    } else if (e.key === 'Home') {
        e.preventDefault();
        navigateToStart();
    } else if (e.key === 'End') {
        e.preventDefault();
        navigateToEnd();
    }
});

// Initial navigation UI update
setTimeout(() => {
    updateNavigationUI();
}, 1000);
