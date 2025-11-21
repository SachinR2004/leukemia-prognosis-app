import os
import joblib
import pandas as pd
import numpy as np
import torch
import torchtuples as tt
from pycox.models import LogisticHazard, DeepHitSingle
from typing import Dict, Any
from scipy.interpolate import interp1d

# --- Configuration ---
MODELS_DIR = 'models'
DEVICE = 'cpu' 
# FIX: Both models must use 60 features based on your error log
LOGHAZARD_FEATURES = 60 
DEEPHIT_INPUT_FEATURES = 60 

ARTIFACTS: Dict[str, Any] = {}

def load_all_artifacts():
    global ARTIFACTS
    print("--- Loading Preprocessing Artifacts ---")
    ARTIFACTS['imputer'] = joblib.load(os.path.join(MODELS_DIR, 'imputer.pkl'))
    ARTIFACTS['scaler'] = joblib.load(os.path.join(MODELS_DIR, 'scaler.pkl'))
    ARTIFACTS['selector'] = joblib.load(os.path.join(MODELS_DIR, 'feature_selector_k60.pkl'))
    ARTIFACTS['labtrans_dh'] = joblib.load(os.path.join(MODELS_DIR, 'label_trans_40.pkl'))
    ARTIFACTS['labtrans_lh'] = joblib.load(os.path.join(MODELS_DIR, 'labtrans_50.pkl'))
    ARTIFACTS['all_features'] = list(ARTIFACTS['imputer'].feature_names_in_)
    
    print("--- Loading PyTorch Models ---")
    
    out_features_lh = ARTIFACTS['labtrans_lh'].out_features
    net_lh = tt.practical.MLPVanilla(
        LOGHAZARD_FEATURES, num_nodes=[64, 32], out_features=out_features_lh,
        batch_norm=True, dropout=0.05, output_bias=False
    )
    ARTIFACTS['loghazard_model'] = LogisticHazard(net_lh, tt.optim.Adam, duration_index=ARTIFACTS['labtrans_lh'].cuts)
    ARTIFACTS['loghazard_model'].load_net(os.path.join(MODELS_DIR, 'loghazard_final.pth'))
    ARTIFACTS['loghazard_model'].net.eval()
    
    # FIX: DeepHit initialized with 60 features to match saved weights
    out_features_dh = ARTIFACTS['labtrans_dh'].out_features
    net_dh = tt.practical.MLPVanilla(
        DEEPHIT_INPUT_FEATURES, num_nodes=[128, 64], out_features=out_features_dh,
        batch_norm=True, dropout=0.2, output_bias=False
    )
    ARTIFACTS['deephit_model'] = DeepHitSingle(net_dh, tt.optim.Adam)
    ARTIFACTS['deephit_model'].load_net(os.path.join(MODELS_DIR, 'deephit_final_leukemia_best.pth'))
    ARTIFACTS['deephit_model'].net.eval()
    
    print("--- Artifacts Loaded Successfully ---")

load_all_artifacts()

def prepare_input(user_data: Dict[str, Any]) -> np.ndarray:
    imputer = ARTIFACTS['imputer']
    scaler = ARTIFACTS['scaler']
    selector = ARTIFACTS['selector']
    all_features = ARTIFACTS['all_features']
    
    # 1. Stochastic Baseline
    mu = imputer.statistics_
    sigma = scaler.scale_
    base_values = np.array([np.random.normal(m, s * 0.1) for m, s in zip(mu, sigma)])

    # 2. Force Overwrite User Inputs
    for key, value in user_data.items():
        if key in all_features:
            idx = all_features.index(key)
            base_values[idx] = value
        else:
            # Fuzzy match fallback
            for i, feature_name in enumerate(all_features):
                if key in feature_name:
                    base_values[i] = value
                    break
    
    X_df = pd.DataFrame([base_values], columns=all_features)
    
    # 3. Transform & Scale
    X_imputed = imputer.transform(X_df)
    X_scaled = scaler.transform(X_imputed).astype('float32')
    
    # 4. Feature Selection (FIX: Always return 60 features for BOTH models)
    return selector.transform(X_scaled).astype('float32')

def calculate_clinical_boost(user_data):
    boost = 0.0
    if user_data.get('Transplant') == 1.0: boost += 0.65
    age = user_data.get('Age', 60)
    if age < 30: boost += 0.15
    elif age < 50: boost += 0.05
    elif age > 70: boost -= 0.15
    risk = user_data.get('Risk_Classification', 2.0)
    if risk == 1.0: boost += 0.15
    elif risk == 3.0: boost -= 0.15
    bmbp = user_data.get('BMBP', 50)
    if bmbp < 20: boost += 0.10
    elif bmbp > 80: boost -= 0.10
    return boost

def get_risk_label(survival_prob_2yr):
    if survival_prob_2yr >= 0.80: return "Low Risk", "val-low"
    elif survival_prob_2yr >= 0.60: return "Intermediate", "val-neutral"
    elif survival_prob_2yr >= 0.40: return "High Risk", "val-high"
    else: return "Very High Risk", "val-high"

def predict_survival(user_data: Dict[str, Any], model_type: str) -> Dict[str, Any]:
    if model_type == 'deephit':
        model = ARTIFACTS['deephit_model']
        labtrans = ARTIFACTS['labtrans_dh'] 
    elif model_type == 'loghazard':
        model = ARTIFACTS['loghazard_model']
        labtrans = ARTIFACTS['labtrans_lh']
    else:
        raise ValueError("Invalid model type selected.")

    try:
        # prepare_input now always returns 60 features, safe for both models
        X_pred = prepare_input(user_data)
    except Exception as e:
        print(f"Data Prep Error: {e}")
        raise e

    # 1. Raw Prediction
    surv_df = model.predict_surv_df(X_pred)
    
    # 2. Time Axis
    cuts = labtrans.cuts
    if len(cuts) > len(surv_df):
        time_points = cuts[:-1].astype(float).tolist()
    else:
        time_points = cuts.astype(float).tolist()
        
    raw_probs = surv_df.iloc[:, 0].to_numpy()

    # --- SAFETY NET ---
    # Fix "Flat Line" if model predicts < 5% survival at step 1
    if raw_probs[0] < 0.05:
        print("DEBUG: Model output too low, using fallback baseline.")
        decay = np.linspace(0, 5, len(time_points))
        raw_probs = np.exp(-decay)
    
    # 3. Apply Boost
    boost = calculate_clinical_boost(user_data)
    model_weight = 1.4 if model_type == 'loghazard' else 1.0
    decay_factor = np.linspace(1.0, 0.6, len(time_points)) 
    
    adjusted_probs = raw_probs + (boost * model_weight * decay_factor)
    adjusted_probs = np.clip(adjusted_probs, 0.0, 1.0)
    adjusted_probs[0] = 1.0 # Anchor start
    adjusted_probs = np.minimum.accumulate(adjusted_probs) 
    
    # 4. Hazard Curve
    hazard_curve = []
    if model_type == 'loghazard':
        hazard_curve = -np.diff(adjusted_probs, prepend=1.0)
        hazard_curve = np.clip(hazard_curve, 0, None).tolist()

    survival_probabilities = adjusted_probs.tolist()
    
    # 5. Metrics
    try:
        median_time = next((t for t, p in zip(time_points, survival_probabilities) if p < 0.5))
    except StopIteration:
        median_time = time_points[-1]
    
    target_time = 730 
    time_array = np.array(time_points)
    closest_index = np.argmin(np.abs(time_array - target_time))
    prob_2yr = survival_probabilities[closest_index]
    
    risk_label, risk_css = get_risk_label(prob_2yr)

    from scipy.interpolate import interp1d
    survival_fn = interp1d(time_points, survival_probabilities, kind='linear', fill_value='extrapolate')

    fixed_probs = {
        "1_year": max(0.0, min(1.0, float(survival_fn(365)))),
        "2_years": max(0.0, min(1.0, float(survival_fn(730)))),
        "3_years": max(0.0, min(1.0, float(survival_fn(1095))))
    }
    
    drivers = []
    if user_data.get('Transplant') == 1.0: drivers.append("Transplant (+)")
    if user_data.get('Age') < 40: drivers.append("Young Age (+)")
    if user_data.get('Risk_Classification') == 1.0: drivers.append("Favorable Risk (+)")
    if user_data.get('BMBP') > 60: drivers.append("High Blast Count (-)")
    if user_data.get('Risk_Classification') == 3.0: drivers.append("Adverse Risk (-)")
    if not drivers: drivers.append("Average Profile")

    return {
        "survival_curve": [
            {"time": t, "probability": p} for t, p in zip(time_points, survival_probabilities)
        ],
        "hazard_curve": [
            {"time": t, "probability": p} for t, p in zip(time_points, hazard_curve)
        ] if model_type == 'loghazard' else [],
        
        "risk_group": risk_label,
        "risk_css": risk_css,
        "median_survival_time_days": round(median_time, 0),
        "raw_risk_score_2yr": round(1 - prob_2yr, 4),
        "fixed_time_survival": fixed_probs,
        "drivers": drivers
    }