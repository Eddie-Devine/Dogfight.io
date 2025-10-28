// --------- DOM refs (cache once) ----------
const grid = document.querySelector('.jet-grid');
const jetPreview = document.querySelector('.jet-preview');
const startBtn = document.getElementById('start-btn');
const nameInput = document.getElementById('player-name');
const PLACEHOLDER_SRC = jetPreview?.src || '';

let selectedCard = null;
let selectedJet = null; // e.g., "F22"

// Ensure Start disabled initially
if (startBtn) startBtn.disabled = true;

// Utility: update start button based on selection + name
function updateStartButtonState() {
    const nameFilled = nameInput && nameInput.value.trim().length > 0;
    startBtn.disabled = !(selectedJet && nameFilled);
}

// Preview helpers
function setPreviewFromCard(card) {
    if (!card || !jetPreview) return;
    const img = card.querySelector('img');
    if (img) {
        jetPreview.src = img.src;
        jetPreview.alt = img.alt || '';
    }
}
function resetPreview() {
    if (!jetPreview) return;
    if (selectedCard) setPreviewFromCard(selectedCard);
    else {
        jetPreview.src = PLACEHOLDER_SRC;
        jetPreview.alt = 'No jet selected';
    }
}

// Selection
function selectCard(card) {
    if (!card) return;
    if (selectedCard) selectedCard.classList.remove('is-selected');
    card.classList.add('is-selected');
    selectedCard = card;
    selectedJet = card.dataset.jet || null;
    setPreviewFromCard(card);
    updateStartButtonState();
}

function deselectCard() {
    if (selectedCard) selectedCard.classList.remove('is-selected');
    selectedCard = null;
    selectedJet = null;
    resetPreview();
    updateStartButtonState();
}

// ---------- Event delegation for CLICK + KEYBOARD ----------
function setupJetSelection() {
    if (!grid) return;

    // Click to select / re-click to deselect
    grid.addEventListener('click', (e) => {
        const card = e.target.closest('.jet-card');
        if (!card || !grid.contains(card)) return;

        if (selectedCard === card) {
            deselectCard();
        } else {
            selectCard(card);
        }
    });

    // Keyboard: Enter/Space on focused card
    grid.addEventListener('keydown', (e) => {
        const card = e.target.closest('.jet-card');
        if (!card || !grid.contains(card)) return;

        if (e.key === 'Enter' || e.code === 'Space') {
            e.preventDefault();
            card.click(); // reuse click logic
        }
    });

    // Hover preview (mouseover/mouseout bubble; handle relatedTarget for true leave)
    grid.addEventListener('mouseover', (e) => {
        const card = e.target.closest('.jet-card');
        if (!card || !grid.contains(card)) return;
        setPreviewFromCard(card);
    });
    grid.addEventListener('mouseout', (e) => {
        const leavingCard = e.target.closest('.jet-card');
        if (!leavingCard || !grid.contains(leavingCard)) return;

        const toEl = e.relatedTarget;
        const stillInsideSameCard = leavingCard.contains(toEl);
        const movedOntoAnotherCard = toEl && toEl.closest && toEl.closest('.jet-card');

        if (stillInsideSameCard) return; // ignore child transitions
        if (movedOntoAnotherCard) return; // mouseover handler will set preview

        // Truly left all cards—restore selection or placeholder
        resetPreview();
    });

    // Name input updates Start state
    if (nameInput) {
        nameInput.addEventListener('input', updateStartButtonState);
    }

    // Start button -> server session + redirect
    if (startBtn) {
        startBtn.addEventListener('click', async () => {
            console.log(selectedJet);

            // Extra guard
            if (!selectedJet || !nameInput || !nameInput.value.trim()) return;

            try {
                const res = await fetch('/session/start', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name: nameInput.value.trim(), jet: selectedJet }),
                });
                const data = await res.json();
                if (res.ok && data.ok) {
                    window.location.href = '/game';
                } else {
                    alert(data.error || 'Could not start game session.');
                }
            } catch (err) {
                console.error(err);
                alert('Network error starting session.');
            }
        });
    }
}

// --------- Build grid from API then enable interactions ----------
async function fetchJetData() {
    try {
        const response = await fetch('/API/jets.json', {
            headers: { 'Accept': 'application/json' },
            cache: 'no-cache',
        });
        if (!response.ok) throw new Error(`HTTP ${response.status} - ${response.statusText}`);
        const data = await response.json();
        addJets(data); // builds DOM
        setupJetSelection(); // wire events after DOM exists
    } catch (err) {
        console.error('Error fetching JSON:', err);
    }
}

function addJets(jetData) {
    const jets = Array.isArray(jetData?.Jets) ? jetData.Jets : [];
    const gridEl = document.querySelector('.jet-grid');
    if (!gridEl) return;

    const frag = document.createDocumentFragment();

    jets.forEach(jet => {
        const code = jet['ID'] || 'N/A';
        const name = jet['Name'] || 'Unknown Jet';
        const iconPath = jet['Icon'] ? `/Images/JetIcons/${jet['Icon']}` : '/Images/placeholder-jet.jpg';

        const btn = document.createElement('button');
        btn.className = 'jet-card';
        btn.type = 'button';
        btn.dataset.jet = code;

        const img = document.createElement('img');
        img.src = iconPath;
        img.alt = name;

        const span = document.createElement('span');
        span.textContent = name;

        btn.appendChild(img);
        btn.appendChild(span);
        frag.appendChild(btn);
    });

    gridEl.appendChild(frag);
}

document.addEventListener('DOMContentLoaded', fetchJetData);