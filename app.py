from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS 
from inference_engine import predict_survival

app = Flask(__name__)
CORS(app) 

# Define the 7 parameters expected from the frontend
EXPECTED_PARAMS = [
    "Age", "Risk_Classification", "BMBP", "FLT3.ITD", 
    "Chemotherapy", "Gender", "Transplant"
]

# Static metrics for the dashboard table
COMPARATIVE_METRICS = {
    "DeepHit": {
        "C_index": 0.6888, 
        "IBS": "N/A*",
        "Features": 500
    },
    "LogHazard": {
        "C_index": 0.6183, 
        "IBS": 0.215, 
        "Features": 60
    }
}

# --- ROUTE 1: MAIN PREDICTION API (Dashboard) ---
@app.route('/api/predict', methods=['POST'])
def handle_prediction():
    try:
        data = request.json
        model_type = data.get('model_type', 'deephit') 
        user_inputs = data.get('user_inputs', {})
        
        # 1. Validation
        if not all(param in user_inputs for param in EXPECTED_PARAMS):
            missing = [param for param in EXPECTED_PARAMS if param not in user_inputs]
            return jsonify({"error": f"Missing required parameters: {', '.join(missing)}"}), 400

        # 2. Type Conversion
        try:
            user_inputs['Age'] = float(user_inputs['Age'])
            user_inputs['BMBP'] = float(user_inputs['BMBP'])
            user_inputs['Risk_Classification'] = float(user_inputs['Risk_Classification'])
            user_inputs['FLT3.ITD'] = float(user_inputs['FLT3.ITD'])
            user_inputs['Chemotherapy'] = float(user_inputs['Chemotherapy'])
            user_inputs['Gender'] = float(user_inputs['Gender'])
            user_inputs['Transplant'] = float(user_inputs['Transplant'])
        except ValueError:
             return jsonify({"error": "All inputs must be valid numerical values."}), 400

        # 3. Run Prediction
        prediction_output = predict_survival(user_inputs, model_type)

        # 4. Return Response
        response = {
            "prediction": prediction_output,
            "metrics": COMPARATIVE_METRICS
        }
        return jsonify(response)

    except Exception as e:
        print(f"Prediction Error: {e}")
        return jsonify({"error": f"Internal Server Error: {str(e)}"}), 500


# --- ROUTE 2: TREATMENT SIMULATION API (Treatment Tab) ---
@app.route('/api/treatment-simulation', methods=['POST'])
def treatment_simulation():
    """
    Runs the model TWICE: Once with Transplant=0, Once with Transplant=1.
    Returns both curves for comparison.
    """
    try:
        data = request.json
        user_inputs = data.get('user_inputs', {})
        # Always use DeepHit for treatment sim as it captures long-term survival better
        model_type = 'deephit' 

        # Ensure types are float
        for k, v in user_inputs.items():
            user_inputs[k] = float(v)

        # Scenario A: Standard Chemotherapy Only (No Transplant)
        inputs_chemo = user_inputs.copy()
        inputs_chemo['Transplant'] = 0.0
        inputs_chemo['Chemotherapy'] = 1.0
        
        # Scenario B: With Transplant (The Intervention)
        inputs_transplant = user_inputs.copy()
        inputs_transplant['Transplant'] = 1.0
        
        # Run Predictions
        pred_chemo = predict_survival(inputs_chemo, model_type)
        pred_transplant = predict_survival(inputs_transplant, model_type)
        
        # Calculate Benefit (Difference in 2-Year Survival Probability)
        surv_chemo_2yr = pred_chemo['fixed_time_survival']['2_years']
        surv_tx_2yr = pred_transplant['fixed_time_survival']['2_years']
        
        benefit = surv_tx_2yr - surv_chemo_2yr
        
        # Return Comparison Data
        return jsonify({
            "chemo_curve": pred_chemo['survival_curve'],
            "transplant_curve": pred_transplant['survival_curve'],
            "survival_benefit_2yr": round(benefit * 100, 1), # Percentage gain (e.g., +15.5%)
            "chemo_median": pred_chemo['median_survival_time_days'],
            "transplant_median": pred_transplant['median_survival_time_days']
        })

    except Exception as e:
        print(f"Treatment Sim Error: {e}")
        return jsonify({"error": str(e)}), 500


# --- STATIC FILE SERVING (Frontend) ---
@app.route('/', methods=['GET'])
def home():
    return send_from_directory('.', 'index.html')

@app.route('/<path:filename>')
def serve_static(filename):
    return send_from_directory('.', filename)


if __name__ == '__main__':
    print("Starting Leukemia AI Server...")
    app.run(host='0.0.0.0', port=5000, debug=True)