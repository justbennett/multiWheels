let state = [];  // Assigned in loadGameState after fetching defaultState
let defaultState = {}; // To be populated from staticValues.json
let prompts = {}; // To be populated from staticValues.json
let offices = []; // To be populated from staticValues.json
let marketingTypes = []; // To be populated from staticValues.json

let workerCostLabel = document.getElementById('hireWorkerCostLabel');
let requestMoneyCostLabel = document.getElementById('requestMoneyCostLabel');
let runForOfficeLabel = document.getElementById('runForOfficeLabel');


const moneyDisplay = document.getElementById('money');
const influenceDisplay = document.getElementById('influence');
const campaignWorkersDisplay = document.getElementById('campaignWorkers');
const powerLevelDisplay = document.getElementById('powerLevel');
const sentimentDisplay = document.getElementById('sentiment');
const officeDisplay = document.getElementById('currentOffice');

const shakeHandsBtn = document.getElementById('shakeHands');
const requestMoneyBtn = document.getElementById('requestMoney');
const runForOfficeBtn = document.getElementById('runForOffice');
const hireWorkerBtn = document.getElementById('hireWorker');
const marketingSection = document.getElementById('marketingSection');
const marketingTableBody = document.getElementById('marketingTableBody');


// include Office details from staticValues.json
function fetchOfficeData() {
    fetch('\staticValues.json')
        .then(response => response.json())
        .then(data => {
            offices = data.offices;
            defaultState = data.state;
            prompts = data.prompts;
            marketingTypes = data.marketing;

            // Load game state on page load
            loadGameState();
            // Ensure all values and labels are initialized after everything is set up
            updateGame();
        })
        .catch(error => {
            console.error('Error fetching office data:', error);
        });
}

fetchOfficeData();

shakeHandsBtn.addEventListener('click', () => {
    state.influence += 1;
});

requestMoneyBtn.addEventListener('click', () => {
    let perDonorAmount = state.averageDonation * state.sentiment / 100;
    let moneyGained = state.influence * perDonorAmount;
    let influenceLost = state.influence * (state.requestMoneyCost / 100);
    updateStatus(`Each of ${state.influence} supporters donated ${showCurrency(perDonorAmount)} for a total of ${showCurrency(moneyGained)}`);
    updateStatus(`Lost Influence: ${influenceLost}`);
    state.money += moneyGained; // Gain money based on current influence
    state.influence *= (100 - state.requestMoneyCost) / 100; // Lose a percentage of influence
    state.sentiment -= 5; // Decrease sentiment when requesting money
    if (state.sentiment < 0) state.sentiment = 0;
});

hireWorkerBtn.addEventListener('click', () => {
    if (state.money >= state.workerCost) {
        state.money -= state.workerCost;
        state.campaignWorkers += 1;
        state.workerCost = Math.floor(state.workerCost * 1.05); // Increase cost for next worker
    } else {
        alert('Not enough money to hire a campaign worker.');
    }
});


runForOfficeBtn.addEventListener('click', () => {
    if (state.money >= offices[state.powerLevel+1].cost ) {
        state.money -= offices[state.powerLevel+1].cost;
        if (state.influence * (state.sentiment/100) < offices[state.powerLevel+1].influenceNeeded) {
            alert('You lost the election due to insufficient influence. You need at least: ' + offices[state.powerLevel+1].influenceNeeded + ' supporters.');
            return;
        }
        state.powerLevel += 1;
        state.averageDonation += 1; // Increase average donation with each office won
        alert('You won the election. Empire expanded successfully!');
    } else {
        alert('You don\'t have enough money to run for this office.');
    }
});

// Generic collapsible handling for all <h2> headers. Makes sections togglable by click/keyboard.
function makeAllH2Togglable() {
    const headers = document.querySelectorAll('h2');
    headers.forEach(h2 => {
        // Skip headers inside modals
        if (h2.closest('.modal')) return;
        h2.classList.add('collapsible-header');
        h2.setAttribute('tabindex', '0');
        h2.setAttribute('role', 'button');
        h2.setAttribute('aria-expanded', 'true');

        function toggle() {
            const parent = h2.parentElement;
            if (parent && Array.from(parent.children).length > 1) {
                parent.classList.toggle('collapsed');
                const expanded = !parent.classList.contains('collapsed');
                h2.setAttribute('aria-expanded', expanded);
            } else if (h2.nextElementSibling) {
                const content = h2.nextElementSibling;
                // If this is the marketing header, ensure the table is updated when opening
                if (h2.id === 'marketingSection') upateMarketingTable();
                content.classList.toggle('show');
                // keep backwards-compatible visual marker for headers that use .open
                h2.classList.toggle('open');
                const expanded = content.classList.contains('show');
                h2.setAttribute('aria-expanded', expanded);
            }
        }

        h2.addEventListener('click', toggle);
        h2.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                toggle();
            }
        });
    });
}

// Enable collapsible behavior on page load
makeAllH2Togglable();


// Game loop Runs every second
setInterval(() => {
    if (state.campaignWorkers > 0) {
        state.influence += state.campaignWorkers * state.workerEfficency; // Each worker generates influence per interval
        influenceDisplay.textContent = state.influence.toFixed();
    }
    if (state.sentiment < 100) state.sentiment += 0.4; // Gradually recover sentiment   
    if (state.sentiment > 100) state.sentiment -= (state.sentiment - 100)/2; 
    sentimentDisplay.textContent = state.sentiment.toFixed(2);

}, 1000); // Update every 1 second

setInterval(() => {
    getPaid();
}, 60000); // Get paid every 60 seconds

function getPaid() {
    if (state.powerLevel != undefined) {
        let salary = offices[state.powerLevel].salary;
        state.money += salary;
        updateStatus(`Received salary of ${showCurrency(salary)} for holding the office of ${offices[state.powerLevel].name}.`);
    }
    moneyDisplay.textContent = showCurrency(state.money);
}

function saveGameState() {
    localStorage.setItem('gameState', JSON.stringify(state));
}

function loadGameState() {
    clearStatus();
    const savedState = localStorage.getItem('gameState');
    if (savedState) {
        state = JSON.parse(savedState);
        updateStatus('Game state loaded from localStorage.');
    } else {
        state = defaultState; // Use default state if no saved state
        updateStatus('No saved game state found. Using default state.');
    }
}

function updateButtonStates() {
    requestMoneyBtn.disabled = state.influence < 10;
    runForOfficeBtn.disabled = state.money < offices[state.powerLevel + 1].cost;
    hireWorkerBtn.disabled = state.money < state.workerCost;
    // Update marketing buttons
    marketingTypes.forEach((type, index) => {
        if(index > state.marketingLevel) return; // Only show marketing options up to current level
        const row = marketingTableBody.rows[index];
        if (row) { // Check if the row exists
            const actionButton = row.querySelector('button');
            actionButton.disabled = state.money < type.baseCost;
            row.classList.add('show');
        }
    });
    upateMarketingTable();
}

function upateMarketingTable() {
    marketingTableBody.innerHTML = ''; // Clear existing rows
    marketingTypes.forEach((type, index) => {
        if (type.baseCost < state.money  && state.marketingLevel < index) state.marketingLevel = index; 
                
        if (index > state.marketingLevel) return; // Only show marketing options up to current level
        
        const row = document.createElement('tr');
        const nameCell = document.createElement('td');
        nameCell.textContent = type.name;
        row.appendChild(nameCell);

        const costCell = document.createElement('td');
        costCell.textContent = showCurrency(type.baseCost);
        row.appendChild(costCell);

        const effectCell = document.createElement('td');
        effectCell.textContent = `+${type.influenceBoost} Influence`;
        row.appendChild(effectCell);

        const actionCell = document.createElement('td');
        const actionButton = document.createElement('button');
        actionButton.textContent = `Buy ${type.name}`;
        actionButton.disabled = state.money < type.baseCost;
        actionButton.addEventListener('click', () => {
            if (state.money >= type.baseCost) {
                state.money -= type.baseCost;
                state.influence += type.influenceBoost;
                state.sentiment += type.influenceBoost/2 || 0;
                updateStatus(`Purchased ${type.name} marketing for ${showCurrency(type.baseCost)}.`);
                updateGame();
            } else {
                alert('Not enough money to purchase this marketing option.');
            }
        });
        actionCell.appendChild(actionButton);
        row.appendChild(actionCell);
        row.id = `marketingRow-${type.name.replace(/\s+/g, '')}`; // Unique ID for the row

        marketingTableBody.appendChild(row);
    });
}

//update states whenever a value changes
function updateGame() {
    if (state.powerLevel > offices.length - 1) {
        state.powerLevel = offices.length - 1; // Cap power level to max defined office
    }
    updateButtonStates();
    influenceDisplay.textContent = state.influence.toFixed(2);
    moneyDisplay.textContent = showCurrency(state.money); 
    campaignWorkersDisplay.textContent = state.campaignWorkers;
    powerLevelDisplay.textContent = state.powerLevel;
    workerCostLabel.textContent = showCurrency(state.workerCost);
    requestMoneyCostLabel.textContent = state.requestMoneyCost;
    runForOfficeLabel.textContent = `${offices[state.powerLevel + 1].name} (-${showCurrency(offices[state.powerLevel + 1].cost)}/ ${offices[state.powerLevel + 1].influenceNeeded} Supporters)`;
    if (state.powerLevel > 0) {
        document.getElementById('prestige').style.display = 'block';
        document.getElementById('office').style.display = 'block';
    }
    officeDisplay.textContent = offices[state.powerLevel] ? offices[state.powerLevel].name : 'None';
    saveGameState();
}
// Update the game any time the mouse is clicked in the window
window.addEventListener('click', updateGame);

function showCurrency(amount){
    return amount.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

function updateStatus(message) {
    console.log(message);
    const statusDiv = document.getElementById('gameStatus');
    const p = document.createElement('p');
    p.textContent = message;
    statusDiv.appendChild(p);
    statusDiv.scrollTop = statusDiv.scrollHeight; // Auto-scroll to the bottom
}

function clearStatus() {
    const statusDiv = document.getElementById('gameStatus');
    statusDiv.innerHTML = '';
}

document.getElementById('menuButton').addEventListener('click', (e) => {
    const menuModal = document.getElementById('menuModal');
    //Toggle the show class
    menuModal.classList.toggle('show');
});


document.getElementById('saveGame').addEventListener('click', () => {
    saveGameState();
    // Save game state to a json file
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(state));
    const downloadAnchorNode = document.createElement('a');
    downloadAnchorNode.setAttribute("href", dataStr);
    downloadAnchorNode.setAttribute("download", "gameState.json");
    document.body.appendChild(downloadAnchorNode);
    downloadAnchorNode.click();
    downloadAnchorNode.remove();

    alert('Game saved successfully!');
});

document.getElementById('loadGame').addEventListener('click', () => {
    //load game state from a json file
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json';
    input.addEventListener('change', (event) => {
        const file = event.target.files[0];
        if (!file) {
            return;
        }
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                state = JSON.parse(e.target.result);
                updateGame();
                alert('Game loaded successfully!');
            } catch (error) {
                alert('Failed to load game: Invalid file format.');
            }
        };
        reader.readAsText(file);
    });
    input.click();
});

document.getElementById('restartGame').addEventListener('click', () => {
    if (confirm('Are you sure you want to restart the game? All progress will be lost.')) {
        state = { ...defaultState };
        clearStatus();
        updateGame();
        alert('Game restarted!');
    }
});

document.getElementById('instructions').addEventListener('click', () => {
    alert(prompts.instructions);
});