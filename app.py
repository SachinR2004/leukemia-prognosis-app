from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS 
import pandas as pd
import io
from inference_engine import predict_survival, bulk_process_patients

app = Flask(__name__)
CORS(app) 

EXPECTED_PARAMS = [
    "Age", "Risk_Classification", "BMBP", "FLT3.ITD", 
    "NPM1", "Chemotherapy", "Gender", "Transplant"
]

@app.route('/api/predict', methods=['POST'])
def handle_prediction():
    try:
        data = request.json
        model_type = data.get('model_type', 'deephit') 
        user_inputs = data.get('user_inputs', {})
        for param in EXPECTED_PARAMS:
            if param in user_inputs:
                try: user_inputs[param] = float(user_inputs[param])
                except: pass 
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

# ... existing imports ...

# [Keep existing imports and routes until you reach bulk_analyze]

@app.route('/api/bulk-analyze', methods=['POST'])
def bulk_analyze():
    try:
        if 'file' not in request.files: return jsonify({"error": "No file part"}), 400
        file = request.files['file']
        if file.filename == '': return jsonify({"error": "No selected file"}), 400
        
        file_bytes = file.read()

        # ... [Keep existing CSV parsing logic (UTF-8/Latin-1/TSV)] ...
        try:
            file_stream = io.StringIO(file_bytes.decode('utf-8'))
            df_new_patients = pd.read_csv(file_stream, sep=',', index_col=False)
        except UnicodeDecodeError:
            # ... [Keep existing fallback logic] ...
            try:
                file_stream = io.StringIO(file_bytes.decode('latin-1'))
                df_new_patients = pd.read_csv(file_stream, sep=',', index_col=False)
            except Exception:
                file_stream = io.StringIO(file_bytes.decode('utf-8', errors='ignore'))
                df_new_patients = pd.read_csv(file_stream, sep='\t', index_col=False)
        
        # --- NEW CODE START: ENFORCE LIMIT ---
        if len(df_new_patients) > 10:
             return jsonify({"error": "Limit exceeded. Please upload a CSV with maximum 10 patients for deep analysis."}), 400
        # --- NEW CODE END ---

        if df_new_patients.empty or len(df_new_patients.columns) < 2:
             return jsonify({"error": "Could not parse CSV data. Please ensure it is comma-separated."}), 400

        analysis_results = bulk_process_patients(df_new_patients)
        return jsonify(analysis_results)

    except Exception as e:
        print(f"BULK ERROR: {e}")
        return jsonify({"error": f"Processing Error: {str(e)}"}), 500

# ... [Keep existing clinical_trials and static serving routes] ...    

# --- CLINICAL TRIALS API ---
TRIAL_DATABASE = [
    { "id": "NCT043289", "title": "Novel FLT3 Inhibitor for Relapsed AML", "criteria": lambda p: p.get('FLT3.ITD') == 1.0, "type": "Targeted Therapy", "phase": "Phase 2", "status": "Recruiting", "mechanism": "FLT3 Inhibition", "score": 95, "description": "Study of next-gen FLT3 inhibitor in patients with FLT3-ITD mutations." },
    { "id": "NCT055210", "title": "Reduced-Intensity Conditioning for Elderly", "criteria": lambda p: p.get('Age') > 60, "type": "Transplant Protocol", "phase": "Phase 3", "status": "Active", "mechanism": "RIC Allo-HCT", "score": 85, "description": "Optimizing transplant conditioning for patients over 60." },
    { "id": "NCT038472", "title": "Post-Transplant Maintenance Therapy", "criteria": lambda p: p.get('Transplant') == 1.0, "type": "Maintenance", "phase": "Phase 3", "status": "Recruiting", "mechanism": "Immunotherapy", "score": 90, "description": "Maintenance strategy to prevent relapse after allogeneic transplant." },
    { "id": "NCT011239", "title": "High-Dose Cytarabine Optimization", "criteria": lambda p: p.get('Risk_Classification') == 3.0, "type": "Chemotherapy", "phase": "Phase 2", "status": "Completed", "mechanism": "Cytotoxic", "score": 75, "description": "Dose optimization for adverse risk profiles." },
    { "id": "NCT099821", "title": "Long-Term Follow-up of AML Survivors", "criteria": lambda p: True, "type": "Observational", "phase": "N/A", "status": "Enrolling", "mechanism": "Surveillance", "score": 60, "description": "Registry study for long-term AML survivors." }
]

@app.route('/api/clinical-trials', methods=['POST'])
def clinical_trials():
    try:
        data = request.json
        user_inputs = data.get('user_inputs', {})
        p = {k: float(v) for k, v in user_inputs.items() if k in EXPECTED_PARAMS}
        matches = []
        for trial in TRIAL_DATABASE:
            try:
                if trial['criteria'](p):
                    t_data = trial.copy()
                    del t_data['criteria']
                    matches.append(t_data)
            except: continue
        return jsonify({"trials": matches})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/', methods=['GET'])
def home(): return send_from_directory('.', 'index.html')

@app.route('/<path:filename>')
def serve_static(filename): return send_from_directory('.', filename)

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=True)
