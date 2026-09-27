# PhyMamba-XGB burn-in analytics dashboard

A client-side screening dashboard adapted from the supplied ISRO prototype. The workspace starts with the supplied synthetic dataset and lets an operator load another CSV, select a measured signal, review component and lot risk, and export a screening result.

The left navigation switches between separate Overview, Lot analysis, Components, and Method pages. Dataset upload, signal selection, and result export remain available from each page.

## Run locally

Install the locked dependencies and start the Next.js app:

```powershell
npm.cmd ci
npm.cmd run dev
```

Open `http://localhost:3000` in a browser. CSV parsing and scoring run in the browser; uploaded data is not sent to a server.

## CSV format

Required columns are `Component_ID`, `Lot_ID`, and `Time_hr`. Include at least one of `Leakage_Current_uA`, `IDDQ_uA`, or `ON_Resistance_Ohm`. `Component_Family` and `Temperature_C` are used when present; `Voltage_V` and `Status` may also be included. Rows are repeated measurements for a component at burn-in timepoints. The input `Status` column is deliberately not used to calculate risk.

The supplied sample is available at `public/data/PS170_synthetic_burnin_dataset.csv` and loads when the dashboard opens.

## Prototype scoring and limits

The browser implementation is a transparent prototype proxy, not a trained PhyMamba-XGB model. It uses the early trajectory to extrapolate a 168-hour estimate, applies an Arrhenius-style temperature adjustment, compares drift and the latest reading with family peers using robust median/MAD statistics, and combines normalized features into a 0–100 score. The score maps to `Normal`, `Monitor`, or `Alert`. Lot status aggregates these component tiers.

The contribution bars explain the proxy features; they are not SHAP values. No model weights, trained PINN, trained Mamba, XGBoost checkpoint, calibration set, specification limits, or SHAP runtime were included in the supplied files. Risk thresholds and physics assumptions need engineering validation before operational screening.
