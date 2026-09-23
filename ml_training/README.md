# 🧠 GitVeritas Machine Learning Training & Benchmarking

This directory contains the offline Machine Learning experimentation pipeline used to benchmark classification algorithms, calibrate weights, and train the skill legitimacy classifier deployed to [`backend/ai_engine.js`](../backend/ai_engine.js).

---

## 📂 Files

* **`dataset.csv`**: Curated benchmark dataset of **150 skill-to-repository claim pairs** across 30 software developer profiles. Each row contains 6 extracted features and a ground-truth label:
  * `sbert_sim`: Dense vector Cosine Similarity from Sentence-BERT (`all-MiniLM-L6-v2`).
  * `evidence_strength`: Physical codebase proof from package manifests (`package.json`, `requirements.txt`) and AST imports, scaled $[0, 1]$.
  * `commits_norm`: Author commit count normalized via $\min(\text{commits}/10, 1.0)$.
  * `stars_norm`: Repository star count normalized via $\min(\text{stars}/5, 1.0)$.
  * `is_fork`: Binary indicator ($1$ if repo is a fork, $0$ otherwise).
  * `is_archived`: Binary indicator ($1$ if repo is read-only/archived, $0$ otherwise).
  * `label`: Ground-truth label ($1.0$ = Genuine, $0.5$ = Starter/Tutorial, $0.0$ = Inflated).

* **`train_model.py`**: Python evaluation script using `scikit-learn`. It splits the dataset 80% train / 20% test, compares 4 baseline algorithms (Decision Tree, Random Forest, Gaussian Naive Bayes, and Logistic Regression), prints precision/recall metrics, and outputs learned weight coefficients.

---

## 📊 Benchmark Results

| Algorithm Tested | Accuracy | Precision (Macro) | F1-Score | Result |
| :--- | :---: | :---: | :---: | :--- |
| **Decision Tree (Depth=3)** | 82.0% | 83.5% | 82.4% | Lost due to rigid step-function cutoffs |
| **Random Forest (30 Trees)** | 81.0% | 82.0% | 81.2% | Overfitted training data |
| **Gaussian Naive Bayes** | 78.0% | 79.5% | 78.1% | Violated feature independence |
| **Logistic Regression (L2)** | **86.7%** | **89.5%** | **88.3%** | 🏆 **WINNER:** Optimal precision & zero overfitting |

---

## ⚡ Running the Training Script

To run the offline benchmarking script locally:

```bash
# Ensure scikit-learn and pandas are installed
pip install scikit-learn pandas numpy

# Run the training script
python ml_training/train_model.py
```
