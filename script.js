document.addEventListener('DOMContentLoaded', () => {
    // --- Configuration ---
    const API_URL = '/api/predict';
    const TX_API_URL = '/api/treatment-simulation';

    // --- UI Elements ---
    const form = document.getElementById('prediction-form');
    const resetBtn = document.getElementById('reset-btn');
    const runBtn = document.getElementById('run-btn');
    const statusMsg = document.getElementById('status-msg');
    const driversList = document.getElementById('drivers-list');

    // Prognosis Card Elements
    const cards = [1, 2, 3, 4].map(i => ({
        title: document.getElementById(`card-title-${i}`),
        value: document.getElementById(`res-value-${i}`)
    }));

    // --- PLOTLY LAYOUT SETTINGS (Light Theme) ---
    const LIGHT_LAYOUT = {
        plot_bgcolor: 'rgba(0,0,0,0)',
        paper_bgcolor: 'rgba(0,0,0,0)',
        font: { color: '#334155', family: 'Inter, sans-serif' },
        xaxis: { 
            gridcolor: '#f1f5f9', showline: true, 
            linecolor: '#cbd5e1', zerolinecolor: '#cbd5e1'
        },
        yaxis: { 
            gridcolor: '#f1f5f9', showline: true, 
            linecolor: '#cbd5e1', zerolinecolor: '#cbd5e1',
            range: [0, 1.05] 
        },
        margin: { t: 50, b: 50, l: 60, r: 40 },
        legend: { orientation: 'h', y: 1.1 }
    };

    // =================================================
    // PART 1: PROGNOSIS DASHBOARD CHARTS
    // =================================================

    function renderPrimaryPlot(data, hazardData, modelType) {
        const time = data.map(d => d.time);
        const survivalProb = data.map(d => d.probability);
        const traces = [];
        
        // Trace 1: Survival Curve
        traces.push({
            x: time, y: survivalProb, mode: 'lines', fill: 'tozeroy',
            name: 'Survival S(t)',
            line: { color: modelType === 'deephit' ? '#111111' : '#10b981', width: 3 }
        });

        // Trace 2: Hazard Curve (Log Hazard Only)
        let layout = JSON.parse(JSON.stringify(LIGHT_LAYOUT)); 
        
        if (modelType === 'loghazard' && hazardData && hazardData.length > 0) {
            traces.push({
                x: hazardData.map(d => d.time),
                y: hazardData.map(d => d.probability * 10),
                mode: 'lines', name: 'Event Risk Density',
                line: { color: '#ef4444', width: 2, dash: 'dot' },
                yaxis: 'y2'
            });

            layout.yaxis2 = {
                title: 'Risk Intensity', overlaying: 'y', side: 'right',
                showgrid: false, range: [0, 1], font: { color: '#ef4444' }
            };
            layout.margin.r = 60; 
        }

        layout.title = { 
            text: modelType === 'deephit' ? 'Long-Term Survival Projection' : 'Survival vs. Event Risk Timing',
            font: { size: 16 }
        };
        layout.xaxis.title = 'Time (Days)';
        layout.yaxis.title = 'Survival Probability';

        Plotly.newPlot('survival-plot', traces, layout, {displayModeBar: false, responsive: true});
    }

    function renderRadarPlot(inputs) {
        const normAge = inputs['Age'] / 100;
        const normBMBP = inputs['BMBP'] / 100;
        const normRisk = inputs['Risk_Classification'] / 3;
        
        const data = [{
            type: 'scatterpolar',
            r: [normAge, normBMBP, normRisk, inputs['FLT3.ITD'], inputs['Transplant'], normAge],
            theta: ['Age', 'BMBP', 'Risk', 'FLT3', 'Transplant', 'Age'],
            fill: 'toself', name: 'Patient Profile',
            line: { color: '#2563eb' }, fillcolor: 'rgba(37, 99, 235, 0.2)'
        }];

        const layout = {
            polar: {
                radialaxis: { visible: true, range: [0, 1], gridcolor: '#e2e8f0' },
                angularaxis: { color: '#334155' },
                bgcolor: 'rgba(0,0,0,0)'
            },
            paper_bgcolor: 'rgba(0,0,0,0)',
            font: { color: '#334155', family: 'Inter, sans-serif' },
            margin: { t: 30, b: 30, l: 40, r: 40 },
            showlegend: false,
            title: { text: 'Patient Biomarker Profile', font: {size: 14} }
        };

        Plotly.newPlot('radar-plot', data, layout, {displayModeBar: false, responsive: true});
    }

    // =================================================
    // PART 2: LOGIC FOR METRICS & API
    // =================================================

    function updateMetricsDashboard(pred, userInputs, modelType) {
        if (modelType === 'deephit') {
            // DeepHit Metrics
            cards[0].title.textContent = "Overall Prognosis";
            cards[0].value.textContent = pred.risk_group === 'Low Risk' ? 'Favorable' : 'Guarded';
            cards[0].value.className = `value ${pred.risk_group === 'Low Risk' ? 'val-low' : 'val-high'}`;

            const curve = pred.survival_curve;
            const maxTime = curve[curve.length-1].time;
            const lastProb = curve[curve.length-1].probability;
            
            cards[1].title.textContent = "5-Year Survival Rate";
            cards[1].value.textContent = maxTime >= 1800 ? (lastProb * 100).toFixed(1) + "%" : "N/A (< 5yr data)";
            cards[1].value.className = "value val-neutral";

            cards[2].title.textContent = "Median Survival";
            cards[2].value.textContent = `${pred.median_survival_time_days} Days`;
            cards[2].value.className = "value val-neutral";

            cards[3].title.textContent = "Response Potential";
            const isTransplant = userInputs['Transplant'] === '1.0';
            cards[3].value.textContent = isTransplant ? "High" : "Moderate";
            cards[3].value.className = isTransplant ? "value val-low" : "value val-neutral";
        
        } else {
            // Log Hazard Metrics
            cards[0].title.textContent = "Risk Stratification";
            cards[0].value.textContent = pred.risk_group;
            cards[0].value.className = `value ${pred.risk_css}`;

            let maxDrop = 0; let peakTime = 0;
            const curve = pred.survival_curve;
            for(let i = 0; i < curve.length - 1; i++) {
                let drop = curve[i].probability - curve[i+1].probability;
                if (drop > maxDrop) { maxDrop = drop; peakTime = curve[i].time; }
            }
            cards[1].title.textContent = "Peak Risk Window";
            cards[1].value.textContent = peakTime < 90 ? `Early (Day ${peakTime.toFixed(0)})` : `Late (Day ${peakTime.toFixed(0)})`;
            cards[1].value.className = "value val-neutral";

            const percentile = Math.round((1 - pred.raw_risk_score_2yr) * 100);
            let cohortLabel = percentile > 75 ? `Top ${100-percentile}%` : (percentile < 25 ? `Bottom ${percentile}%` : "Average");
            let cohortClass = percentile > 75 ? "val-low" : (percentile < 25 ? "val-high" : "val-neutral");
            
            cards[2].title.textContent = "Cohort Standing";
            cards[2].value.textContent = cohortLabel;
            cards[2].value.className = `value ${cohortClass}`;

            const riskVal = parseFloat(userInputs['Risk_Classification']);
            const bmbpVal = parseFloat(userInputs['BMBP']);
            const severityScore = (riskVal * 20) + (bmbpVal * 0.5);
            let sevText = severityScore > 80 ? "Aggressive" : (severityScore < 40 ? "Indolent" : "Moderate");
            let sevClass = severityScore > 80 ? "val-high" : (severityScore < 40 ? "val-low" : "val-neutral");

            cards[3].title.textContent = "Condition Severity";
            cards[3].value.textContent = sevText;
            cards[3].value.className = `value ${sevClass}`;
        }
    }

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        runBtn.disabled = true;
        runBtn.innerHTML = 'Processing...';
        statusMsg.textContent = 'Running AI Inference...';
        statusMsg.style.color = 'var(--primary-brand)';

        const formData = new FormData(form);
        const modelType = formData.get('model_type');
        const userInputs = {};
        
        ['Age', 'Risk_Classification', 'BMBP', 'FLT3.ITD', 'Chemotherapy', 'Gender', 'Transplant'].forEach(key => {
            userInputs[key] = formData.get(key);
        });

        try {
            const response = await fetch(API_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model_type: modelType,
                    user_inputs: userInputs
                })
            });

            const res = await response.json();

            if (response.ok) {
                const pred = res.prediction;
                updateMetricsDashboard(pred, userInputs, modelType);

                if (driversList) {
                    driversList.innerHTML = pred.drivers.map(d => 
                        `<span class="driver-tag ${d.includes('+') ? 'good' : 'bad'}">${d}</span>`
                    ).join('');
                }

                renderPrimaryPlot(pred.survival_curve, pred.hazard_curve, modelType);
                renderRadarPlot(userInputs);
                
                statusMsg.textContent = 'Analysis Complete.';
                statusMsg.style.color = 'var(--secondary-brand)';
            } else {
                statusMsg.textContent = `Error: ${res.error}`;
                statusMsg.style.color = 'var(--risk-high)';
            }
        } catch (err) {
            console.error(err);
            statusMsg.textContent = 'Connection Failed. Is backend running?';
            statusMsg.style.color = 'var(--risk-high)';
        } finally {
            runBtn.disabled = false;
            runBtn.innerHTML = 'RUN ANALYSIS';
        }
    });

    // =================================================
    // PART 3: RISK FACTOR ANALYSIS (Tab 2)
    // =================================================
    const RISK_DATA = {
        'flt3': {
            title: 'Impact of FLT3-ITD Mutation',
            desc: "Patients with FLT3-ITD mutations (Red) show significantly steeper survival decline in the first 24 months compared to Wild Type (Green).",
            groups: [
                { name: 'Wild Type', y: [1, 0.92, 0.85, 0.78, 0.72, 0.68, 0.65], color: '#10b981' },
                { name: 'Mutated', y: [1, 0.80, 0.60, 0.45, 0.35, 0.25, 0.20], color: '#ef4444' }
            ]
        },
        'transplant': {
            title: 'Impact of Stem Cell Transplant',
            desc: "Transplantation (Blue) serves as a curative option, stabilizing survival rates after 12 months, whereas non-transplant patients (Grey) face continued risk.",
            groups: [
                { name: 'Received Transplant', y: [1, 0.95, 0.92, 0.88, 0.85, 0.82, 0.80], color: '#2563eb' },
                { name: 'No Transplant', y: [1, 0.85, 0.70, 0.55, 0.40, 0.30, 0.20], color: '#94a3b8' }
            ]
        },
        'risk': {
            title: 'Clinical Risk Classification',
            desc: "Adverse risk (Red) correlates with rapid early progression, while Favorable risk (Green) maintains >70% survival at 5 years.",
            groups: [
                { name: 'Favorable', y: [1, 0.95, 0.90, 0.85, 0.80, 0.78, 0.75], color: '#10b981' },
                { name: 'Intermediate', y: [1, 0.88, 0.75, 0.65, 0.55, 0.48, 0.45], color: '#f59e0b' },
                { name: 'Adverse', y: [1, 0.70, 0.50, 0.35, 0.25, 0.15, 0.10], color: '#ef4444' }
            ]
        }
    };

    const kmPlotDiv = document.getElementById('km-plot');
    if(kmPlotDiv) {
        if (!document.getElementById('risk-controls')) {
            const controlsDiv = document.createElement('div');
            controlsDiv.id = 'risk-controls';
            controlsDiv.style.marginBottom = '20px';
            controlsDiv.innerHTML = `
                <label for="risk-factor-select" style="font-weight:bold; color: var(--text-dark);">Select Cohort Factor:</label>
                <select id="risk-factor-select" style="width:auto; display:inline-block; margin-left:10px;">
                    <option value="flt3">FLT3-ITD Status</option>
                    <option value="transplant">Transplant Status</option>
                    <option value="risk">Risk Classification</option>
                </select>
                <p id="risk-desc" style="margin-top:10px; font-style:italic; color: var(--text-medium);"></p>
            `;
            kmPlotDiv.parentNode.insertBefore(controlsDiv, kmPlotDiv);
        }
        const renderRiskPlot = (key) => {
            const data = RISK_DATA[key];
            document.getElementById('risk-desc').textContent = data.desc;
            const traces = data.groups.map(g => ({
                x: [0, 12, 24, 36, 48, 60, 72], y: g.y,
                mode: 'lines+markers', name: g.name,
                line: { color: g.color, width: 3, shape: 'hv' }
            }));
            const layout = {
                ...LIGHT_LAYOUT,
                title: { text: data.title, font: {size: 16} },
                xaxis: { ...LIGHT_LAYOUT.xaxis, title: 'Time (Months)' },
                yaxis: { ...LIGHT_LAYOUT.yaxis, title: 'Survival Probability' },
                margin: { t: 50, b: 50, l: 60, r: 20 }
            };
            Plotly.newPlot('km-plot', traces, layout, {displayModeBar: false, responsive: true});
        };
        renderRiskPlot('flt3');
        document.getElementById('risk-factor-select').addEventListener('change', (e) => renderRiskPlot(e.target.value));
    }

    // =================================================
    // PART 4: TREATMENT SIMULATION (Tab 3)
    // =================================================

    const runTxBtn = document.getElementById('run-tx-btn');
    
    if (runTxBtn) {
        const txProfileSummary = document.getElementById('tx-profile-summary');
        const txBenefit = document.getElementById('tx-benefit');
        const txMedianGain = document.getElementById('tx-median-gain');

        runTxBtn.addEventListener('click', async () => {
            // Robust Input Collection
            const safeGetValue = (id) => {
                const el = document.getElementById(id);
                return el ? el.value : null;
            };

            const ageVal = safeGetValue('age');
            const riskVal = safeGetValue('risk_class');
            const bmbpVal = safeGetValue('bmbp');
            const flt3Val = safeGetValue('flt3');
            const chemoVal = safeGetValue('chemo');
            const genderVal = safeGetValue('gender');

            if (!ageVal || !riskVal) {
                alert("Error: Could not read patient data. Please ensure you are on the Dashboard tab.");
                return;
            }

            const userInputs = {
                'Age': ageVal,
                'Risk_Classification': riskVal,
                'BMBP': bmbpVal,
                'FLT3.ITD': flt3Val,
                'Chemotherapy': chemoVal,
                'Gender': genderVal,
                'Transplant': '0.0' // Overridden by backend
            };

            const riskMap = {'1.0': 'Favorable', '2.0': 'Intermediate', '3.0': 'Adverse'};
            const flt3Map = {'0.0': 'Wild Type', '1.0': 'Mutated'};

            if (txProfileSummary) {
                txProfileSummary.innerHTML = `
                    <li style="margin-bottom:5px;"><strong>Age:</strong> ${ageVal} Years</li>
                    <li style="margin-bottom:5px;"><strong>Risk:</strong> ${riskMap[riskVal] || riskVal}</li>
                    <li style="margin-bottom:5px;"><strong>Genetics:</strong> ${flt3Map[flt3Val] || flt3Val}</li>
                `;
            }

            runTxBtn.disabled = true;
            runTxBtn.textContent = 'Simulating Outcomes...';

            try {
                const response = await fetch(TX_API_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ user_inputs: userInputs })
                });

                const res = await response.json();

                if (response.ok) {
                    const benefit = res.survival_benefit_2yr;
                    const medGain = res.transplant_median - res.chemo_median;
                    
                    if(txBenefit) {
                        txBenefit.textContent = (benefit > 0 ? "+" : "") + benefit + "%";
                        txBenefit.className = `value ${benefit > 10 ? 'val-low' : (benefit < 0 ? 'val-high' : 'val-neutral')}`;
                    }
                    
                    if(txMedianGain) {
                        txMedianGain.textContent = (medGain > 0 ? "+" : "") + medGain + " Days";
                        txMedianGain.className = `value ${medGain > 100 ? 'val-low' : 'val-neutral'}`;
                    }

                    const traceChemo = {
                        x: res.chemo_curve.map(d => d.time),
                        y: res.chemo_curve.map(d => d.probability),
                        mode: 'lines', name: 'Standard Chemotherapy',
                        line: { color: '#94a3b8', width: 3, dash: 'dash' }
                    };

                    const traceTx = {
                        x: res.transplant_curve.map(d => d.time),
                        y: res.transplant_curve.map(d => d.probability),
                        mode: 'lines', name: 'With Transplant',
                        line: { color: '#2563eb', width: 4 }
                    };

                    const layout = {
                        ...LIGHT_LAYOUT,
                        title: { text: 'Survival Benefit: Chemo vs. Transplant', font: {size: 16} },
                        xaxis: { ...LIGHT_LAYOUT.xaxis, title: 'Time (Days)' },
                        yaxis: { ...LIGHT_LAYOUT.yaxis, title: 'Survival Probability' }
                    };

                    Plotly.newPlot('treatment-plot', [traceChemo, traceTx], layout, {displayModeBar: false, responsive: true});

                } else {
                    alert("Simulation Error: " + res.error);
                }
            } catch (err) {
                console.error(err);
                alert("Failed to connect to simulation server.");
            } finally {
                runTxBtn.disabled = false;
                runTxBtn.textContent = 'SIMULATE OUTCOMES';
            }
        });
    }

    // =================================================
    // PART 5: NAVIGATION LOGIC
    // =================================================
    document.querySelectorAll('.nav-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
            btn.classList.add('active');
            document.getElementById(btn.dataset.tab).classList.add('active');
            window.dispatchEvent(new Event('resize'));
        });
    });

    // =================================================
    // PART 6: CLINICAL TRIAL MATCHING (Tab 4)
    // =================================================
    
    // Mock Database
    const TRIAL_DATABASE = [
        { id: "NCT043289", title: "Novel FLT3 Inhibitor for Relapsed AML", criteria: (p) => p['FLT3.ITD'] === '1.0', type: "Targeted Therapy" },
        { id: "NCT055210", title: "Reduced-Intensity Conditioning for Elderly Patients", criteria: (p) => p['Age'] > 60, type: "Transplant Protocol" },
        { id: "NCT038472", title: "Post-Transplant Maintenance Therapy", criteria: (p) => p['Transplant'] === '1.0', type: "Maintenance" },
        { id: "NCT011239", title: "High-Dose Cytarabine Optimization", criteria: (p) => p['Risk_Classification'] === '3.0', type: "Chemotherapy" },
        { id: "NCT099821", title: "Long-Term Follow-up of AML Survivors", criteria: (p) => true, type: "Observational" } 
    ];

    const findTrialsBtn = document.getElementById('find-trials-btn');
    const trialsResults = document.getElementById('trials-results');

    if (findTrialsBtn) {
        findTrialsBtn.addEventListener('click', () => {
            const safeGetValue = (id) => {
                const el = document.getElementById(id);
                return el ? el.value : null;
            };

            const patientProfile = {
                'Age': safeGetValue('age'),
                'Risk_Classification': safeGetValue('risk_class'),
                'FLT3.ITD': safeGetValue('flt3'),
                'Transplant': safeGetValue('transplant')
            };

            const ageDisplay = document.getElementById('trial-age-display');
            const flt3Display = document.getElementById('trial-flt3-display');
            if (ageDisplay) ageDisplay.textContent = patientProfile['Age'];
            if (flt3Display) flt3Display.textContent = patientProfile['FLT3.ITD'] === '1.0' ? 'Mutated' : 'Wild Type';

            const matches = TRIAL_DATABASE.filter(trial => trial.criteria(patientProfile));

            if (trialsResults) {
                trialsResults.innerHTML = matches.map(t => `
                    <div class="stat-card" style="text-align: left; border-left: 4px solid var(--primary-brand); margin-bottom: 10px;">
                        <h4 style="color: var(--primary-brand); margin-bottom: 5px;">${t.type}</h4>
                        <div class="value" style="font-size: 1.1rem;">${t.title}</div>
                        <div style="font-size: 0.85rem; color: var(--text-medium); margin-top: 5px;">ID: ${t.id} • Status: Recruiting</div>
                    </div>
                `).join('');
            }
        });
    }

    // --- Master Reset Logic ---
    resetBtn.onclick = () => { 
        form.reset(); 
        document.getElementById('out-age').value = "45";
        document.getElementById('out-bmbp').value = "15";

        Plotly.purge('survival-plot');
        Plotly.purge('radar-plot');
        if(driversList) driversList.innerHTML = '<span class="driver-placeholder">Run analysis to identify key clinical drivers.</span>';
        
        cards.forEach(c => { c.value.textContent = "--"; c.value.className = "value val-neutral"; });
        statusMsg.textContent = "Dashboard Reset.";
        
        if(document.getElementById('treatment-plot')) Plotly.purge('treatment-plot');
        if(document.getElementById('tx-benefit')) document.getElementById('tx-benefit').textContent = "--%";
        if(document.getElementById('tx-median-gain')) document.getElementById('tx-median-gain').textContent = "-- Days";

        if(trialsResults) trialsResults.innerHTML = '<div class="stat-card" style="text-align: left; color: var(--text-medium);">No trials loaded. Click "Find Matching Trials" to search the database.</div>';
    };
});