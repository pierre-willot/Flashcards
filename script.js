// script.js - QuantumCards with Google Sheets & SM-2 algorithm (Complete)

let gapiInited = false;
let tokenClient;
let accessToken = null;
let spreadsheetId = localStorage.getItem('quantum_sheet_id') || '';
let currentUser = null;

let allCards = [];
let dueCards = [];
let currentCardIndex = 0;
let currentDeckFilter = 'all';
let isLoading = false;

// DOM elements
const dueCountSpan = document.getElementById('dueCount');
const totalCardsSpan = document.getElementById('totalCardsCount');
const masteredSpan = document.getElementById('masteredCount');
const deckListContainer = document.getElementById('deckListContainer');
const emptyStateDiv = document.getElementById('emptyState');
const activeCardDiv = document.getElementById('activeCard');
const flashcardDiv = document.getElementById('flashcard');
const cardFrontContent = document.querySelector('#cardFront .card-content');
const cardBackContent = document.querySelector('#cardBack .card-content');
const answerBtns = document.querySelectorAll('.answer-btn');
const cardDeckTagSpan = document.getElementById('cardDeckTag');
const cardDueHintSpan = document.getElementById('cardDueHint');
const authStatusDiv = document.getElementById('authStatus');
const sheetIdPreviewSpan = document.getElementById('sheetIdPreview');

// Helper: format date YYYY-MM-DD
function getTodayDate() {
    return new Date().toISOString().slice(0, 10);
}

function addDays(dateStr, days) {
    const d = new Date(dateStr);
    d.setDate(d.getDate() + days);
    return d.toISOString().slice(0, 10);
}

// SM-2 scheduling
function scheduleCard(card, grade) {
    const now = getTodayDate();
    card.lastReview = now;
    let newInterval = card.intervalDays;
    let newEase = card.easeFactor;

    if (grade === 'again') {
        newInterval = 1;
        newEase = Math.max(1.3, card.easeFactor - 0.2);
    } else if (grade === 'hard') {
        newInterval = Math.max(1, Math.floor(card.intervalDays * 1.2));
        newEase = Math.max(1.3, card.easeFactor - 0.15);
    } else if (grade === 'good') {
        newInterval = Math.floor(card.intervalDays * card.easeFactor);
    } else if (grade === 'easy') {
        newInterval = Math.floor(card.intervalDays * 1.3);
        newEase = Math.min(2.5, card.easeFactor + 0.15);
    }

    if (newInterval < 1) newInterval = 1;
    card.intervalDays = newInterval;
    card.easeFactor = newEase;
    card.dueDate = addDays(now, newInterval);
    return card;
}

// Wrapper for authenticated fetch that handles 401
async function authFetch(url, options = {}) {
    if (!accessToken) {
        throw new Error('No access token');
    }
    options.headers = {
        ...options.headers,
        'Authorization': `Bearer ${accessToken}`
    };
    let response = await fetch(url, options);
    if (response.status === 401 && tokenClient) {
        // Token expired, try to refresh
        return new Promise((resolve) => {
            tokenClient.callback = async (resp) => {
                if (resp.error) {
                    resolve(null);
                } else {
                    accessToken = resp.access_token;
                    localStorage.setItem('quantum_token', accessToken);
                    const retry = await fetch(url, {
                        ...options,
                        headers: { ...options.headers, 'Authorization': `Bearer ${accessToken}` }
                    });
                    resolve(retry);
                }
            };
            tokenClient.requestAccessToken({ prompt: '' });
        });
    }
    return response;
}

// Load cards from Sheets
async function loadCardsFromSheets() {
    if (!spreadsheetId || !accessToken) {
        console.warn("No sheet or token");
        return false;
    }
    try {
        const response = await authFetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/Flashcards!A:I`);
        if (!response) return false;
        const data = await response.json();
        const rows = data.values;
        if (!rows || rows.length <= 1) {
            // Create header if empty
            await authFetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/Flashcards!A1:I1?valueInputOption=RAW`, {
                method: 'PUT',
                body: JSON.stringify({ values: [['id', 'front', 'back', 'deck', 'tags', 'easeFactor', 'intervalDays', 'dueDate', 'lastReview']] })
            });
            allCards = [];
            return true;
        }
        const headers = rows[0];
        const cards = [];
        for (let i = 1; i < rows.length; i++) {
            const row = rows[i];
            if (!row[0]) continue;
            cards.push({
                id: row[0],
                front: row[1] || '',
                back: row[2] || '',
                deck: row[3] || 'General',
                tags: row[4] || '',
                easeFactor: parseFloat(row[5]) || 2.5,
                intervalDays: parseInt(row[6]) || 1,
                dueDate: row[7] || getTodayDate(),
                lastReview: row[8] || '',
                rowIndex: i
            });
        }
        allCards = cards;
        return true;
    } catch (e) {
        console.error(e);
        return false;
    }
}

async function updateCardInSheet(card) {
    if (!spreadsheetId || !accessToken) return false;
    const rowIndex = card.rowIndex;
    if (!rowIndex) return false;
    const range = `Flashcards!A${rowIndex + 1}:I${rowIndex + 1}`;
    const values = [
        [
            card.id, card.front, card.back, card.deck, card.tags,
            card.easeFactor, card.intervalDays, card.dueDate, card.lastReview
        ]
    ];
    try {
        await authFetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}?valueInputOption=USER_ENTERED`, {
            method: 'PUT',
            body: JSON.stringify({ values })
        });
        return true;
    } catch (e) {
        console.error(e);
        return false;
    }
}

async function appendCardToSheet(card) {
    if (!spreadsheetId || !accessToken) return false;
    const range = `Flashcards!A:I`;
    const values = [
        [
            card.id, card.front, card.back, card.deck, card.tags,
            card.easeFactor, card.intervalDays, card.dueDate, card.lastReview
        ]
    ];
    try {
        await authFetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}:append?valueInputOption=USER_ENTERED`, {
            method: 'POST',
            body: JSON.stringify({ values })
        });
        return true;
    } catch (e) {
        console.error(e);
        return false;
    }
}

// ---------- UI Functions ----------
function refreshUI() {
    const today = getTodayDate();
    const filtered = currentDeckFilter === 'all' ? allCards : allCards.filter(c => c.deck === currentDeckFilter);
    dueCards = filtered.filter(c => c.dueDate <= today).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
    dueCountSpan.innerText = dueCards.length;
    totalCardsSpan.innerText = allCards.length;
    const mastered = allCards.filter(c => c.easeFactor >= 2.3 && c.intervalDays >= 21).length;
    masteredSpan.innerText = mastered;

    if (dueCards.length === 0) {
        emptyStateDiv.style.display = 'flex';
        activeCardDiv.style.display = 'none';
    } else {
        emptyStateDiv.style.display = 'none';
        activeCardDiv.style.display = 'block';
        currentCardIndex = 0;
        displayCurrentCard();
    }
    renderDeckList();
}

function renderDeckList() {
    const decks = [...new Set(allCards.map(c => c.deck))];
    deckListContainer.innerHTML = `<button class="deck-filter ${currentDeckFilter === 'all' ? 'active' : ''}" data-deck="all">All decks (${allCards.length})</button>`;
    decks.forEach(deck => {
        const count = allCards.filter(c => c.deck === deck).length;
        const btn = document.createElement('button');
        btn.className = `deck-filter ${currentDeckFilter === deck ? 'active' : ''}`;
        btn.setAttribute('data-deck', deck);
        btn.innerHTML = `${deck} (${count})`;
        deckListContainer.appendChild(btn);
    });
    document.querySelectorAll('.deck-filter').forEach(btn => {
        btn.addEventListener('click', (e) => {
            currentDeckFilter = btn.getAttribute('data-deck');
            refreshUI();
        });
    });
}

function displayCurrentCard() {
    if (dueCards.length === 0) return;
    const card = dueCards[currentCardIndex];
    cardFrontContent.innerText = card.front;
    cardBackContent.innerText = card.back;
    flashcardDiv.classList.remove('flipped');
    cardDeckTagSpan.innerHTML = `<i class="fas fa-layer-group"></i> ${card.deck}  |  <i class="fas fa-tag"></i> ${card.tags || 'no tags'}`;
    cardDueHintSpan.innerHTML = `Due: ${card.dueDate} | EF: ${card.easeFactor.toFixed(2)}`;
}

async function handleAnswer(grade) {
    if (dueCards.length === 0) return;
    const card = dueCards[currentCardIndex];
    const updatedCard = scheduleCard(card, grade);
    // update in allCards and preserve rowIndex
    const idx = allCards.findIndex(c => c.id === updatedCard.id);
    if (idx !== -1) allCards[idx] = updatedCard;
    await updateCardInSheet(updatedCard);
    showToast(`Answered ${grade} – next review: ${updatedCard.dueDate}`);
    // refresh due list and advance
    refreshUI();  // recompute dueCards
    if (dueCards.length > 0 && currentCardIndex >= dueCards.length) currentCardIndex = 0;
    if (dueCards.length > 0) displayCurrentCard();
    else {
        emptyStateDiv.style.display = 'flex';
        activeCardDiv.style.display = 'none';
    }
}

function showToast(msg) {
    const toast = document.getElementById('toast');
    toast.innerText = msg;
    toast.style.opacity = '1';
    setTimeout(() => toast.style.opacity = '0', 2500);
}

// ---------- Data Load ----------
async function loadData() {
    const success = await loadCardsFromSheets();
    if (success) {
        refreshUI();
    } else {
        console.error("Failed to load cards");
        showToast("Failed to load cards from sheet");
    }
}

// ---------- Google Auth ----------
function initGoogleAPI() {
    if (!window.gapi) {
        console.error("Google APIs failed to load");
        authStatusDiv.innerHTML = `<i class="fas fa-exclamation-triangle"></i> Google APIs failed`;
        return;
    }
    gapi.load('client', async () => {
        try {
            await gapi.client.init({
                apiKey: '',
                discoveryDocs: ['https://sheets.googleapis.com/$discovery/rest?version=v4'],
            });
            gapiInited = true;
            if (accessToken) loadData();
        } catch (error) {
            console.error("Failed to initialize Google API client:", error);
            authStatusDiv.innerHTML = `<i class="fas fa-exclamation-triangle"></i> API init failed`;
        }
    });
}

function setupTokenClient() {
    if (!window.google || !window.google.accounts) {
        setTimeout(setupTokenClient, 100);
        return;
    }
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: '471539585536-v1f09grtv1na4ai2okq6pl08ff934jfb.apps.googleusercontent.com',
    scope: 'https://www.googleapis.com/auth/spreadsheets',
        callback: (resp) => {
            if (resp.error) {
                console.error(resp);
                authStatusDiv.innerHTML = `<i class="fas fa-exclamation-triangle"></i> Auth failed`;
                return;
            }
            accessToken = resp.access_token;
            localStorage.setItem('quantum_token', accessToken);
            authStatusDiv.innerHTML = `<i class="fas fa-check-circle"></i> Authenticated`;
            if (spreadsheetId) loadData();
        },
        ux_mode: 'popup',
        prompt: 'consent'
    });
}

// ---------- Event Listeners ----------
document.getElementById('syncNowBtn').addEventListener('click', () => {
    if (accessToken && spreadsheetId) loadData();
    else showToast("Please configure sheet and sign in");
});
document.getElementById('configSheetBtn').addEventListener('click', () => {
    document.getElementById('spreadsheetIdInput').value = spreadsheetId;
    document.getElementById('sheetModal').style.display = 'flex';
});
document.getElementById('saveSheetIdBtn').addEventListener('click', () => {
    const newId = document.getElementById('spreadsheetIdInput').value.trim();
    if (newId) {
        spreadsheetId = newId;
        localStorage.setItem('quantum_sheet_id', spreadsheetId);
        sheetIdPreviewSpan.innerText = spreadsheetId.slice(0, 10) + '...';
        if (accessToken) loadData();
        else showToast("Sign in first, then sync");
        document.getElementById('sheetModal').style.display = 'none';
    }
});
document.getElementById('addCardBtn').addEventListener('click', () => {
    document.getElementById('newCardModal').style.display = 'flex';
});
document.getElementById('confirmNewCardBtn').addEventListener('click', async () => {
    const front = document.getElementById('newFront').value.trim();
    const back = document.getElementById('newBack').value.trim();
    if (!front || !back) { showToast('Front and back required'); return; }
    const newCard = {
        id: crypto.randomUUID ? crypto.randomUUID() : Date.now() + '' + Math.random(),
        front, back,
        deck: document.getElementById('newDeck').value.trim() || 'General',
        tags: document.getElementById('newTags').value.trim(),
        easeFactor: 2.5,
        intervalDays: 1,
        dueDate: getTodayDate(),
        lastReview: '',
        rowIndex: null
    };
    const success = await appendCardToSheet(newCard);
    if (success) {
        showToast('Card added! Syncing...');
        await loadData();
        document.getElementById('newCardModal').style.display = 'none';
        document.getElementById('newFront').value = '';
        document.getElementById('newBack').value = '';
        document.getElementById('newDeck').value = '';
        document.getElementById('newTags').value = '';
    } else {
        showToast('Error adding card');
    }
});
document.getElementById('forceStudyBtn').addEventListener('click', () => {
    if (allCards.length > 0 && dueCards.length === 0) {
        dueCards = [...allCards];
        currentCardIndex = 0;
        emptyStateDiv.style.display = 'none';
        activeCardDiv.style.display = 'block';
        displayCurrentCard();
    } else refreshUI();
});
document.querySelectorAll('.close-modal').forEach(btn => {
    btn.addEventListener('click', () => {
        document.getElementById('sheetModal').style.display = 'none';
        document.getElementById('newCardModal').style.display = 'none';
    });
});
window.onclick = (e) => {
    if (e.target.classList.contains('modal')) e.target.style.display = 'none';
};
flashcardDiv.addEventListener('click', () => {
    flashcardDiv.classList.toggle('flipped');
});
answerBtns.forEach(btn => {
    btn.addEventListener('click', (e) => {
        const grade = btn.getAttribute('data-grade');
        if (grade) handleAnswer(grade);
    });
});

// ---------- Initialization ----------
window.addEventListener('load', () => {
    const storedToken = localStorage.getItem('quantum_token');
    if (storedToken) accessToken = storedToken;
    spreadsheetId = localStorage.getItem('quantum_sheet_id') || '';
    sheetIdPreviewSpan.innerText = spreadsheetId ? spreadsheetId.slice(0, 10) + '...' : 'No sheet linked';

    const googleApiInterval = setInterval(() => {
        if (window.gapi && window.google?.accounts) {
            clearInterval(googleApiInterval);
            initGoogleAPI();
            setupTokenClient();
            if (spreadsheetId && accessToken) loadData();
            else if (spreadsheetId) authStatusDiv.innerHTML = `<i class="fas fa-sign-in-alt"></i> Sign in required`;
            else authStatusDiv.innerHTML = `<i class="fas fa-cog"></i> Configure sheet`;
        }
    }, 200);
});