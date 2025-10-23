//Makes the jet grid interactive for selection
function setupJetSelection() {
    const grid = document.querySelector('.jet-grid'); //jet selection grid
    if (!grid) return; //failsafe 

    let selected = null; //the selected card
    const jetPreview = document.querySelector('.jet-preview'); //the stage for selected card
    const PLACEHOLDER_SRC = jetPreview.src; //the default image set in the HTML

    //when jet is selectedj
    grid.addEventListener('click', (e) => {
        const card = e.target.closest('.jet-card');
        if (!card) return; //failsafe

        // Toggle off if clicking the same selected card
        if (selected === card) {
            card.classList.remove('is-selected');
            selected = null;
            if (jetPreview) {
                jetPreview.src = PLACEHOLDER_SRC;
                jetPreview.alt = 'No jet selected';
            }
            return;
        }

        // Normal select flow
        if (selected) selected.classList.remove('is-selected');
        card.classList.add('is-selected');
        selected = card;

        const img = card.querySelector('img');
        if (img && jetPreview) {
            jetPreview.src = img.src;
            jetPreview.alt = img.alt || '';
        }
    });

    // Keyboard support (Enter/Space)
    grid.querySelectorAll('.jet-card').forEach((card) => {
        card.setAttribute('type', 'button');
        card.setAttribute('tabindex', '0');
        card.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.code === 'Space') {
                e.preventDefault();
                card.click();
            }
        });
    });

    //add more hover response to jet cards
    grid.querySelectorAll('.jet-card').forEach((card) => {
        card.addEventListener('mouseenter', () => {
            console.log('Hovered over:', card.dataset.jet);
            const img = card.querySelector('img');
            jetPreview.src = img.src;
        });

        card.addEventListener('mouseleave', () => {
            console.log('Stopped hovering:', card.dataset.jet);
            if (selected) {
                const selImg = selected.querySelector('img');
                if (selImg) {
                    jetPreview.src = selImg.src;
                    jetPreview.alt = selImg.alt || '';
                }
            }
            else {
                jetPreview.src = PLACEHOLDER_SRC;
            }
        });
    });
}

//add jets to gird
function addJets(jetData) {
    const jets = jetData['Jets'];
    const grid = document.querySelector('.jet-grid');
    jets.forEach(jet => {
        // Create <button>
        const btn = document.createElement('button');
        btn.className = 'jet-card';
        btn.dataset.jet = jet['Code'] || 'N/A'; //set code to make proccesing easier

        // Create <img>
        const img = document.createElement('img');
        img.src = `/Images/JetIcons/${jet["Icon"]}` || '/Images/placeholder-jet.jpg';
        img.alt = jet['Name'] || 'Unknown Jet';

        // Create <span>
        const span = document.createElement('span');
        span.textContent = jet['Name'] || 'Unknown Jet';

        // Build structure
        btn.appendChild(img);
        btn.appendChild(span);

        // Add to DOM
        grid.appendChild(btn);
    });
    setupJetSelection();
}

//get jets from api
async function fetchJetData() {
    try {
        const response = await fetch('/API/jets.json', {
            headers: {
                'Accept': 'application/json'
            },
            cache: 'no-cache' // ensures fresh copy each time (especially in dev)
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status} - ${response.statusText}`);
        }

        const data = await response.json();
        return addJets(data); // you can handle or return this
    } catch (err) {
        console.error('Error fetching JSON:', err);
        return null;
    }
}

document.addEventListener('DOMContentLoaded', () => {
    fetchJetData();
});