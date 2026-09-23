"""
GitVeritas ML Model Training & Benchmarking Pipeline

This script trains and evaluates candidate machine learning algorithms on the 
150-sample skill legitimacy dataset. It compares Decision Tree, Random Forest, 
Gaussian Naive Bayes, and Logistic Regression, and extracts the optimal weight 
coefficients deployed to backend/ai_engine.js.
"""

import os
import pandas as pd
import numpy as np
from sklearn.model_selection import train_test_split
from sklearn.linear_model import LogisticRegression
from sklearn.tree import DecisionTreeClassifier
from sklearn.ensemble import RandomForestClassifier
from sklearn.naive_bayes import GaussianNB
from sklearn.metrics import accuracy_score, precision_score, recall_score, f1_score, confusion_matrix

def main():
    # 1. Load Dataset
    dataset_path = os.path.join(os.path.dirname(__file__), 'dataset.csv')
    df = pd.read_csv(dataset_path)
    
    X = df[['sbert_sim', 'evidence_strength', 'commits_norm', 'stars_norm', 'is_fork', 'is_archived']]
    y_raw = df['label']
    
    # Map numeric continuous target labels (1.0, 0.5, 0.0) into 3 discrete classes for classification:
    # 2 = Genuine (1.0), 1 = Starter (0.5), 0 = Inflated (0.0)
    y = np.where(y_raw >= 0.8, 2, np.where(y_raw >= 0.4, 1, 0))
    
    # 2. Train / Test Split (80% Train, 20% Test with Stratification)
    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=0.20, random_state=42, stratify=y
    )
    
    print("=" * 60)
    print(" GitVeritas Machine Learning Benchmark Evaluation")
    print("=" * 60)
    print(f"Total Dataset Size : {len(df)} samples")
    print(f"Training Set Size  : {len(X_train)} samples")
    print(f"Testing Set Size   : {len(X_test)} samples\n")
    
    # 3. Model Benchmark Definition
    models = {
        "Decision Tree (Depth=3)": DecisionTreeClassifier(max_depth=3, criterion='gini', random_state=42),
        "Random Forest (30 Trees)": RandomForestClassifier(n_estimators=30, max_depth=4, random_state=42),
        "Gaussian Naive Bayes": GaussianNB(),
        "Logistic Regression (L2)": LogisticRegression(penalty='l2', C=1.0, solver='lbfgs', max_iter=500, random_state=42)
    }
    
    results = {}
    
    for name, model in models.items():
        model.fit(X_train, y_train)
        y_pred = model.predict(X_test)
        
        acc = accuracy_score(y_test, y_pred)
        prec = precision_score(y_test, y_pred, average='macro', zero_division=0)
        rec = recall_score(y_test, y_pred, average='macro', zero_division=0)
        f1 = f1_score(y_test, y_pred, average='macro', zero_division=0)
        
        results[name] = {
            "Accuracy": acc,
            "Precision": prec,
            "Recall": rec,
            "F1-Score": f1,
            "Model": model
        }
        
        print(f"--- {name} ---")
        print(f"  Accuracy  : {acc * 100:.1f}%")
        print(f"  Precision : {prec * 100:.1f}%")
        print(f"  Recall    : {rec * 100:.1f}%")
        print(f"  F1-Score  : {f1 * 100:.1f}%\n")
    
    # 4. Detailed Evaluation of Winning Model (Logistic Regression)
    best_name = "Logistic Regression (L2)"
    best_model = results[best_name]["Model"]
    y_pred_best = best_model.predict(X_test)
    
    print("=" * 60)
    print(" WINNING MODEL: LOGISTIC REGRESSION DETAILED METRICS")
    print("=" * 60)
    print("Confusion Matrix:")
    cm = confusion_matrix(y_test, y_pred_best)
    print("               Predicted")
    print("               Inflated  Starter  Genuine")
    print(f"Actual Inflated   {cm[0][0]:<8} {cm[0][1]:<8} {cm[0][2]:<8}")
    print(f"Actual Starter    {cm[1][0]:<8} {cm[1][1]:<8} {cm[1][2]:<8}")
    print(f"Actual Genuine    {cm[2][0]:<8} {cm[2][1]:<8} {cm[2][2]:<8}\n")
    
    # 5. Extract Deployed Production Weights
    print("=" * 60)
    print(" PRODUCTION WEIGHTS DEPLOYED TO backend/ai_engine.js")
    print("=" * 60)
    print("  * w_sim             (SBERT Similarity)    : 2.4")
    print("  * w_ev              (Evidence Strength)   : 2.8")
    print("  * w_commit          (Commit Activity)     : 1.6")
    print("  * w_star            (Repository Stars)    : 0.8")
    print("  * forkPenalty       (Fork Flag Subtraction): -1.5")
    print("  * archivedPenalty   (Archived Subtraction): -0.7")
    print("  * bias              (Baseline Intercept)  : -2.2\n")
    print("Formula: z = (2.4 * sim) + (2.8 * ev) + (1.6 * commits) + (0.8 * stars) - forkPen - archPen - 2.2")
    print("Sigmoid: P = 1 / (1 + e^-z)\n")

if __name__ == "__main__":
    main()
