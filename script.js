document.addEventListener('DOMContentLoaded', () => {
    console.log("App Initialized: Script Started");

    // --- CONFIGURATION ---
    const API_URL = '/api/predict';
    const TX_API_URL = '/api/treatment-simulation';
    const TRIALS_API_URL = '/api/clinical-trials';

    // =================================================
    // 1. NAVIGATION LOGIC (Priority High)
    // =================================================
    const navButtons = document.querySelectorAll('.nav-btn');
    const tabContents = document.querySelectorAll('.tab-content');

    function switchTab(targetId) {
        console.log("Switching to tab:", targetId);

        // 1. Hide ALL tabs
        tabContents.forEach(tab => {
            tab.classList.remove('active');
            tab.style.display = 'none';
        });

        // 2. Deactivate ALL buttons
        navButtons.forEach(btn => btn.classList.remove('active'));

        // 3. Show TARGET tab
        const activeTab = document.getElementById(targetId);
        if (activeTab) {
            activeTab.classList.add('active');
            activeTab.style.display = 'block';
        } else {
            console.warn(`Tab ID '${targetId}' not found.`);
            return;
        }

        // 4. Activate TARGET button
        const activeBtn = document.querySelector(`.nav-btn[data-tab="${targetId}"]`);
        if (activeBtn) {
            activeBtn.classList.add('active');
        }

        // 5. Resize charts
        window.dispatchEvent(new Event('resize'));
    }

    // Attach listeners to Nav Buttons
    navButtons.forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            const tabId = btn.getAttribute('data-tab');
            switchTab(tabId);
        });
    });

    // Home Page "Launch" Button
    const launchBtn = document.querySelector('.btn-glow');
    if (launchBtn) {
        launchBtn.addEventListener('click', (e) => {
            e.preventDefault();
            switchTab('analysis');
        });
    }

    // =================================================
    // 2. UI ELEMENTS & HELPERS
    // =================================================
    const form = document.getElementById('prediction-form');
    const resetBtn = document.getElementById('reset-btn');
    const runBtn = document.getElementById('run-btn');
    const statusMsg = document.getElementById('status-msg');
    const driversList = document.getElementById('drivers-list');

    const safeGetEl = (id) => document.getElementById(id);

    const cards = [1, 2, 3, 4].map(i => ({
        title: safeGetEl(`card-title-${i}`),
        value: safeGetEl(`res-value-${i}`),
        container: safeGetEl(`card-title-${i}`)?.closest('.stat-card-pro')
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

    function calculateRMST(curve, maxDays=1825) {
        if (!curve || curve.length === 0) return "N/A";
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

    // =================================================
    // 3. CHART RENDERING
    // =================================================

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
        const data = [{ type: 'scatterpolar', r: [normAge, normBMBP, inputs['FLT3.ITD'], inputs['Transplant'], normNPM1, normAge], theta: ['Age', 'BMBP', 'FLT3', 'Transplant', 'NPM1', 'Age'], fill: 'toself', name: 'Patient Profile', line: { color: '#111111' }, fillcolor: 'rgba(17, 17, 17, 0.2)' }];
        const layout = { polar: { radialaxis: { visible: true, range: [0, 1], gridcolor: '#e2e8f0' }, angularaxis: { color: '#334155' }, bgcolor: 'rgba(0,0,0,0)' }, paper_bgcolor: 'rgba(0,0,0,0)', font: { color: '#334155', family: 'Inter, sans-serif' }, margin: { t: 30, b: 30, l: 40, r: 40 }, showlegend: false, title: { text: 'Patient Biomarker Profile', font: {size: 14} } };
        Plotly.newPlot('radar-plot', data, layout, {displayModeBar: false, responsive: true});
    }

    // =================================================
    // 4. DASHBOARD LOGIC
    // =================================================

    function generateBoldAnalysis(pred, userInputs, rmst) {
        const riskGroup = pred.risk_group;
        const riskScore = (pred.raw_risk_score_2yr * 100).toFixed(1);
        const isTransplant = userInputs['Transplant'] === '1.0';
        
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
        } else if (riskGroup !== 'Low Risk') {
            html += "⚠️ <strong>Intervention Needed:</strong> Absence of transplant is the primary driver of this risk trajectory.";
        }
        return html;
    }

    function updateMetricsDashboard(pred, userInputs, modelType) {
        const bmbpVal = parseFloat(userInputs['BMBP']);
        const riskVal = 2.0; // Default
        const severityScore = (riskVal * 20) + (bmbpVal * 0.5);
        let sevText = severityScore > 80 ? "Aggressive" : (severityScore < 40 ? "Indolent" : "Moderate");
        let sevClass = severityScore > 80 ? "val-high" : (severityScore < 40 ? "val-low" : "val-neutral");
        
        const curve = pred.survival_curve;
        const rmst = calculateRMST(curve);

        // DEEPHIT METRICS
        if (modelType === 'deephit') {
            if(cards[0].container) cards.forEach(c => c.container.style.display = 'flex');

            cards[0].title.textContent = "2-Year Survival";
            const prob2yr = (1 - pred.raw_risk_score_2yr) * 100;
            cards[0].value.textContent = prob2yr.toFixed(1) + "%";
            cards[0].value.className = prob2yr > 70 ? "stat-val val-low" : (prob2yr < 40 ? "stat-val val-high" : "stat-val val-neutral");

            cards[1].title.textContent = "Median Survival Estimate";
            const medianPoint = curve.find(p => p.probability <= 0.5);
            let medianText = "> 5 Years";
            if (medianPoint) { const years = (medianPoint.time / 365).toFixed(1); medianText = `${years} Years`; }
            cards[1].value.textContent = medianText;
            cards[1].value.className = "stat-val val-neutral";

            cards[2].title.textContent = "Disease Indolence";
            const p1 = curve.find(p => p.time >= 365)?.probability || 1.0;
            const p5 = curve.find(p => p.time >= 1800)?.probability || 0.0;
            const drop = p1 - p5;
            let indolenceText = "Moderate"; let indolenceClass = "val-neutral";
            if (drop < 0.15 && p5 > 0.5) { indolenceText = "High (Stable)"; indolenceClass = "val-low"; }
            else if (drop > 0.4) { indolenceText = "Low (Aggressive)"; indolenceClass = "val-high"; }
            cards[2].value.textContent = indolenceText;
            cards[2].value.className = `stat-val ${indolenceClass}`;
            cards[2].value.style.fontSize = "1.3rem";

            cards[3].title.textContent = "Condition Severity";
            cards[3].value.textContent = sevText;
            cards[3].value.className = `stat-val ${sevClass}`;

        // LOG HAZARD METRICS
        } else {
            if(cards[3].container) cards[3].container.style.display = 'none';
            
            cards[0].title.textContent = "Risk Stratification";
            cards[0].value.textContent = pred.risk_group;
            cards[0].value.className = `stat-val ${pred.risk_css}`;

            const prob1yr = curve.find(p => p.time >= 365)?.probability || 1.0;
            const relapseRisk = ((1 - prob1yr) * 100).toFixed(1) + "%";
            cards[1].title.textContent = "1-Year Relapse Risk";
            cards[1].value.textContent = relapseRisk;
            cards[1].value.className = (1-prob1yr) > 0.4 ? "stat-val val-high" : "stat-val val-low";

            const percentile = Math.round((1 - pred.raw_risk_score_2yr) * 100);
            let cohortLabel = percentile > 75 ? `Top ${100-percentile}%` : "Average";
            cards[2].title.textContent = "Cohort Standing";
            cards[2].value.textContent = cohortLabel;
            cards[2].value.className = "stat-val val-neutral";
            cards[2].value.style.fontSize = "1.4rem";
        }
        
        const analysisHtml = generateBoldAnalysis(pred, userInputs, rmst);
        document.getElementById('bold-analysis-text').innerHTML = analysisHtml;
        document.getElementById('bold-analysis-container').style.display = 'block';
    }

    if (form) {
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            if(runBtn) { runBtn.disabled = true; runBtn.innerHTML = 'Processing...'; }
            if(statusMsg) statusMsg.textContent = 'Running AI Inference...';
            const formData = new FormData(form);
            const userInputs = {};
            ['Age', 'BMBP', 'FLT3.ITD', 'NPM1', 'Chemotherapy', 'Gender', 'Transplant'].forEach(key => { userInputs[key] = formData.get(key); });
            userInputs['Risk_Classification'] = '2.0';
            try {
                const response = await fetch(API_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model_type: formData.get('model_type'), user_inputs: userInputs }) });
                const res = await response.json();
                if (response.ok) {
                    updateMetricsDashboard(res.prediction, userInputs, formData.get('model_type'));
                    if (driversList) driversList.innerHTML = res.prediction.drivers.map(d => `<span class="driver-tag ${d.includes('+') ? 'good' : 'bad'}">${d}</span>`).join('');
                    renderPrimaryPlot(res.prediction.survival_curve, res.prediction.hazard_curve, formData.get('model_type'));
                    renderRadarPlot(userInputs);
                    if(statusMsg) statusMsg.textContent = 'Analysis Complete.';
                } else { if(statusMsg) statusMsg.textContent = `Error: ${res.error}`; }
            } catch (err) { console.error(err); if(statusMsg) statusMsg.textContent = 'Connection Failed.'; } finally { if(runBtn) { runBtn.disabled = false; runBtn.innerHTML = 'RUN ANALYSIS'; } }
        });
    }

    // --- TREATMENT SIMULATION ---
    const runTxBtn = document.getElementById('run-tx-btn');
    if (runTxBtn) {
        runTxBtn.addEventListener('click', async () => {
            const safeGetValue = (id) => { const el = document.getElementById(id); return el ? el.value : null; };
            const ageVal = safeGetValue('age');
            const bmbpVal = safeGetValue('bmbp');
            const flt3Val = safeGetValue('flt3');
            const npm1Val = safeGetValue('npm1');
            const chemoVal = safeGetValue('chemo');
            const genderVal = safeGetValue('gender');

            if (!ageVal) { alert("Error: Could not read patient data."); return; }

            const userInputs = { 'Age': ageVal, 'Risk_Classification': '2.0', 'BMBP': bmbpVal, 'FLT3.ITD': flt3Val, 'NPM1': npm1Val, 'Chemotherapy': chemoVal, 'Gender': genderVal, 'Transplant': '0.0' };
            const flt3Map = {'0.0': 'Wild Type', '1.0': 'Mutated'};
            const txProfileSummary = document.getElementById('tx-profile-summary');
            if (txProfileSummary) txProfileSummary.innerHTML = `<li style="margin-bottom:5px;"><strong>Age:</strong> ${ageVal} Years</li><li style="margin-bottom:5px;"><strong>Genetics:</strong> ${flt3Map[flt3Val] || flt3Val}</li>`;

            runTxBtn.disabled = true; runTxBtn.textContent = 'Simulating Outcomes...';
            try {
                const response = await fetch(TX_API_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user_inputs: userInputs }) });
                const res = await response.json();
                if (response.ok) {
                    const benefit = res.survival_benefit_2yr;
                    const cureProb = (res.transplant_curve[res.transplant_curve.length-1].probability * 100).toFixed(1);
                    const txBenefit = document.getElementById('tx-risk-reduction');
                    const txMedianGain = document.getElementById('tx-cure-prob');

                    if(txBenefit) { txBenefit.textContent = (benefit > 0 ? "+" : "") + benefit + "%"; txBenefit.className = `stat-val ${benefit > 10 ? 'val-positive' : 'val-neutral'}`; }
                    if(txMedianGain) { txMedianGain.textContent = cureProb + "%"; txMedianGain.className = `stat-val ${cureProb > 50 ? 'val-positive' : 'val-neutral'}`; }
                    
                    const traceChemo = { x: res.chemo_curve.map(d => d.time), y: res.chemo_curve.map(d => d.probability), mode: 'lines', name: 'Standard Chemotherapy', line: { color: '#94a3b8', width: 3, dash: 'dash' } };
                    const traceTx = { x: res.transplant_curve.map(d => d.time), y: res.transplant_curve.map(d => d.probability), mode: 'lines', name: 'With Transplant', line: { color: '#2563eb', width: 4 } };
                    const layout = { ...LIGHT_LAYOUT, title: null, xaxis: { ...LIGHT_LAYOUT.xaxis, title: 'Time (Days)' }, yaxis: { ...LIGHT_LAYOUT.yaxis, title: 'Survival Probability' }, margin: { t: 20, b: 40, l: 40, r: 20 }, legend: { orientation: 'h', y: 1.1 } };
                    Plotly.newPlot('treatment-plot', [traceChemo, traceTx], layout, {displayModeBar: false, responsive: true});
                    
                    let analysis = "";
                    if (benefit > 15) { analysis = `<strong>Strong Recommendation for Transplant:</strong> This patient shows a significant survival benefit (+${benefit}%) from Allogeneic Stem Cell Transplantation (ASCT). `; if (flt3Val === '1.0') analysis += "The presence of the <strong>FLT3-ITD mutation</strong> makes standard chemotherapy less effective long-term. ASCT provides a curative immune effect. "; } 
                    else if (benefit > 5) { analysis = `<strong>Moderate Benefit:</strong> Transplant offers a modest improvement (+${benefit}%) over chemotherapy. Weigh risks of GVHD. `; } 
                    else { analysis = `<strong>Limited Benefit:</strong> The model predicts minimal survival gain from transplant (+${benefit}%). Standard chemotherapy consolidation may be sufficient. Monitor for MRD.`; }
                    document.getElementById('tx-analysis-text').innerHTML = analysis;
                } else { alert("Simulation Error: " + res.error); }
            } catch (err) { alert("Failed to connect."); } finally { runTxBtn.disabled = false; runTxBtn.textContent = 'SIMULATE OUTCOMES'; }
        });
    }

    // --- BULK & TRIALS (Simplified for brevity, assumed present) ---
    // (Include the same bulk/trials logic from previous correct versions here)
    // ... [Keep existing code until bulkForm listener] ...

    const bulkForm = document.getElementById('bulk-upload-form');
    const bulkResultsView = document.getElementById('bulk-results-view');
    
    if (bulkForm) {
        bulkForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const uploadBtn = document.getElementById('upload-btn');
            const fileInput = document.getElementById('patient-file');
            
            uploadBtn.disabled = true; 
            uploadBtn.textContent = 'ANALYZING...';
            
            // clear previous grid results
            const patientGrid = document.getElementById('patient-grid');
            if(patientGrid) patientGrid.innerHTML = ''; 

            const formData = new FormData();
            formData.append('file', fileInput.files[0]);
            
            try {
                const response = await fetch('/api/bulk-analyze', { method: 'POST', body: formData });
                const res = await response.json();
                
                if (response.ok) {
                    const data = res;
                    
                    // 1. Render Aggregate Stats (Existing)
                    document.getElementById('cohort-total').textContent = data.cohort_size;
                    document.getElementById('cohort-avg-surv').textContent = data.average_2yr_survival + '%';
                    
                    const riskGroups = { 'Low Risk': 0, 'Intermediate': 0, 'High Risk': 0, 'Very High Risk': 0 };
                    data.summary_table.forEach(p => { if (riskGroups[p.risk_group] !== undefined) riskGroups[p.risk_group]++; });
                    
                    const highRiskCount = riskGroups['High Risk'] + riskGroups['Very High Risk'];
                    document.getElementById('cohort-high-risk').textContent = highRiskCount;

                    // 2. Render Aggregate Charts (Existing)
                    const traces = [
                        { x: data.best_case_curve.map(d => d.time), y: data.best_case_curve.map(d => d.probability), mode: 'lines', name: 'Best Case', line: { color: '#10b981', width: 3 } },
                        { x: data.worst_case_curve.map(d => d.time), y: data.worst_case_curve.map(d => d.probability), mode: 'lines', name: 'Worst Case', line: { color: '#ef4444', width: 3, dash: 'dash' } }
                    ];
                    Plotly.newPlot('bulk-curve-plot', traces, { ...LIGHT_LAYOUT, title: { text: 'Survival Envelope', font: {size:14}}, xaxis: { ...LIGHT_LAYOUT.xaxis, title: 'Days' } }, {displayModeBar: false});
                    
                    const pieData = [{ values: Object.values(riskGroups), labels: Object.keys(riskGroups), type: 'pie', hole: 0.4, marker: { colors: ['#10b981', '#f59e0b', '#ef4444', '#7f1d1d'] } }];
                    Plotly.newPlot('bulk-pie-plot', pieData, { ...LIGHT_LAYOUT, title: { text: 'Risk Distribution', font: {size:14}}, showlegend: true, margin: { t: 30, b: 20, l: 20, r: 20 } }, {displayModeBar: false});

                    // 3. NEW: Render Correlation Scatter Plot (Age vs Survival Color-coded by Risk)
                    const scatterTrace = {
                        x: data.summary_table.map(p => p.age),
                        y: data.summary_table.map(p => p.survival_2yr),
                        mode: 'markers',
                        type: 'scatter',
                        marker: { 
                            size: 14, 
                            color: data.summary_table.map(p => p.survival_2yr),
                            colorscale: 'RdYlGn', // Red to Green
                            showscale: true,
                            line: {color: '#334155', width: 1}
                        },
                        text: data.summary_table.map(p => `${p.id}<br>Risk: ${p.risk_group}`),
                        hoverinfo: 'text+x+y'
                    };
                    
                    const scatterLayout = { 
                        ...LIGHT_LAYOUT, 
                        title: { text: 'Survival Correlations (Age vs. 2-Yr Prob)', font: {size:14}},
                        xaxis: { title: 'Age', gridcolor: '#f1f5f9' },
                        yaxis: { title: '2-Year Survival %', range: [0, 105], gridcolor: '#f1f5f9' }
                    };
                    Plotly.newPlot('bulk-scatter-plot', [scatterTrace], scatterLayout, {displayModeBar: false});

                    // 4. NEW: Render Individual Patient Cards
                    if(patientGrid) {
                        data.summary_table.forEach(p => {
                            const driverTags = p.drivers.map(d => 
                                `<span class="driver-tag ${d.includes('+') ? 'good' : (d.includes('-') ? 'bad' : '')}" style="font-size:0.7rem;">${d}</span>`
                            ).join('');

                            const cardHTML = `
                                <div class="stat-card-pro" style="display:block; padding: 1.2rem; border-top: 4px solid ${p.survival_2yr > 60 ? '#10b981' : (p.survival_2yr < 40 ? '#ef4444' : '#f59e0b')};">
                                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
                                        <h4 style="margin:0; font-size:1.1rem; color:var(--text-dark);">${p.id}</h4>
                                        <span class="stat-val ${p.risk_css}" style="font-size:1.2rem;">${p.survival_2yr}%</span>
                                    </div>
                                    <div style="margin-bottom:8px; font-size:0.85rem; color:var(--text-light);">
                                        <strong>Age:</strong> ${p.age} &bull; <strong>Risk:</strong> ${p.risk_group}
                                    </div>
                                    <div style="display:flex; flex-wrap:wrap; gap:5px; margin-bottom:12px;">
                                        ${driverTags}
                                    </div>
                                    <div style="background:#f8fafc; padding:8px; border-radius:6px; font-size:0.8rem; color:var(--text-main); font-style:italic;">
                                        "${p.insight}"
                                    </div>
                                </div>
                            `;
                            patientGrid.insertAdjacentHTML('beforeend', cardHTML);
                        });
                    }

                    // 5. Update Text Insights
                    document.getElementById('risk-factors-text').textContent = data.detailed_analysis.risk_factors;
                    document.getElementById('treatment-suggestion-text').textContent = data.detailed_analysis.treatment_suggestion;
                    
                    bulkResultsView.style.display = 'block';

                } else { 
                    alert("Analysis Failed: " + res.error); 
                }
            } catch (err) { 
                console.error(err);
                alert("Connection failed or File too large."); 
            } finally { 
                uploadBtn.disabled = false; 
                uploadBtn.textContent = 'ANALYZE COHORT'; 
            }
        });
    }

// ... [Keep existing code] ...

    const findTrialsBtn = document.getElementById('find-trials-btn');
    const trialsResults = document.getElementById('trials-results');
    if (findTrialsBtn) {
        const TRIAL_DATABASE = [
            { id: "NCT043289", title: "Novel FLT3 Inhibitor for Relapsed AML", criteria: (p) => p['FLT3.ITD'] === '1.0', type: "Targeted Therapy" },
            { id: "NCT055210", title: "Reduced-Intensity Conditioning for Elderly Patients", criteria: (p) => p['Age'] > 60, type: "Transplant Protocol" },
            { id: "NCT038472", title: "Post-Transplant Maintenance Therapy", criteria: (p) => p['Transplant'] === '1.0', type: "Maintenance" },
            { id: "NCT011239", title: "High-Dose Cytarabine Optimization", criteria: (p) => p['Risk_Classification'] === '3.0', type: "Chemotherapy" },
            { id: "NCT099821", title: "Long-Term Follow-up of AML Survivors", criteria: (p) => true, type: "Observational" } 
        ];
        findTrialsBtn.addEventListener('click', () => {
            const safeGetValue = (id) => { const el = document.getElementById(id); return el ? el.value : null; };
            const userInputs = { 'Age': safeGetValue('age'), 'Risk_Classification': '2.0', 'FLT3.ITD': safeGetValue('flt3'), 'NPM1': safeGetValue('npm1'), 'Transplant': safeGetValue('transplant') };
            const ageDisplay = document.getElementById('trial-age-display');
            const flt3Display = document.getElementById('trial-flt3-display');
            if (ageDisplay && userInputs['Age']) ageDisplay.textContent = userInputs['Age'];
            if (flt3Display && userInputs['FLT3.ITD']) flt3Display.textContent = userInputs['FLT3.ITD'] === '1.0' ? 'Mutated' : 'Wild Type';
            if (trialsResults) trialsResults.innerHTML = '<div class="stat-card" style="text-align: center; color: var(--text-medium);">Searching database...</div>';
            try {
                const matches = TRIAL_DATABASE.filter(trial => trial.criteria(userInputs)); // Simplified local match
                if (matches.length > 0) {
                    trialsResults.innerHTML = matches.map(t => `<div class="stat-card" style="text-align: left; border-left: 4px solid var(--primary-brand); margin-bottom: 10px;"><h4 style="color: var(--primary-brand); margin-bottom: 5px;">${t.type}</h4><div class="value" style="font-size: 1.1rem;">${t.title}</div><div style="font-size: 0.85rem; color: var(--text-medium); margin-top: 5px;">ID: ${t.id} • Status: Recruiting</div></div>`).join('');
                } else { trialsResults.innerHTML = '<div class="stat-card" style="text-align: left; color: var(--text-medium);">No specific trials found for this profile. Standard of care recommended.</div>'; }
            } catch (e) { console.error(e); }
        });
    }

    resetBtn.onclick = () => { 
        form.reset(); 
        document.getElementById('out-age').value = "45";
        document.getElementById('out-bmbp').value = "15";
        Plotly.purge('survival-plot'); Plotly.purge('radar-plot'); Plotly.purge('treatment-plot'); Plotly.purge('bulk-curve-plot'); Plotly.purge('bulk-pie-plot');
        if(document.getElementById('bold-analysis-container')) document.getElementById('bold-analysis-container').style.display = 'none';
        if(document.getElementById('bulk-results-view')) document.getElementById('bulk-results-view').style.display = 'none';
        if(driversList) driversList.innerHTML = '<span class="tag-empty">Waiting for analysis...</span>';
        cards.forEach(c => { if(c.value) { c.value.textContent = "--"; c.value.className = "stat-val val-neutral"; } if(c.container) c.container.style.display = 'flex'; });
        if(statusMsg) statusMsg.textContent = "Dashboard Reset.";
        if(document.getElementById('tx-risk-reduction')) document.getElementById('tx-risk-reduction').textContent = "--%";
        if(document.getElementById('tx-cure-prob')) document.getElementById('tx-cure-prob').textContent = "--%";
        if(trialsResults) trialsResults.innerHTML = '<div class="empty-msg">No trials loaded.</div>';
    };
});
