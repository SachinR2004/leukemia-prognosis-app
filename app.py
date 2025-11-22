from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS 
import pandas as pd
import io
from inference_engine import predict_survival, bulk_process_patients

app = Flask(__name__)
CORS(app) 

# --- CONFIGURATION ---
EXPECTED_PARAMS = [
    "Age", "Risk_Classification", "BMBP", "FLT3.ITD", 
    "NPM1", "Chemotherapy", "Gender", "Transplant"
]

# --- REAL-WORLD TRIAL DATABASE (Mocked for Demo) ---
# Sourced from active studies (e.g., NCT04067336, NCT04778397)
TRIAL_DATABASE = [
    {
        "id": "NCT04067336",
        "title": "KOMET-001: Menin Inhibitor (Ziftomenib) for NPM1-Mutated AML",
        "phase": "Phase 1/2",
        "status": "Recruiting",
        "mechanism": "Targeted Therapy",
        "description": "Evaluates Ziftomenib in patients with Relapsed/Refractory AML harboring NPM1 mutations.",
        "criteria": lambda p: p['NPM1'] == 1.0 and p['Risk_Classification'] >= 2.0
    },
    {
        "id": "NCT00651261",
        "title": "Sorafenib Maintenance Post-Transplant for FLT3-ITD AML",
        "phase": "Phase 3",
        "status": "Active",
        "mechanism": "Maintenance / FLT3 Inhibitor",
        "description": "Investigates the survival benefit of Sorafenib maintenance therapy in FLT3-ITD positive patients after allogeneic HSCT.",
        "criteria": lambda p: p['FLT3.ITD'] == 1.0 and p['Transplant'] == 1.0
    },
    {
        "id": "NCT02993523",
        "title": "Venetoclax + Azacitidine for Elderly/Unfit AML",
        "phase": "Phase 3",
        "status": "Recruiting",
        "mechanism": "BCL-2 Inhibitor",
        "description": "Standard of care optimization for patients >60 years who are ineligible for intensive induction.",
        "criteria": lambda p: p['Age'] > 60 and p['Chemotherapy'] == 1.0
    },
    {
        "id": "NCT04778397",
        "title": "ENHANCE-2: Magrolimab + Azacitidine for TP53/Adverse Risk",
        "phase": "Phase 3",
        "status": "Recruiting",
        "mechanism": "CD47 Blockade",
        "description": "Targeting the 'Don't Eat Me' signal in high-risk or TP53-mutated AML patients.",
        "criteria": lambda p: p['Risk_Classification'] == 3.0
    },
    {
        "id": "NCT03839771",
        "title": "IDH1/2 Inhibitor Combination with Intensive Chemo",
        "phase": "Phase 3",
        "status": "Active",
        "mechanism": "Metabolic Target",
        "description": "Adding Ivosidenib or Enasidenib to 7+3 induction for patients with IDH mutations (often co-occurring with NPM1).",
        "criteria": lambda p: p['NPM1'] == 1.0 or p['Risk_Classification'] == 2.0
    },
    {
        "id": "NCT05521022",
        "title": "Reduced-Intensity Conditioning (RIC) for Older Adults",
        "phase": "Phase 2",
        "status": "Recruiting",
        "mechanism": "Transplant Protocol",
        "description": "Optimizing conditioning regimens for patients aged 60-75 undergoing allogeneic transplant.",
        "criteria": lambda p: p['Age'] >= 60 and p['Transplant'] == 1.0
    },
    {
        "id": "NCT03092674",
        "title": "Gilteritinib Maintenance After Transplant",
        "phase": "Phase 3",
        "status": "Recruiting",
        "mechanism": "FLT3 Inhibitor",
        "description": "Testing Gilteritinib vs Placebo as maintenance for FLT3-ITD+ AML in first remission post-HCT.",
        "criteria": lambda p: p['FLT3.ITD'] == 1.0 and p['Transplant'] == 1.0
    },
    {
        "id": "NCT09982145",
        "title": "Long-Term Survivorship in Acute Leukemia",
        "phase": "Observational",
        "status": "Active",
        "mechanism": "Surveillance",
        "description": "Tracking long-term health outcomes in AML survivors.",
        "criteria": lambda p: True # Matches everyone
    }
]

# --- HELPER: Match Trials ---
def get_matching_trials(user_inputs):
    matches = []
    
    # Normalize inputs for logic
    p = {
        'Age': float(user_inputs.get('Age', 0)),
        'Risk_Classification': float(user_inputs.get('Risk_Classification', 2.0)),
        'FLT3.ITD': float(user_inputs.get('FLT3.ITD', 0)),
        'NPM1': float(user_inputs.get('NPM1', 0)),
        'Transplant': float(user_inputs.get('Transplant', 0)),
        'Chemotherapy': float(user_inputs.get('Chemotherapy', 0))
    }

    for trial in TRIAL_DATABASE:
        try:
            # Check if criteria function returns True
            if trial['criteria'](p):
                # Calculate a simple relevance score
                score = 50 # Base score
                if p['FLT3.ITD'] == 1.0 and 'FLT3' in trial['title']: score += 40
                if p['NPM1'] == 1.0 and 'NPM1' in trial['title']: score += 40
                if p['Transplant'] == 1.0 and 'Transplant' in trial['title']: score += 30
                if p['Age'] > 60 and 'Elderly' in trial['title']: score += 20
                if p['Risk_Classification'] == 3.0 and 'Adverse' in trial['title']: score += 25
                
                matches.append({**trial, "score": score, "criteria": None}) # Remove lambda before JSON
        except Exception as e:
            continue
            
    # Sort by relevance score
    return sorted(matches, key=lambda x: x['score'], reverse=True)

# --- ROUTES ---

@app.route('/api/predict', methods=['POST'])
def handle_prediction():
    try:
        data = request.json
        model_type = data.get('model_type', 'deephit') 
        user_inputs = data.get('user_inputs', {})
        for param in EXPECTED_PARAMS:
            if param in user_inputs: user_inputs[param] = float(user_inputs[param])
        
        prediction_output = predict_survival(user_inputs, model_type)
        return jsonify({"prediction": prediction_output})
    except Exception as e:
        return jsonify({"error": f"Internal Server Error: {str(e)}"}), 500

@app.route('/api/treatment-simulation', methods=['POST'])
def treatment_simulation():
    try:
        data = request.json
        user_inputs = data.get('user_inputs', {})
        for k, v in user_inputs.items():
            try: user_inputs[k] = float(v)
            except: pass

        inputs_chemo = user_inputs.copy()
        inputs_chemo['Transplant'] = 0.0
        inputs_chemo['Chemotherapy'] = 1.0
        inputs_transplant = user_inputs.copy()
        inputs_transplant['Transplant'] = 1.0
        
        pred_chemo = predict_survival(inputs_chemo, 'deephit')
        pred_transplant = predict_survival(inputs_transplant, 'deephit')
        benefit = pred_transplant['fixed_time_survival']['2_years'] - pred_chemo['fixed_time_survival']['2_years']
        
        return jsonify({
            "chemo_curve": pred_chemo['survival_curve'],
            "transplant_curve": pred_transplant['survival_curve'],
            "survival_benefit_2yr": round(benefit * 100, 1),
            "chemo_median": pred_chemo['median_survival_time_days'],
            "transplant_median": pred_transplant['median_survival_time_days']
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/bulk-analyze', methods=['POST'])
def bulk_analyze():
    try:
        if 'file' not in request.files: return jsonify({"error": "No file part"}), 400
        file = request.files['file']
        if file.filename == '': return jsonify({"error": "No selected file"}), 400
        
        file_stream = io.StringIO(file.stream.read().decode("UTF8"))
        try: df_new_patients = pd.read_csv(file_stream, sep=',', index_col=False)
        except:
            file_stream.seek(0)
            df_new_patients = pd.read_csv(file_stream, sep='\t', index_col=False)
            
        analysis_results = bulk_process_patients(df_new_patients)
        return jsonify(analysis_results)
    except Exception as e:
        return jsonify({"error": str(e)}), 500

# --- NEW: CLINICAL TRIALS API ---
@app.route('/api/clinical-trials', methods=['POST'])
def clinical_trials():
    try:
        data = request.json
        user_inputs = data.get('user_inputs', {})
        matches = get_matching_trials(user_inputs)
        return jsonify({"trials": matches})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/', methods=['GET'])
def home(): return send_from_directory('.', 'index.html')

@app.route('/<path:filename>')
def serve_static(filename): return send_from_directory('.', filename)

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=True)
