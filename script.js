// script.js - QuantumCards with Google Sheets & SM-2 algorithm (FIXED)

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
    return new Date().toISOString().slice(0,10);
}

function addDays(dateStr, days) {
    const d = new Date(dateStr);
    d.setDate(d.getDate() + days);
    return d.toISOString().slice(0,10);
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
            // create header if empty
            await authFetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/Flashcards!A1:I1?valueInputOption=RAW`, {
                method: 'PUT',
                body: JSON.stringify({ values: [['id','front','back','deck','tags','easeFactor','intervalDays','dueDate','lastReview']] })
            });
            allCards = [];
            return true;
        }
        const headers = rows[0];
        const cards = [];
        for (let i=1; i<rows.length; i++) {
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
    } catch(e) { console.error(e); return false; }
}

async function updateCardInSheet(card) {
    if (!spreadsheetId || !accessToken) return false;
    const rowIndex = card.rowIndex;
    if (!rowIndex) return false;
    const range = `Flashcards!A${rowIndex+1}:I${rowIndex+1}`;
    const values = [[
        card.id, card.front, card.back, card.deck, card.tags,
        card.easeFactor, card.intervalDays, card.dueDate, card.lastReview
    ]];
    try {
        await authFetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}?valueInputOption=USER_ENTERED`, {
            method: 'PUT',
            body: JSON.stringify({ values })
        });
        return true;
    } catch(e) { console.error(e); return false; }
}

async function appendCardToSheet(card) {
    if (!spreadsheetId || !accessToken) return false;
    const range = `Flashcards!A:I`;
    const values = [[
        card.id, card.front, card.back, card.deck, card.tags,
        card.easeFactor, card.intervalDays, card.dueDate, card.lastReview
    ]];
    try {
        await authFetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}:append?valueInputOption=USER_ENTERED`, {
            method: 'POST',
            body: JSON.stringify({ values })
        });
        return true;
    } catch(e) { console.error(e); return false; }
}

// UI refresh functions (unchanged but ensure they are defined)
function refreshUI() { /* same as original */ }
function renderDeckList() { /* same as original */ }
function displayCurrentCard() { /* same as original */ }
async function handleAnswer(grade) { /* same as original but with updated logic */ }
function showToast(msg) { /* same as original */ }

// Google Auth initialization with proper library checks
function initGoogleAPI() {
    gapi.load('client', async () => {
        await gapi.client.init({
            apiKey: '', // optional, but you can add one if needed
            discoveryDocs: ['https://sheets.googleapis.com/$discovery/rest?version=v4'],
        });
        gapiInited = true;
        if (accessToken) loadData();
    });
}

function setupTokenClient() {
    // Wait for the GSI library to be available
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
            loadData();
        },
    });
}

// Add event listeners and other functions as in original, but ensure all references are correct

// Finally, on page load
window.addEventListener('load', () => {
    const storedToken = localStorage.getItem('quantum_token');
    if (storedToken) accessToken = storedToken;
    spreadsheetId = localStorage.getItem('quantum_sheet_id') || '';
    sheetIdPreviewSpan.innerText = spreadsheetId ? spreadsheetId.slice(0,10)+'...' : 'No sheet linked';
    initGoogleAPI();
    setupTokenClient(); // now waits for GSI
    if (spreadsheetId && accessToken) loadData();
    else if (spreadsheetId) authStatusDiv.innerHTML = `<i class="fas fa-sign-in-alt"></i> Sign in required`;
    else authStatusDiv.innerHTML = `<i class="fas fa-cog"></i> Configure sheet`;
});