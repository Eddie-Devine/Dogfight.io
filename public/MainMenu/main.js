//logic for jet selection on main menu
(function () {
    const grid = document.querySelector('.jet-grid');
    if (!grid) return;

    let selected = null;

    grid.addEventListener('click', (e) => {
        const card = e.target.closest('.jet-card');
        if (!card) return;

        if (selected) selected.classList.remove('is-selected');
        card.classList.add('is-selected');
        selected = card;

        const jetId = card.getAttribute('data-jet');
        // TODO: pass selection to your game init logic
        // e.g., window.selectedJet = jetId;
        // console.log('Selected jet:', jetId);
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
})();
