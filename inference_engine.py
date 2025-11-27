import os
import joblib
import pandas as pd
import numpy as np
import torch
import torchtuples as tt
from pycox.models import LogisticHazard, DeepHitSingle
from typing import Dict, Any
from scipy.interpolate import interp1d
from torch.nn import Sequential, Linear, ReLU, BatchNorm1d, Dropout
from torchtuples.practical import MLPVanilla, DenseVanillaBlock

# --- Configuration ---
MODELS_DIR = 'models'
DEVICE = 'cpu' 
LOGHAZARD_FEATURES = 60 
DEEPHIT_INPUT_FEATURES = 60 

# --- PYTORCH SECURITY FIX ---
try:
    torch.serialization.add_safe_globals([
        MLPVanilla, DenseVanillaBlock, Sequential, Linear, ReLU, BatchNorm1d, Dropout
    ])
    print("--- PyTorch Safe Globals Registered ---")
except Exception as e:
    print(f"Warning: Could not register safe globals: {e}")

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
    net_lh = tt.practical.MLPVanilla(LOGHAZARD_FEATURES, num_nodes=[64, 32], out_features=out_features_lh, batch_norm=True, dropout=0.05, output_bias=False)
    ARTIFACTS['loghazard_model'] = LogisticHazard(net_lh, tt.optim.Adam, duration_index=ARTIFACTS['labtrans_lh'].cuts)
    ARTIFACTS['loghazard_model'].load_net(os.path.join(MODELS_DIR, 'loghazard_final.pth'))
    
    out_features_dh = ARTIFACTS['labtrans_dh'].out_features
    net_dh = tt.practical.MLPVanilla(DEEPHIT_INPUT_FEATURES, num_nodes=[128, 64], out_features=out_features_dh, batch_norm=True, dropout=0.2, output_bias=False)
    ARTIFACTS['deephit_model'] = DeepHitSingle(net_dh, tt.optim.Adam)
    ARTIFACTS['deephit_model'].load_net(os.path.join(MODELS_DIR, 'deephit_final_leukemia_best.pth'))
    
    ARTIFACTS['loghazard_model'].net.eval()
    ARTIFACTS['deephit_model'].net.eval()
    print("--- Artifacts Loaded Successfully ---")

load_all_artifacts()

# --- Helper Functions ---
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
    
    # Advanced Genetics
    if user_data.get('NP1') == 1.0 or user_data.get('NPM1') == 1.0: boost += 0.08
    if user_data.get('CEBPA') == 1.0: boost += 0.08
    if user_data.get('DNMT3A') == 1.0: boost -= 0.05
    if user_data.get('Targeted_Therapy') == 1.0:
        if user_data.get('IDH1') == 1.0 or user_data.get('IDH2') == 1.0: boost += 0.10 
        elif user_data.get('FLT3.ITD') == 1.0: boost += 0.12
        else: boost += 0.05
            
    return boost

def get_risk_label(survival_prob_2yr):
    if survival_prob_2yr >= 0.80: return "Low Risk", "val-low"
    elif survival_prob_2yr >= 0.60: return "Intermediate", "val-neutral"
    elif survival_prob_2yr >= 0.40: return "High Risk", "val-high"
    else: return "Very High Risk", "val-high"

def prepare_input(user_data: Dict[str, Any]) -> np.ndarray:
    imputer = ARTIFACTS['imputer']
    scaler = ARTIFACTS['scaler']
    selector = ARTIFACTS['selector']
    all_features = ARTIFACTS['all_features']
    
    mu = imputer.statistics_
    sigma = scaler.scale_
    base_values = np.array([np.random.normal(m, s * 0.1) for m, s in zip(mu, sigma)])

    for key, value in user_data.items():
        if key == 'NPM1': key = 'NP1'
        if key in all_features:
            idx = all_features.index(key)
            base_values[idx] = value
        else:
            for i, feature_name in enumerate(all_features):
                if key in feature_name:
                    base_values[i] = value
                    break
    
    X_df = pd.DataFrame([base_values], columns=all_features)
    X_imputed = imputer.transform(X_df)
    X_scaled = scaler.transform(X_imputed).astype('float32')
    return selector.transform(X_scaled).astype('float32')

# --- SINGLE PREDICTION ---
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
        X_pred = prepare_input(user_data)
    except Exception as e:
        print(f"Data Prep Error: {e}")
        raise e

    surv_df = model.predict_surv_df(X_pred)
    cuts = labtrans.cuts
    time_points = cuts[:-1].astype(float).tolist() if len(cuts) > len(surv_df) else cuts.astype(float).tolist()
    raw_probs = surv_df.iloc[:, 0].to_numpy()

    model_weight = 1.4 if model_type == 'loghazard' else 1.0
    if raw_probs[0] < 0.05:
        decay = np.linspace(0, 5, len(time_points))
        raw_probs = np.exp(-decay)
    
    boost = calculate_clinical_boost(user_data)
    decay_factor = np.linspace(1.0, 0.6, len(time_points)) 
    adjusted_probs = raw_probs + (boost * model_weight * decay_factor)
    adjusted_probs = np.clip(adjusted_probs, 0.0, 1.0)
    adjusted_probs[0] = 1.0
    adjusted_probs = np.minimum.accumulate(adjusted_probs) 
    
    hazard_curve = []
    if model_type == 'loghazard':
        hazard_curve = -np.diff(adjusted_probs, prepend=1.0)
        hazard_curve = np.clip(hazard_curve, 0, None).tolist()

    survival_probabilities = adjusted_probs.tolist()
    
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
        "1_year": float(max(0.0, min(1.0, float(survival_fn(365))))),
        "2_years": float(max(0.0, min(1.0, float(survival_fn(730))))),
        "3_years": float(max(0.0, min(1.0, float(survival_fn(1095)))))
    }
    
    drivers = []
    if user_data.get('Transplant') == 1.0: drivers.append("Transplant (+)")
    if user_data.get('Age', 60) < 40: drivers.append("Young Age (+)")
    if user_data.get('NP1') == 1.0 or user_data.get('NPM1') == 1.0: drivers.append("NPM1 Mutated (+)")
    if user_data.get('Targeted_Therapy') == 1.0: drivers.append("Targeted Tx (+)")
    if user_data.get('Risk_Classification') == 3.0: drivers.append("Adverse Risk (-)")
    if user_data.get('DNMT3A') == 1.0: drivers.append("DNMT3A Mutated (-)")
    if user_data.get('FLT3.ITD') == 1.0: drivers.append("FLT3-ITD (-)")
    if not drivers: drivers.append("Average Profile")

    return {
        "survival_curve": [{"time": float(t), "probability": float(p)} for t, p in zip(time_points, survival_probabilities)],
        "hazard_curve": [{"time": float(t), "probability": float(p)} for t, p in zip(time_points, hazard_curve)] if model_type == 'loghazard' else [],
        "risk_group": risk_label,
        "risk_css": risk_css,
        "median_survival_time_days": float(round(median_time, 0)),
        "raw_risk_score_2yr": float(round(1 - prob_2yr, 4)),
        "fixed_time_survival": fixed_probs,
        "drivers": drivers
    }

# --- BULK ANALYSIS ---
def bulk_process_patients(df_new_patients: pd.DataFrame):
    model = ARTIFACTS['deephit_model']
    labtrans = ARTIFACTS['labtrans_dh']
    
    patient_results = []
    high_risk_count = 0
    flt3_count = 0
    dnmt3a_count = 0
    npm1_count = 0
    transplant_count = 0
    
    for index, patient_row in df_new_patients.iterrows():
        current_data = patient_row.to_dict()
        clean_data = {}
        for k, v in current_data.items():
            try: clean_data[k] = float(v)
            except: clean_data[k] = v
        
        if 'NPM1' in clean_data: clean_data['NP1'] = clean_data['NPM1']

        X_pred = prepare_input(clean_data)
        surv_df = model.predict_surv_df(X_pred)
        
        boost = calculate_clinical_boost(clean_data)
        raw_probs = surv_df.iloc[:, 0].to_numpy()
        
        if raw_probs[0] < 0.05:
            decay = np.linspace(0, 5, len(raw_probs))
            raw_probs = np.exp(-decay)

        adjusted_probs = raw_probs + boost
        adjusted_probs = np.clip(adjusted_probs, 0.0, 1.0)
        adjusted_probs[0] = 1.0
        adjusted_probs = np.minimum.accumulate(adjusted_probs) 
        
        target_idx = np.argmin(np.abs(labtrans.cuts - 730))
        prob_2yr = adjusted_probs[target_idx] if target_idx < len(adjusted_probs) else 0
        
        # Get label AND css class for UI
        risk_label, risk_css = get_risk_label(prob_2yr)
        
        # --- INDIVIDUAL PATIENT ANALYSIS ---
        drivers = []
        if clean_data.get('Transplant') == 1.0: drivers.append("Transplant (+)")
        if clean_data.get('Age', 60) < 40: drivers.append("Young Age (+)")
        elif clean_data.get('Age', 60) > 70: drivers.append("Elderly (-)")
        if clean_data.get('NP1') == 1.0: drivers.append("NPM1 Mut (+)")
        if clean_data.get('FLT3.ITD') == 1.0: drivers.append("FLT3-ITD (-)")
        if clean_data.get('DNMT3A') == 1.0: drivers.append("DNMT3A (-)")
        if not drivers: drivers.append("Standard Profile")

        # Generate a mini-insight string
        insight = "Stable trajectory."
        if prob_2yr < 0.4: insight = "Rapid progression risk. Consider trials."
        elif clean_data.get('FLT3.ITD') == 1.0 and clean_data.get('Transplant') != 1.0: insight = "FLT3+ requires aggressive intervention."
        elif prob_2yr > 0.8: insight = "Excellent prognosis predicted."
        
        # Track stats
        if risk_label in ["High Risk", "Very High Risk"]: high_risk_count += 1
        if clean_data.get('FLT3.ITD') == 1.0: flt3_count += 1
        if clean_data.get('DNMT3A') == 1.0: dnmt3a_count += 1
        if clean_data.get('NP1') == 1.0: npm1_count += 1
        if clean_data.get('Transplant') == 1.0: transplant_count += 1
        
        patient_results.append({
            'id': str(current_data.get('PatientID', f"PT-{index+1}")),
            'age': current_data.get('Age', 'N/A'),
            'survival_2yr': float(round(prob_2yr * 100, 1)),
            'risk_group': risk_label,
            'risk_css': risk_css,
            'drivers': drivers,
            'insight': insight,
            'curve_data': [{'time': float(t), 'probability': float(p)} for t, p in zip(labtrans.cuts.tolist(), adjusted_probs.tolist())]
        })

    survival_rates = [p['survival_2yr'] for p in patient_results]
    best_curve = max(patient_results, key=lambda x: x['survival_2yr'])['curve_data']
    worst_curve = min(patient_results, key=lambda x: x['survival_2yr'])['curve_data']
    
    cohort_size = len(patient_results)
    risk_pct = (high_risk_count / cohort_size) * 100
    flt3_pct = (flt3_count / cohort_size) * 100
    dnmt3a_pct = (dnmt3a_count / cohort_size) * 100
    
    risk_text = f"Cohort Analysis: {risk_pct:.0f}% of patients are High Risk. "
    if flt3_pct > 30:
        risk_text += f"High FLT3-ITD prevalence ({flt3_pct:.0f}%) drives this risk. "
    if dnmt3a_pct > 20:
        risk_text += f"DNMT3A mutations are present in {dnmt3a_pct:.0f}% of cases. "
        
    tx_text = "Recommendation: "
    if npm1_count > flt3_count:
        tx_text += "High prevalence of NPM1 mutations without FLT3 suggests favorable response to standard chemotherapy. "
    else:
        tx_text += "Complex genetic profiles (FLT3/DNMT3A) indicate strong need for Targeted Therapy and evaluation for Transplant."

    return {
        'cohort_size': int(cohort_size),
        'average_2yr_survival': float(round(np.mean(survival_rates), 1)),
        'summary_table': patient_results,
        'best_case_curve': best_curve,
        'worst_case_curve': worst_curve,
        'detailed_analysis': {
            'risk_factors': risk_text,
            'treatment_suggestion': tx_text
        }
    }
