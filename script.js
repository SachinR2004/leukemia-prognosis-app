document.addEventListener('DOMContentLoaded', () => {
    // --- Configuration ---
    const API_URL = '/api/predict';
    const TX_API_URL = '/api/treatment-simulation';
    const TRIALS_API_URL = '/api/clinical-trials';
    
    const form = document.getElementById('prediction-form');
    const resetBtn = document.getElementById('reset-btn');
    const runBtn = document.getElementById('run-btn');
    const statusMsg = document.getElementById('status-msg');
    const driversList = document.getElementById('drivers-list');

    const cards = [1, 2, 3, 4].map(i => ({
        title: document.getElementById(`card-title-${i}`),
        value: document.getElementById(`res-value-${i}`),
        container: document.getElementById(`card-title-${i}`).parentElement 
    }));

    const LIGHT_LAYOUT = {
        plot_bgcolor: 'rgba(0,0,0,0)',
        paper_bgcolor: 'rgba(0,0,0,0)',
        font: { color: '#334155', family: 'Inter, sans-serif' },
        xaxis: { gridcolor: '#f1f5f9', showline: true, linecolor: '#cbd5e1', zerolinecolor: '#cbd5e1' },
        yaxis: { gridcolor: '#f1f5f9', showline: true, linecolor: '#cbd5e1', zerolinecolor: '#cbd5e1', range: [0, 1.05] },
        margin: { t: 50, b: 50, l: 60, r: 40 },
        legend: { orientation: 'h', y: 1.1 }
    };

    // --- Helper: Calculate RMST ---
    function calculateRMST(curve, maxDays=1825) {
        let area = 0;
        for (let i = 0; i < curve.length - 1; i++) {
            let t1 = curve[i].time;
            let t2 = curve[i+1].time;
            if (t1 >= maxDays) break; 
            let p1 = curve[i].probability;
            let p2 = curve[i+1].probability;
            let dt = Math.min(t2, maxDays) - t1;
            if (dt > 0) area += dt * (p1 + p2) / 2;
        }
        let years = area / 365;
        return years.toFixed(1) + " Years";
    }

    // --- Charts ---
    function renderPrimaryPlot(data, hazardData, modelType) {
        const time = data.map(d => d.time);
        const survivalProb = data.map(d => d.probability);
        const traces = [];
        
        if (modelType === 'loghazard') {
            const riskProb = survivalProb.map(p => 1 - p);
            traces.push({ x: time, y: survivalProb, mode: 'lines', fill: 'tozeroy', name: 'Survival', line: { color: '#10b981', width: 0 }, fillcolor: 'rgba(16, 185, 129, 0.6)' });
            traces.push({ x: time, y: riskProb, mode: 'lines', name: 'Risk', line: { color: '#ef4444', width: 3 }, fill: 'tonexty' });
        } else {
            const finalProb = survivalProb[survivalProb.length - 1];
            const lineColor = finalProb > 0.5 ? '#10b981' : '#ef4444';
            const fillColor = finalProb > 0.5 ? 'rgba(16, 185, 129, 0.3)' : 'rgba(239, 68, 68, 0.2)';
            traces.push({ x: time, y: survivalProb, mode: 'lines', fill: 'tozeroy', name: 'Survival S(t)', line: { color: lineColor, width: 4 }, fillcolor: fillColor });
        }

        let layout = JSON.parse(JSON.stringify(LIGHT_LAYOUT)); 
        layout.title = { text: modelType === 'deephit' ? 'Projected Survival Trajectory' : 'Survival vs. Cumulative Risk', font: { size: 16 } };
        layout.xaxis.title = 'Time (Days)'; layout.yaxis.title = 'Probability';
        Plotly.newPlot('survival-plot', traces, layout, {displayModeBar: false, responsive: true});
    }

    function renderRadarPlot(inputs) {
        const normAge = inputs['Age'] / 100;
        const normBMBP = inputs['BMBP'] / 100;
        const normNPM1 = inputs['NPM1'] === '1.0' ? 1 : 0; 
        
        const data = [{ 
            type: 'scatterpolar', 
            r: [normAge, normBMBP, inputs['FLT3.ITD'], inputs['Transplant'], normNPM1, normAge], 
            theta: ['Age', 'BMBP', 'FLT3', 'Transplant', 'NPM1', 'Age'], 
            fill: 'toself', name: 'Patient Profile', line: { color: '#111111' }, fillcolor: 'rgba(17, 17, 17, 0.2)' 
        }];
        
        const layout = { polar: { radialaxis: { visible: true, range: [0, 1], gridcolor: '#e2e8f0' }, angularaxis: { color: '#334155' }, bgcolor: 'rgba(0,0,0,0)' }, paper_bgcolor: 'rgba(0,0,0,0)', font: { color: '#334155', family: 'Inter, sans-serif' }, margin: { t: 30, b: 30, l: 40, r: 40 }, showlegend: false, title: { text: 'Patient Biomarker Profile', font: {size: 14} } };
        Plotly.newPlot('radar-plot', data, layout, {displayModeBar: false, responsive: true});
    }

    function generateBoldAnalysis(pred, userInputs, rmst) {
        const riskGroup = pred.risk_group;
        const riskScore = (pred.raw_risk_score_2yr * 100).toFixed(1);
        const isTransplant = userInputs['Transplant'] === '1.0';
        const isNPM1 = userInputs['NPM1'] === '1.0';
        
        let html = "";
        if (riskGroup === 'Low Risk') {
            html += `<strong>STATUS: STABLE.</strong> Excellent prognosis with an expected survival of <strong>${rmst}</strong> (over next 5 years). `;
        } else if (riskGroup === 'Intermediate') {
            html += `<strong>STATUS: GUARDED.</strong> Moderate risk profile (${riskScore}% 2-year risk). Expected survival: <strong>${rmst}</strong>. `;
        } else {
            html += `<strong>STATUS: CRITICAL.</strong> High-risk profile detected. Expected survival is limited to <strong>${rmst}</strong> without intervention. `;
        }
        
        html += "<br><br>";
        if (isTransplant) {
            html += "✅ <strong>Transplant Effect:</strong> The Allogeneic Stem Cell Transplant is successfully buffering the genetic risk factors.";
        } else if (isNPM1) {
            html += "🧬 <strong>Genetics:</strong> Presence of NPM1 mutation is a favorable prognostic indicator, improving treatment response.";
        } else if (riskGroup !== 'Low Risk') {
            html += "⚠️ <strong>Intervention Needed:</strong> Absence of transplant and adverse cytogenetics are primary drivers of this risk.";
        }
        return html;
    }

    function updateMetricsDashboard(pred, userInputs, modelType) {
        const bmbpVal = parseFloat(userInputs['BMBP']);
        const ageVal = parseFloat(userInputs['Age']);
        const riskVal = 2.0; 
        
        // Severity Score
        const ageFactor = ageVal > 60 ? 30 : (ageVal > 40 ? 15 : 0);
        const severityScore = (riskVal * 20) + (bmbpVal * 0.5) + ageFactor;
        
        let sevText = "Moderate";
        let sevClass = "val-neutral";
        if (severityScore >= 80) { sevText = "Aggressive"; sevClass = "val-high"; }
        else if (severityScore <= 50) { sevText = "Indolent"; sevClass = "val-low"; }
        
        const curve = pred.survival_curve;

        // --- DEEP HIT METRICS ---
        if (modelType === 'deephit') {
            cards.forEach(c => c.container.style.display = 'block');

            cards[0].title.textContent = "2-Year Survival";
            const prob2yr = (1 - pred.raw_risk_score_2yr) * 100;
            cards[0].value.textContent = prob2yr.toFixed(1) + "%";
            cards[0].value.className = prob2yr > 70 ? "value val-low" : (prob2yr < 40 ? "value val-high" : "value val-neutral");

            // Median Survival in Years
            cards[1].title.textContent = "Median Survival Estimate";
            const medianPoint = curve.find(p => p.probability <= 0.5);
            let medianText = "> 5 Years";
            if (medianPoint) {
                const years = (medianPoint.time / 365).toFixed(1);
                medianText = `${years} Years`;
            }
            cards[1].value.textContent = medianText;
            cards[1].value.className = "value val-neutral";

            // Disease Indolence
            cards[2].title.textContent = "Disease Indolence";
            const p1 = curve.find(p => p.time >= 365)?.probability || 1.0;
            const p5 = curve.find(p => p.time >= 1800)?.probability || 0.0;
            const drop = p1 - p5;
            let indolenceText = "Moderate";
            let indolenceClass = "val-neutral";
            if (drop < 0.15 && p5 > 0.5) { indolenceText = "High (Stable)"; indolenceClass = "val-low"; }
            else if (drop > 0.4) { indolenceText = "Low (Aggressive)"; indolenceClass = "val-high"; }
            cards[2].value.textContent = indolenceText;
            cards[2].value.className = `value ${indolenceClass}`;
            cards[2].value.style.fontSize = "1.3rem";

            // Condition Severity
            cards[3].title.textContent = "Condition Severity";
            cards[3].value.textContent = sevText;
            cards[3].value.className = `value ${sevClass}`;

        // --- LOG HAZARD METRICS ---
        } else {
            cards[3].container.style.display = 'none'; // Hide 4th card
            
            cards[0].title.textContent = "Risk Stratification";
            cards[0].value.textContent = pred.risk_group;
            cards[0].value.className = `value ${pred.risk_css}`;

            const prob1yr = curve.find(p => p.time >= 365)?.probability || 1.0;
            const relapseRisk = ((1 - prob1yr) * 100).toFixed(1) + "%";
            cards[1].title.textContent = "1-Year Relapse Risk";
            cards[1].value.textContent = relapseRisk;
            cards[1].value.className = (1-prob1yr) > 0.4 ? "value val-high" : "value val-low";

            const percentile = Math.round((1 - pred.raw_risk_score_2yr) * 100);
            let cohortLabel = percentile > 75 ? `Top ${100-percentile}%` : "Average";
            cards[2].title.textContent = "Cohort Standing";
            cards[2].value.textContent = cohortLabel;
            cards[2].value.className = "value val-neutral";
            cards[2].value.style.fontSize = "1.4rem";
        }
        
        const rmst = calculateRMST(curve);
        const analysisHtml = generateBoldAnalysis(pred, userInputs, rmst);
        document.getElementById('bold-analysis-text').innerHTML = analysisHtml;
        document.getElementById('bold-analysis-container').style.display = 'block';
    }

    // --- PREDICTION HANDLER ---
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        runBtn.disabled = true;
        runBtn.innerHTML = 'Processing...';
        statusMsg.textContent = 'Running AI Inference...';
        const formData = new FormData(form);
        const userInputs = {};
        ['Age', 'BMBP', 'FLT3.ITD', 'NPM1', 'Chemotherapy', 'Gender', 'Transplant'].forEach(key => { userInputs[key] = formData.get(key); });
        
        // AUTO-CALCULATE RISK
        // Simple logic: FLT3=1 -> Adverse(3.0), NPM1=1 -> Favorable(1.0), Else -> Intermediate(2.0)
        if (userInputs['FLT3.ITD'] === '1.0') userInputs['Risk_Classification'] = '3.0';
        else if (userInputs['NPM1'] === '1.0') userInputs['Risk_Classification'] = '1.0';
        else userInputs['Risk_Classification'] = '2.0';

        try {
            const response = await fetch(API_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model_type: formData.get('model_type'), user_inputs: userInputs }) });
            const res = await response.json();
            if (response.ok) {
                updateMetricsDashboard(res.prediction, userInputs, formData.get('model_type'));
                if (driversList) driversList.innerHTML = res.prediction.drivers.map(d => `<span class="driver-tag ${d.includes('+') ? 'good' : 'bad'}">${d}</span>`).join('');
                renderPrimaryPlot(res.prediction.survival_curve, res.prediction.hazard_curve, formData.get('model_type'));
                renderRadarPlot(userInputs);
                statusMsg.textContent = 'Analysis Complete.';
            } else { statusMsg.textContent = `Error: ${res.error}`; }
        } catch (err) { console.error(err); statusMsg.textContent = 'Connection Failed.'; } finally { runBtn.disabled = false; runBtn.innerHTML = 'RUN ANALYSIS'; }
    });

    // --- TREATMENT SIMULATION ---
    const runTxBtn = document.getElementById('run-tx-btn');
    if (runTxBtn) {
        const txProfileSummary = document.getElementById('tx-profile-summary');
        const txRiskReduction = document.getElementById('tx-risk-reduction');
        const txCureProb = document.getElementById('tx-cure-prob');

        runTxBtn.addEventListener('click', async () => {
            const safeGetValue = (id) => { const el = document.getElementById(id); return el ? el.value : null; };
            const ageVal = safeGetValue('age');
            const bmbpVal = safeGetValue('bmbp');
            const flt3Val = safeGetValue('flt3');
            const npm1Val = safeGetValue('npm1');
            const chemoVal = safeGetValue('chemo');
            const genderVal = safeGetValue('gender');

            if (!ageVal) { alert("Error: Could not read patient data."); return; }

            // Auto Risk
            let riskVal = '2.0';
            if (flt3Val === '1.0') riskVal = '3.0';
            else if (npm1Val === '1.0') riskVal = '1.0';

            const userInputs = { 
                'Age': ageVal, 'Risk_Classification': riskVal, 
                'BMBP': bmbpVal, 'FLT3.ITD': flt3Val, 'NPM1': npm1Val, 'Chemotherapy': chemoVal, 'Gender': genderVal, 'Transplant': '0.0' 
            };
            
            const flt3Map = {'0.0': 'Wild Type', '1.0': 'Mutated'};

            if (txProfileSummary) txProfileSummary.innerHTML = `<li style="margin-bottom:5px;"><strong>Age:</strong> ${ageVal} Years</li><li style="margin-bottom:5px;"><strong>Risk:</strong> ${riskVal}</li><li style="margin-bottom:5px;"><strong>Genetics:</strong> ${flt3Map[flt3Val] || flt3Val}</li>`;

            runTxBtn.disabled = true; runTxBtn.textContent = 'Simulating Outcomes...';
            try {
                const response = await fetch(TX_API_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user_inputs: userInputs }) });
                const res = await response.json();
                if (response.ok) {
                    const getProbAt = (curve, day) => { const point = curve.find(p => p.time >= day); return point ? point.probability : 0; };
                    const chemo1yr = getProbAt(res.chemo_curve, 365);
                    const tx1yr = getProbAt(res.transplant_curve, 365);
                    
                    // Metrics Calculation
                    const riskReduction = ((tx1yr - chemo1yr) * 100).toFixed(1);
                    const cureProb = (res.transplant_curve[res.transplant_curve.length-1].probability * 100).toFixed(1);

                    if(txRiskReduction) { txRiskReduction.textContent = (riskReduction > 0 ? "+" : "") + riskReduction + "%"; txRiskReduction.className = `value ${riskReduction > 5 ? 'val-low' : 'val-neutral'}`; }
                    if(txCureProb) { txCureProb.textContent = cureProb + "%"; txCureProb.className = `value ${cureProb > 50 ? 'val-low' : 'val-neutral'}`; }
                    
                    const traceChemo = { x: res.chemo_curve.map(d => d.time), y: res.chemo_curve.map(d => d.probability), mode: 'lines', name: 'Standard Chemotherapy', line: { color: '#94a3b8', width: 3, dash: 'dash' } };
                    const traceTx = { x: res.transplant_curve.map(d => d.time), y: res.transplant_curve.map(d => d.probability), mode: 'lines', name: 'With Transplant', line: { color: '#111111', width: 4 } };
                    const layout = { ...LIGHT_LAYOUT, title: null, xaxis: { ...LIGHT_LAYOUT.xaxis, title: 'Time (Days)' }, yaxis: { ...LIGHT_LAYOUT.yaxis, title: 'Survival Probability' }, margin: { t: 20, b: 40, l: 40, r: 20 }, legend: { orientation: 'h', y: 1.1 } };
                    Plotly.newPlot('treatment-plot', [traceChemo, traceTx], layout, {displayModeBar: false, responsive: true});
                    
                    let analysis = "";
                    if (riskReduction > 15) { analysis = `<strong>Strong Recommendation for Transplant:</strong> This patient shows a significant survival benefit (+${riskReduction}% reduction in relapse risk). `; if (flt3Val === '1.0') analysis += "The presence of the <strong>FLT3-ITD mutation</strong> makes standard chemotherapy less effective long-term. ASCT provides a curative immune effect. "; } 
                    else if (riskReduction > 5) { analysis = `<strong>Moderate Benefit:</strong> Transplant offers a modest improvement (+${riskReduction}%) over chemotherapy. Weigh risks of GVHD. `; } 
                    else { analysis = `<strong>Limited Benefit:</strong> The model predicts minimal survival gain from transplant (+${riskReduction}%). Standard chemotherapy consolidation may be sufficient.`; }
                    document.getElementById('tx-analysis-text').innerHTML = analysis;
                } else { alert("Simulation Error: " + res.error); }
            } catch (err) { alert("Failed to connect."); } finally { runTxBtn.disabled = false; runTxBtn.textContent = 'SIMULATE OUTCOMES'; }
        });
    }
    
    // --- BULK ANALYSIS ---
    const bulkForm = document.getElementById('bulk-upload-form');
    const bulkResultsView = document.getElementById('bulk-results-view');
    if (bulkForm) {
        bulkForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const uploadBtn = document.getElementById('upload-btn');
            const fileInput = document.getElementById('patient-file');
            uploadBtn.disabled = true; uploadBtn.textContent = 'ANALYZING...';
            const formData = new FormData();
            formData.append('file', fileInput.files[0]);
            try {
                const response = await fetch('/api/bulk-analyze', { method: 'POST', body: formData });
                const res = await response.json();
                if (response.ok) {
                    const data = res;
                    document.getElementById('cohort-total').textContent = data.cohort_size;
                    document.getElementById('cohort-avg-surv').textContent = data.average_2yr_survival + '%';
                    const riskGroups = { 'Low Risk': 0, 'Intermediate': 0, 'High Risk': 0, 'Very High Risk': 0 };
                    data.summary_table.forEach(p => { if (riskGroups[p.risk_group] !== undefined) riskGroups[p.risk_group]++; });
                    const highRiskCount = riskGroups['High Risk'] + riskGroups['Very High Risk'];
                    document.getElementById('cohort-high-risk').textContent = highRiskCount;
                    const traces = [
                        { x: data.best_case_curve.map(d => d.time), y: data.best_case_curve.map(d => d.probability), mode: 'lines', name: 'Best Case Survival', line: { color: '#10b981', width: 3 } },
                        { x: data.worst_case_curve.map(d => d.time), y: data.worst_case_curve.map(d => d.probability), mode: 'lines', name: 'Worst Case Survival', line: { color: '#ef4444', width: 3, dash: 'dash' } }
                    ];
                    const layout = { ...LIGHT_LAYOUT, title: null, xaxis: { ...LIGHT_LAYOUT.xaxis, title: 'Time (Days)' }, yaxis: { ...LIGHT_LAYOUT.yaxis, title: 'Survival Probability' } };
                    Plotly.newPlot('bulk-curve-plot', traces, layout, {displayModeBar: false, responsive: true});
                    const pieData = [{ values: Object.values(riskGroups), labels: Object.keys(riskGroups), type: 'pie', hole: 0.4, marker: { colors: ['#10b981', '#f59e0b', '#ef4444', '#7f1d1d'] } }];
                    const layoutPie = { ...LIGHT_LAYOUT, title: null, showlegend: true, margin: { t: 20, b: 20, l: 20, r: 20 } };
                    Plotly.newPlot('bulk-pie-plot', pieData, layoutPie, {displayModeBar: false, responsive: true});
                    document.getElementById('risk-factors-text').textContent = data.detailed_analysis.risk_factors;
                    document.getElementById('treatment-suggestion-text').textContent = data.detailed_analysis.treatment_suggestion;
                    bulkResultsView.style.display = 'block';
                } else { alert("Analysis Failed: " + res.error); }
            } catch (err) { alert("Connection failed."); } finally { uploadBtn.disabled = false; uploadBtn.textContent = 'ANALYZE COHORT'; }
        });
    }

    // --- CLINICAL TRIALS ---
    const findTrialsBtn = document.getElementById('find-trials-btn');
    const trialsResults = document.getElementById('trials-results');
    if (findTrialsBtn) {
        findTrialsBtn.addEventListener('click', async () => {
            const safeGetValue = (id) => { const el = document.getElementById(id); return el ? el.value : null; };
            const userInputs = {
                'Age': safeGetValue('age'),
                'Risk_Classification': '2.0', 
                'FLT3.ITD': safeGetValue('flt3'),
                'NPM1': safeGetValue('npm1'),
                'Transplant': safeGetValue('transplant')
            };
            const ageDisplay = document.getElementById('trial-age-display');
            const flt3Display = document.getElementById('trial-flt3-display');
            if (ageDisplay && userInputs['Age']) ageDisplay.textContent = userInputs['Age'];
            if (flt3Display && userInputs['FLT3.ITD']) flt3Display.textContent = userInputs['FLT3.ITD'] === '1.0' ? 'Mutated' : 'Wild Type';
            if (trialsResults) trialsResults.innerHTML = '<div class="stat-card" style="text-align: center; color: var(--text-medium);">Searching database...</div>';
            try {
                const response = await fetch(TRIALS_API_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ user_inputs: userInputs })
                });
                const res = await response.json();
                if (response.ok && res.trials && res.trials.length > 0) {
                    trialsResults.innerHTML = res.trials.map(t => `
                        <div class="stat-card" style="text-align: left; border-left: 4px solid var(--primary-brand); margin-bottom: 10px;">
                            <div style="display:flex; justify-content:space-between;">
                                <h4 style="color: var(--primary-brand); margin-bottom: 5px;">${t.phase} • ${t.mechanism}</h4>
                                <span class="badge" style="background:#d1fae5; color:#065f46;">${t.score} Match</span>
                            </div>
                            <div class="value" style="font-size: 1.1rem; margin-top:5px;">${t.title}</div>
                            <p style="font-size: 0.9rem; color: var(--text-dark); margin: 5px 0;">${t.description}</p>
                            <div style="font-size: 0.85rem; color: var(--text-medium); margin-top: 5px;">ID: <a href="https://clinicaltrials.gov/study/${t.id}" target="_blank" style="color:var(--primary-brand); text-decoration:none;">${t.id}</a> • Status: ${t.status}</div>
                        </div>
                    `).join('');
                } else {
                    trialsResults.innerHTML = '<div class="stat-card" style="text-align: left; color: var(--text-medium);">No specific trials found for this profile. Standard of care recommended.</div>';
                }
            } catch (e) {
                console.error(e);
                if (trialsResults) trialsResults.innerHTML = '<div class="stat-card" style="text-align: left; color: var(--risk-high);">Error fetching trials.</div>';
            }
        });
    }

    // --- NAVIGATION ---
    document.querySelectorAll('.nav-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
            btn.classList.add('active');
            document.getElementById(btn.dataset.tab).classList.add('active');
            window.dispatchEvent(new Event('resize'));
        });
    });

    resetBtn.onclick = () => { 
        form.reset(); 
        document.getElementById('out-age').value = "45";
        document.getElementById('out-bmbp').value = "15";
        Plotly.purge('survival-plot'); Plotly.purge('radar-plot'); Plotly.purge('treatment-plot'); Plotly.purge('bulk-curve-plot'); Plotly.purge('bulk-pie-plot');
        if(document.getElementById('bold-analysis-container')) document.getElementById('bold-analysis-container').style.display = 'none';
        if(document.getElementById('bulk-results-view')) document.getElementById('bulk-results-view').style.display = 'none';
        if(driversList) driversList.innerHTML = '<span class="driver-placeholder">Run analysis to identify key clinical drivers.</span>';
        cards.forEach(c => { c.value.textContent = "--"; c.value.className = "value val-neutral"; c.container.style.display = 'block'; });
        statusMsg.textContent = "Dashboard Reset.";
        if(document.getElementById('tx-risk-reduction')) document.getElementById('tx-risk-reduction').textContent = "--%";
        if(document.getElementById('tx-cure-prob')) document.getElementById('tx-cure-prob').textContent = "--%";
        if(trialsResults) trialsResults.innerHTML = '<div class="stat-card" style="text-align: left; color: var(--text-medium);">No trials loaded. Click "Find Matching Trials".</div>';
    };
});
