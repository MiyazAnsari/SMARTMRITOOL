# -*- coding: utf-8 -*-
"""scripts_v4.py

Derived from scripts_v3.ipynb (Colab inter-rater reliability notebook).

# MSK Annotation Suite — Inter-Rater Reliability Notebook (Planar, Standardized)

**v4 additions:** automatic line endpoint standardization (direction-agnostic),
anatomical sulcus condyle relabeling by laterality, and a tidy landmark table
aligned by Case ID × Rater ID for ICC / ML export.

# MSK Annotation Suite — Inter-Rater Reliability Notebook (Planar)

Analyses inter-rater reliability for the **six knee-MRI measurement protocols** exported
by the MSK Annotation Suite (`protocolMeasurementCsv.ts`).

> **Scope: planar (in-plane) analysis only.** This notebook treats every landmark as a
> 2D coordinate (`x, y`) and deliberately ignores slice/Z-axis variability. A rater's
> chosen slice is taken as given; we ask only "given that two raters looked at (roughly)
> the same slice, how well do their in-plane clicks agree?" Z-axis disagreement,
> slice-selection consensus, and soft Z-targets for a 2-stage model are **out of scope**
> for this version and have been removed rather than left as dead code.

The notebook tells one continuous story, in order:

| Part | Section | Narrative beat |
|------|---------|----------------|
| I | 1 | **Ingest** — load every CSV, determine who the raters actually are |
| I | 1.5 | **Standardize** — normalize line directions; correct sulcus lateral/medial by laterality |
| I | 2 | **Inventory** — what did each rater annotate, and how much of it |
| II | 3 | **Clinical agreement** — do raters land on the same diagnostic number? (ICC, Pearson) |
| II | 4 | **Clinical agreement, visually** — Bland-Altman per protocol per rater pair |
| II | 5 | **Bias summary** — pooled bias / limits-of-agreement table, flagged for systematic offset |
| III | 6 | **Planar landmark agreement** — do raters click the same (x, y), independent of Z? |
| III | 7 | **Outlier triage** — which specific landmarks disagree the most, and why |
| IV | 8 | **Ground truth for ML** — average clinical values into one label, weighted by ICC |
| IV | 9 | **Readiness** — versioning hygiene, duplicate-run detection, per-protocol sample sizes |

Parts I–II answer "can we trust the *clinical numbers*"; Part III answers "can we trust
the *clicks themselves*, in-plane"; Part IV turns both answers into a usable dataset.

> **Rater identity:** a rater is identified by `(sessionUser, sessionUserEmail)`, **not**
> by filename. A single rater can export multiple CSVs (e.g. one per session); a single
> CSV file could in principle contain rows from more than one session. All files are
> loaded and concatenated first, then split into raters by identity.
>
> **Protocol identity:** `protocolId` stores `'sulcus-angle'` for **both** plain Sulcus
> Angle and Sulcus Angle 3 cm. The `groupId` prefix is the only reliable discriminator —
> all protocol grouping uses `true_protocol`, extracted from `groupId`.
>
> **Defaults to comparing all raters found.** Pairwise outputs (Bland-Altman, planar
> scatter) are produced for every rater pair; ICC and pooled summaries use all raters
> at once.

---
## Part I — Ingestion and Inventory

### 1. Mount Google Drive, Load CSVs, Identify Raters

Loads **every** CSV in the folder (regardless of filename), concatenates them, then
groups rows by `(sessionUser, sessionUserEmail)` to determine the actual rater set.
This means:
- One rater can have many files (e.g. split by session) — they're merged automatically.
- Filenames are irrelevant to rater identity; only used as a fallback display label if
  `sessionUser` is missing.
- The analysis defaults to **all raters found**, however many there are.
"""

import pandas as pd
import os
from pathlib import Path

# Colab/notebook helper — in plain Python, fall back to printing the object
try:
    from IPython.display import display  # type: ignore
except ImportError:
    def display(obj):
        print(obj)

# =============================================================================
# PATH CONFIG — edit LOCAL_PROJECT_PATH only if auto-detect cannot find Drive
# =============================================================================
# After Google Drive for Desktop is installed and signed in, leave this as None
# and the script will look for:
#   .../My Drive/Current Knee MRI Project Folder/csv exports
# If you prefer, paste the full Finder path here (right-click folder → Option→Copy
# as Pathname), e.g.:
#   LOCAL_PROJECT_PATH = "/Users/you/Library/CloudStorage/GoogleDrive-you@email/My Drive/Current Knee MRI Project Folder"
LOCAL_PROJECT_PATH = None

PROJECT_FOLDER_NAME = 'Current Knee MRI Project Folder'
CSV_SUBFOLDER_NAME = 'csv exports'


def _candidate_drive_project_paths():
    """Likely locations of the shared folder once Drive for Desktop is syncing."""
    home = Path.home()
    candidates = []

    cloud = home / 'Library' / 'CloudStorage'
    if cloud.is_dir():
        for entry in sorted(cloud.iterdir()):
            if entry.name.startswith('GoogleDrive'):
                candidates.append(entry / 'My Drive' / PROJECT_FOLDER_NAME)
                candidates.append(entry / 'MyDrive' / PROJECT_FOLDER_NAME)

    # Legacy / alternate mount points some Macs still use
    for base in (
        home / 'Google Drive' / 'My Drive',
        home / 'Google Drive',
        Path('/Volumes/GoogleDrive/My Drive'),
    ):
        candidates.append(base / PROJECT_FOLDER_NAME)

    if LOCAL_PROJECT_PATH:
        candidates.insert(0, Path(LOCAL_PROJECT_PATH).expanduser())

    # Last resort: csv exports sitting inside this git repo
    candidates.append(Path(__file__).resolve().parent / PROJECT_FOLDER_NAME)
    candidates.append(Path(__file__).resolve().parent)

    return candidates


def resolve_project_path():
    """Colab Drive mount if available; otherwise Drive Desktop / local folder."""
    try:
        from google.colab import drive  # type: ignore
        drive.mount('/content/drive')
        return Path('/content/drive/MyDrive') / PROJECT_FOLDER_NAME
    except Exception:
        pass

    for project in _candidate_drive_project_paths():
        csv_dir = project / CSV_SUBFOLDER_NAME
        if csv_dir.is_dir():
            return project

    searched = '\n'.join(f'  - {p / CSV_SUBFOLDER_NAME}' for p in _candidate_drive_project_paths())
    raise FileNotFoundError(
        'Could not find the measurement CSV folder.\n\n'
        f'Looking for: "{PROJECT_FOLDER_NAME}/{CSV_SUBFOLDER_NAME}"\n\n'
        'Fix checklist:\n'
        '  1. Install Google Drive for Desktop and sign in.\n'
        '  2. In drive.google.com, add the shared project as a shortcut to My Drive.\n'
        '  3. Wait until Finder shows that folder under Google Drive.\n'
        '  4. Or set LOCAL_PROJECT_PATH near the top of scripts.py to the Finder path.\n\n'
        f'Paths tried:\n{searched}'
    )


project_path = resolve_project_path()
csv_folder = project_path / CSV_SUBFOLDER_NAME
figures_folder = project_path / 'figures'
print(f'Using project folder: {project_path}')
print(f'Using CSV folder:     {csv_folder}')
print(f'Figures will save to: {figures_folder}')

# ── Load every CSV file, tag with source filename, concatenate ───────────────
csv_files = sorted(f for f in os.listdir(csv_folder) if f.lower().endswith('.csv'))
print(f"Found {len(csv_files)} CSV file(s): {csv_files}")

raw_frames = []
for fname in csv_files:
    fdf = pd.read_csv(os.path.join(csv_folder, fname))
    fdf['__source_file'] = fname
    raw_frames.append(fdf)

all_rows = pd.concat(raw_frames, ignore_index=True)

# ── Derive true_protocol from groupId ─────────────────────────────────────────
# groupId format: '<protocol-slug>-<timestamp>'  e.g. 'sulcus-angle-3cm-1781115379010'
# protocolId is unreliable for sulcus-angle vs sulcus-angle-3cm (both stored as 'sulcus-angle')
all_rows['true_protocol'] = all_rows['groupId'].str.extract(r'^([a-z][a-z0-9]*(?:-[a-z0-9]+)*?)-\d+$')

# ── Identify raters by (sessionUser, sessionUserEmail) — NOT by filename ─────
if 'sessionUserEmail' in all_rows.columns and all_rows['sessionUserEmail'].notna().any():
    id_cols = ['sessionUser', 'sessionUserEmail']
else:
    # Fallback: no identity columns present, treat each source file as one rater
    print("⚠ sessionUser/sessionUserEmail not found — falling back to filename as rater identity.")
    id_cols = ['__source_file']

all_rows['rater_key'] = all_rows[id_cols].astype(str).agg(' | '.join, axis=1)

# ── Split into per-rater dataframes ───────────────────────────────────────────
dataframes = {key: grp.copy() for key, grp in all_rows.groupby('rater_key')}
rater_keys = sorted(dataframes.keys())

print(f"\nRaters identified ({len(rater_keys)}):")
for rk in rater_keys:
    df = dataframes[rk]
    files = df['__source_file'].unique().tolist()
    print(f"  '{rk}': {len(df)} rows from {len(files)} file(s) {files}")

if len(rater_keys) < 2:
    raise ValueError(
        f"Need at least 2 raters for comparison. Found: {rater_keys}\n"
        "Check that sessionUser/sessionUserEmail are populated correctly in each export."
    )

print(f"\nDefaulting to comparing all {len(rater_keys)} raters: {rater_keys}")

"""### 1.5. Line Standardization — Endpoints and Sulcus Anatomical Matching

Raters may draw the same anatomical line in opposite directions (top↔bottom,
left↔right). Sulcus-angle raters may also swap lateral vs. medial condyle labels,
especially on left-knee axial slices. Before any agreement statistics, every
`step_measurement` row is normalized in-place:

1. **Endpoint standardization** — for each drawn line (`measurementType == 'distance'`,
   `pointCount ≥ 2`), sort pt[0]/pt[1] by geometry:
   - horizontal-ish (`|Δx| ≥ |Δy|`): left → right (ascending X)
   - vertical-ish (`|Δy| > |Δx|`): top → bottom (ascending Y)
2. **Sulcus condyle matching** — within each sulcus case, compare mean X of the
   two condyle lines and relabel by laterality:
   - **Left knee:** lateral condyle = higher X, medial = lower X
   - **Right knee:** lateral condyle = lower X, medial = higher X
3. **Tidy landmark export** — `standardized_landmarks_df` with one row per
   landmark endpoint, keyed on `patientId` (Case ID) × `rater_key` (Rater ID).
"""

import json

import numpy as np

# Protocols / steps subject to sulcus anatomical relabeling
SULCUS_PROTOCOLS = {'sulcus-angle', 'sulcus-angle-3cm'}
SULCUS_CONDYLE_STEPS = {'lateral-line', 'medial-line'}

# Sulcus grouping: one protocol run (both condyle lines share groupId)
SULCUS_GROUP_KEYS = ['patientId', 'laterality', 'true_protocol', 'groupId', 'rater_key']


def parse_points_json(val):
    """Parse stepPointsMmJson / pointsJson into a list of {x, y, z?} dicts."""
    try:
        pts = json.loads(val) if isinstance(val, str) else val
        return pts if isinstance(pts, list) else []
    except (TypeError, json.JSONDecodeError):
        return []


def serialize_points_json(pts):
    """Serialize point list back to the export JSON string format."""
    return json.dumps(pts)


def sync_flat_point_columns(row, pts):
    """Write standardized points back into p0_*/p1_*/p2_* flat columns."""
    for i, pt in enumerate(pts[:4]):
        for axis in ('x', 'y', 'z'):
            col = f'p{i}_{axis}'
            if col in row.index:
                row[col] = pt.get(axis, np.nan)
    return row


def line_center_x(pts):
    """Mean X of the two drawn endpoints (ignores foot-of-perpendicular)."""
    if len(pts) < 2:
        return np.nan
    return (pts[0]['x'] + pts[1]['x']) / 2.0


def standardize_line_endpoints(pts):
    """
    Direction-agnostic endpoint ordering for a drawn line segment.

    Rules (applied to pt[0] and pt[1] only):
      - Horizontal-ish (|Δx| >= |Δy|): sort left → right (ascending X).
      - Vertical-ish   (|Δy| >  |Δx|): sort top  → bottom (ascending Y).

    Any trailing derived points (e.g. foot-of-perpendicular at index 2) are
    preserved; when endpoints swap, the foot is re-anchored to the new pt[1].

    Returns
    -------
    (pts_out, swapped) : standardized list and whether pt[0]/pt[1] were reversed.
    """
    if len(pts) < 2:
        return pts, False

    p0, p1 = dict(pts[0]), dict(pts[1])
    dx = abs(p1['x'] - p0['x'])
    dy = abs(p1['y'] - p0['y'])

    swapped = False
    if dx >= dy:
        if p0['x'] > p1['x']:
            p0, p1 = p1, p0
            swapped = True
    else:
        if p0['y'] > p1['y']:
            p0, p1 = p1, p0
            swapped = True

    out = [p0, p1] + [dict(p) for p in pts[2:]]
    if swapped and len(out) >= 3:
        # Foot-of-perpendicular is tied to endpoint pt[1]; move it with the anchor.
        out[2]['x'] = out[1]['x']
        out[2]['y'] = out[1]['y']
        if 'z' in out[1]:
            out[2]['z'] = out[1]['z']
    return out, swapped


def lateral_is_higher_x(laterality):
    """
    Return True when the lateral condyle should sit on the higher-X image side.

    Left knee (axial, viewed from below): lateral on the right → higher X.
    Right knee: orientation flips → lateral on the left → lower X.
    """
    lat = str(laterality).strip().lower()
    if lat == 'left':
        return True
    if lat == 'right':
        return False
    return None


def apply_endpoint_standardization_to_row(row):
    """Standardize drawn-line endpoints on a single step_measurement row."""
    if row.get('recordType') != 'step_measurement':
        return row, False
    if row.get('measurementType') != 'distance':
        return row, False
    if pd.isna(row.get('pointCount')) or int(row['pointCount']) < 2:
        return row, False

    pts = parse_points_json(row.get('stepPointsMmJson'))
    if len(pts) < 2:
        return row, False

    std_pts, swapped = standardize_line_endpoints(pts)
    if not swapped:
        return row, False

    row = row.copy()
    row['stepPointsMmJson'] = serialize_points_json(std_pts)
    if 'pointsJson' in row.index and pd.notna(row.get('pointsJson')):
        row['pointsJson'] = serialize_points_json(std_pts)
    row = sync_flat_point_columns(row, std_pts)
    row['endpoints_standardized'] = True
    return row, True


def correct_sulcus_condyle_labels(df):
    """
    Within each sulcus protocol run, assign lateral-line / medial-line by mean X
    and laterality — regardless of the label the rater originally chose.

    Geometry stays on the same measurement row; only stepId / stepLabel are
    rewritten when a rater picked the wrong condyle name for that line's X position.
    """
    df = df.copy()
    if 'sulcus_label_corrected' not in df.columns:
        df['sulcus_label_corrected'] = False
    if 'original_stepId' not in df.columns:
        df['original_stepId'] = df['stepId']

    SULCUS_STEP_LABELS = {
        'lateral-line': 'Line from lateral condyle peak to sulcus',
        'medial-line':  'Line from medial condyle peak to sulcus',
    }

    step_mask = (
        (df['recordType'] == 'step_measurement')
        & (df['true_protocol'].isin(SULCUS_PROTOCOLS))
        & (df['stepId'].isin(SULCUS_CONDYLE_STEPS))
    )
    if not step_mask.any():
        return df

    for _group_key, grp in df.loc[step_mask].groupby(SULCUS_GROUP_KEYS):
        if len(grp) != 2:
            continue

        idx_a, idx_b = grp.index[0], grp.index[1]
        cx_a = line_center_x(parse_points_json(df.at[idx_a, 'stepPointsMmJson']))
        cx_b = line_center_x(parse_points_json(df.at[idx_b, 'stepPointsMmJson']))

        laterality = df.at[idx_a, 'laterality']
        higher_x_is_lateral = lateral_is_higher_x(laterality)
        if higher_x_is_lateral is None:
            continue

        # Map each row's geometry to the anatomically correct stepId
        if higher_x_is_lateral:
            target = {idx_a: ('lateral-line' if cx_a >= cx_b else 'medial-line'),
                      idx_b: ('lateral-line' if cx_b > cx_a else 'medial-line')}
        else:
            target = {idx_a: ('lateral-line' if cx_a <= cx_b else 'medial-line'),
                      idx_b: ('lateral-line' if cx_b < cx_a else 'medial-line')}

        for idx, new_step in target.items():
            if df.at[idx, 'stepId'] == new_step:
                continue
            df.at[idx, 'original_stepId'] = df.at[idx, 'stepId']
            df.at[idx, 'stepId'] = new_step
            if 'stepLabel' in df.columns:
                df.at[idx, 'stepLabel'] = SULCUS_STEP_LABELS.get(new_step, df.at[idx, 'stepLabel'])
            df.at[idx, 'sulcus_label_corrected'] = True

    return df


def standardize_rater_dataframe(df, rater_key):
    """
    Full standardization pass for one rater's annotations:
      1) endpoint ordering on all distance-type lines
      2) sulcus lateral/medial relabeling by laterality + mean X
    """
    df = df.copy()
    df['rater_key'] = rater_key
    df['endpoints_standardized'] = False
    df['original_stepId'] = df['stepId']

    step_idx = df.index[df['recordType'] == 'step_measurement']
    n_endpoints = 0
    for idx in step_idx:
        new_row, changed = apply_endpoint_standardization_to_row(df.loc[idx])
        if changed:
            df.loc[idx] = new_row
            n_endpoints += 1

    df = correct_sulcus_condyle_labels(df)
    n_sulcus = int(df.get('sulcus_label_corrected', pd.Series(False)).sum())

    print(
        f"  {rater_key.split(' | ')[0]}: "
        f"{n_endpoints} line(s) endpoint-standardized, "
        f"{n_sulcus} sulcus condyle row(s) anatomically relabeled"
    )
    return df


def build_standardized_landmarks_df(dataframes, rater_keys):
    """
    Tidy landmark table for inter-rater variability / ML.

    One row per drawn endpoint (or single point), aligned by:
      - patientId  (Case ID)
      - rater_key  (Rater ID)
      - laterality, true_protocol, stepId (standardized)

    Line landmarks expose start_x/start_y and end_x/end_y; multi-point steps
    also include point_index for finer-grained ICC.
    """
    rows = []
    for rk in rater_keys:
        df = dataframes[rk]
        steps = df[df['recordType'] == 'step_measurement']
        for _, row in steps.iterrows():
            pts = parse_points_json(row.get('stepPointsMmJson'))
            if not pts:
                continue

            mtype = row.get('measurementType')
            pc = int(row['pointCount']) if pd.notna(row.get('pointCount')) else len(pts)
            # Planar comparison uses pt[0:2] for 3-point distance lines
            effective = pts[:2] if (mtype == 'distance' and pc == 3) else pts

            base = {
                'patientId':     row['patientId'],
                'laterality':    row['laterality'],
                'true_protocol': row['true_protocol'],
                'groupId':       row.get('groupId'),
                'rater_key':     rk,
                'rater_name':    rk.split(' | ')[0],
                'stepId':        row['stepId'],
                'original_stepId': row.get('original_stepId', row['stepId']),
                'stepLabel':     row.get('stepLabel'),
                'plane':         row.get('plane'),
                'sliceIndex':    row.get('sliceIndex'),
                'measurementType': mtype,
                'pointCount':    pc,
                'endpoints_standardized': bool(row.get('endpoints_standardized', False)),
                'sulcus_label_corrected': bool(row.get('sulcus_label_corrected', False)),
            }

            if len(effective) == 2 and mtype == 'distance':
                rows.append({
                    **base,
                    'landmark_role': 'line',
                    'point_index': 0,
                    'start_x': effective[0]['x'],
                    'start_y': effective[0]['y'],
                    'start_z': effective[0].get('z', np.nan),
                    'end_x':   effective[1]['x'],
                    'end_y':   effective[1]['y'],
                    'end_z':   effective[1].get('z', np.nan),
                    'x': effective[0]['x'],
                    'y': effective[0]['y'],
                    'z': effective[0].get('z', np.nan),
                })
            else:
                for i, pt in enumerate(effective):
                    rows.append({
                        **base,
                        'landmark_role': 'point',
                        'point_index': i,
                        'start_x': np.nan, 'start_y': np.nan, 'start_z': np.nan,
                        'end_x': np.nan,   'end_y': np.nan,   'end_z': np.nan,
                        'x': pt['x'],
                        'y': pt['y'],
                        'z': pt.get('z', np.nan),
                    })

    landmarks = pd.DataFrame(rows)
    if landmarks.empty:
        return landmarks

    # Stable sort for inspection / pivoting
    sort_cols = ['patientId', 'laterality', 'true_protocol', 'stepId', 'point_index', 'rater_key']
    sort_cols = [c for c in sort_cols if c in landmarks.columns]
    return landmarks.sort_values(sort_cols).reset_index(drop=True)


# ── Apply standardization to every rater, rebuild dataframes ─────────────────
print("\nApplying line standardization (endpoints + sulcus anatomical matching)...")
dataframes = {
    rk: standardize_rater_dataframe(dataframes[rk], rk)
    for rk in rater_keys
}

standardized_landmarks_df = build_standardized_landmarks_df(dataframes, rater_keys)
landmarks_out = os.path.join(project_path, 'standardized_landmarks.csv')
standardized_landmarks_df.to_csv(landmarks_out, index=False)
print(f"\nStandardized landmark table: {len(standardized_landmarks_df)} rows")
print(f"  Cases: {standardized_landmarks_df['patientId'].nunique()}")
print(f"  Raters: {standardized_landmarks_df['rater_key'].nunique()}")
print(f"  Saved to: {landmarks_out}")
display(standardized_landmarks_df.head(10))

"""### 2. Preview Annotations
Record types, true protocol coverage, and column layout per rater — a sanity check
before any statistics are computed.
"""

for rk in rater_keys:
    df = dataframes[rk]
    print(f"\n{'='*60}")
    print(f"Rater: {rk}  |  Shape: {df.shape}")
    print(f"recordType     : {df['recordType'].value_counts().to_dict()}")
    print(f"true_protocol  : {df['true_protocol'].value_counts().to_dict()}")
    display(df[df['recordType'] == 'protocol_result'].head(3))

"""---
## Part II — Clinical Value Agreement

Before trusting any single landmark click, we first ask the coarser question: do raters
agree on the **final clinical number** each protocol produces (an angle, a ratio, a
distance in mm)? This is the standard inter-rater reliability question and is answered
with ICC and Bland-Altman, exactly as it would be for any manual measurement — Z-axis
variability does not enter into it.

### 3. Build the Comparison Table, Then Measure Agreement

Builds one wide table (`comparison_df`) keyed on `patientId + laterality + true_protocol`,
with one column per rater's `resultValue`. If a rater re-ran the same case, their duplicate
rows are collapsed to the **median** value before merge so each annotator contributes at
most one measurement per case.

Reports, in order of preference:
1. **Per-protocol ICC(2,1)** across all raters jointly — the primary clinical metric.
2. **Per-protocol pairwise Pearson r** — secondary, pairwise-complete-case view.
3. **Pooled Pearson matrix** — reference only; mixes ratios, degrees, and mm across
   protocols, so it is not clinically interpretable on its own.
"""

import sys
import subprocess
from itertools import combinations

import numpy as np

try:
    import pingouin as pg
except ImportError:
    subprocess.run([sys.executable, '-m', 'pip', 'install', 'pingouin', '-q'])
    import pingouin as pg

CASE_KEY = ['patientId', 'laterality', 'true_protocol']


def extract_results(df, rater_key):
    """One protocol_result row per case per rater; median resultValue when re-run duplicates exist."""
    result_df = df[df['recordType'] == 'protocol_result'].copy()
    sub = result_df[CASE_KEY + ['resultValue', 'resultUnit']].copy()

    dup_mask = sub.duplicated(subset=CASE_KEY, keep=False)
    if dup_mask.any():
        n_dup = dup_mask.sum()
        sub = (
            sub.groupby(CASE_KEY, as_index=False)
               .agg(resultValue=('resultValue', 'median'),
                    resultUnit=('resultUnit', 'first'))
        )
        print(f"  {rater_key.split(' | ')[0]}: collapsed {n_dup} duplicate row(s) → median per case")

    return sub.rename(columns={'resultValue': f'value_{rater_key}',
                               'resultUnit':  f'unit_{rater_key}'})


# ── Wide merge: one value column per rater ───────────────────────────────────
print("Extracting protocol_result rows (one value per rater per case)...")
processed = [extract_results(dataframes[k], k) for k in rater_keys]

comparison_df = processed[0]
for nxt in processed[1:]:
    comparison_df = comparison_df.merge(nxt, on=CASE_KEY, how='outer')

value_cols = [f'value_{k}' for k in rater_keys]
comparison_df = comparison_df[comparison_df[value_cols].notna().sum(axis=1) >= 2].reset_index(drop=True)
comparison_df['mean_val'] = comparison_df[value_cols].mean(axis=1, skipna=True)
comparison_df['n_raters_present'] = comparison_df[value_cols].notna().sum(axis=1)

print(f"\nMatched records (≥2 raters present): {len(comparison_df)}")
print(f"Protocols: {sorted(comparison_df['true_protocol'].dropna().unique())}")
print(f"Raters: {[k.split(' | ')[0] for k in rater_keys]}")

print("\nRater coverage per protocol:")
coverage = comparison_df.groupby('true_protocol')[value_cols].apply(lambda g: g.notna().sum())
display(coverage)

# ── Default rater pairs for every pairwise output in this notebook ──────────
# Override e.g. RATER_PAIRS_OVERRIDE = [('alice | a@x.com', 'bob | b@x.com')]
RATER_PAIRS_OVERRIDE = None
rater_pairs = RATER_PAIRS_OVERRIDE or list(combinations(rater_keys, 2))
print(f"\nRater pairs for all pairwise outputs ({len(rater_pairs)}): {rater_pairs}")

# ── Per-protocol ICC(2,1) across ALL raters — primary clinical metric ───────
print("\nPer-protocol ICC(2,1) — two-way mixed, absolute agreement, all raters jointly:")
icc_rows = []
for protocol, grp in comparison_df.groupby('true_protocol'):
    complete = grp.dropna(subset=value_cols)
    if len(complete) < 3:
        print(f"  {protocol}: skipped (n={len(complete)} cases with all raters present)")
        continue
    long = complete.melt(
        id_vars=CASE_KEY[:2],
        value_vars=value_cols,
        var_name='rater', value_name='value'
    )
    long['subject'] = long['patientId'].astype(str) + '_' + long['laterality'].astype(str)
    long['rater']   = long['rater'].str.replace('value_', '', regex=False)
    try:
        icc_p = pg.intraclass_corr(long, targets='subject', raters='rater', ratings='value')
        icc2 = icc_p[icc_p['Type'].isin(['ICC2', 'ICC2k'])]
        if icc2.empty:
            raise ValueError(f"ICC2 row not found; types: {icc_p['Type'].tolist()}")
        row = icc2.iloc[0]
        icc_rows.append({
            'Protocol': protocol,
            'n_cases': len(complete),
            'n_raters': len(rater_keys),
            'ICC2,1': round(row['ICC'], 3),
            'CI_lower': round(row['CI95%'][0], 3),
            'CI_upper': round(row['CI95%'][1], 3),
            'p': f"{row['pval']:.3e}",
            'Interpretation': (
                'Excellent (≥0.90)' if row['ICC'] >= 0.90 else
                'Good (0.75–0.89)'  if row['ICC'] >= 0.75 else
                'Moderate (0.50–0.74)' if row['ICC'] >= 0.50 else
                'Poor (<0.50)'
            ),
        })
    except Exception as e:
        print(f"  {protocol}: ICC error — {e}")

icc_df = pd.DataFrame(icc_rows)
display(icc_df)

# ── Per-protocol pairwise Pearson r (secondary view) ─────────────────────────
print("\nPairwise Pearson r by protocol (pairwise complete cases within each protocol):")
pearson_rows = []
for protocol in sorted(comparison_df['true_protocol'].dropna().unique()):
    sub = comparison_df.loc[comparison_df['true_protocol'] == protocol, value_cols]
    for ra, rb in rater_pairs:
        pair = sub[[f'value_{ra}', f'value_{rb}']].dropna()
        if len(pair) < 3:
            continue
        r = pair[f'value_{ra}'].corr(pair[f'value_{rb}'])
        pearson_rows.append({
            'Protocol': protocol,
            'Rater A': ra.split(' | ')[0],
            'Rater B': rb.split(' | ')[0],
            'n': len(pair),
            'Pearson r': round(r, 4),
        })

pearson_df = pd.DataFrame(pearson_rows)
display(pearson_df)

# ── Pooled Pearson correlation matrix (reference only) ──────────────────────
print("\nPooled Pearson correlation matrix (reference only; use per-protocol ICC clinically):")
display(comparison_df[value_cols].corr().round(4))

"""### 4. Clinical Agreement, Visually — Bland-Altman per Protocol

**Bland-Altman is inherently pairwise** (it plots difference vs. mean for two raters),
so with N raters it is produced for every pair: $\\binom{N}{2}$ figures, each with one
row per protocol. With many raters this can be a lot of plots — restrict
`RATER_PAIRS_OVERRIDE` in Section 3 if needed.

Figures are written to `{project}/figures/` on Google Drive. Each run clears that
folder first so previous plots are overwritten by the latest analysis.
"""

import re
import shutil

import matplotlib
matplotlib.use('Agg')  # save files only — no popup windows
import matplotlib.pyplot as plt
import seaborn as sns

sns.set_theme(style='whitegrid')
plt.rcParams.update({
    'figure.dpi': 110,
    'savefig.dpi': 150,
    'axes.titlesize': 11,
    'axes.labelsize': 10,
    'xtick.labelsize': 9,
    'ytick.labelsize': 9,
    'legend.fontsize': 8,
})


def short_rater(rater_key):
    """Display name only — full email keys smash axis labels."""
    return str(rater_key).split(' | ')[0]


def slugify(text):
    """Safe filesystem name from a display string."""
    s = re.sub(r'[^a-z0-9]+', '-', str(text).strip().lower())
    return s.strip('-') or 'figure'


def prepare_figures_folder(folder):
    """Create figures/ and remove prior plot files so each run overwrites cleanly."""
    folder = Path(folder)
    if folder.exists():
        for p in folder.iterdir():
            if p.is_file():
                p.unlink()
            elif p.is_dir():
                shutil.rmtree(p)
    else:
        folder.mkdir(parents=True, exist_ok=True)
    print(f'\nFigures folder ready (cleared for this run): {folder}')


def save_figure(fig, stem):
    """Write figure PNG into the Drive figures folder; returns saved path."""
    path = figures_folder / f'{stem}.png'
    fig.savefig(path, bbox_inches='tight', facecolor='white')
    print(f'  saved {path.name}')
    return path


prepare_figures_folder(figures_folder)

# Reference ranges from MSK README per true_protocol
PROTOCOL_META = {
    'tt-tg':             {'unit': 'mm',    'normal': '<15 mm',   'borderline': '15–20 mm'},
    'insall-salvati':    {'unit': 'ratio', 'normal': '0.8–1.2',  'borderline': None},
    'patellar-tilt':     {'unit': '°',     'normal': '<10°',     'borderline': '10–20°'},
    'sulcus-angle':      {'unit': '°',     'normal': '<145°',    'borderline': None},
    'sulcus-angle-3cm':  {'unit': '°',     'normal': '<145°',    'borderline': None},
    'caton-deschamps':   {'unit': 'ratio', 'normal': '0.6–1.3',  'borderline': None},
}

protocols = sorted(comparison_df['true_protocol'].dropna().unique())

# One figure per rater-pair × protocol (2 panels). A single 6×2 mega-figure
# compresses on screen and causes title / label / legend collisions.
for ra, rb in rater_pairs:
    pair_df = comparison_df.dropna(subset=[f'value_{ra}', f'value_{rb}']).copy()
    if pair_df.empty:
        print(f"\nNo overlapping cases for pair ({ra}, {rb}) — skipping.")
        continue
    pair_df['diff'] = pair_df[f'value_{ra}'] - pair_df[f'value_{rb}']
    ra_s, rb_s = short_rater(ra), short_rater(rb)

    for protocol in protocols:
        sub = pair_df[pair_df['true_protocol'] == protocol]
        if sub.empty:
            continue

        diff = sub['diff']
        mean = sub[[f'value_{ra}', f'value_{rb}']].mean(axis=1)
        md_, sd_ = diff.mean(), diff.std()
        meta = PROTOCOL_META.get(protocol, {})
        unit = meta.get('unit', '')
        ref_bits = []
        if meta.get('normal'):
            ref_bits.append(f"normal {meta['normal']}")
        if meta.get('borderline'):
            ref_bits.append(f"borderline {meta['borderline']}")
        ref_line = ' · '.join(ref_bits)

        fig, (ax_hist, ax_ba) = plt.subplots(
            1, 2, figsize=(12, 4.8), constrained_layout=True
        )
        fig.suptitle(
            f'{ra_s} vs {rb_s}  —  {protocol}'
            + (f'  ({ref_line})' if ref_line else ''),
            fontsize=12,
        )

        sns.histplot(diff, kde=True, ax=ax_hist, color='steelblue')
        ax_hist.axvline(0, color='red', linestyle='--', linewidth=1.5)
        ax_hist.set_title(f'Difference distribution [{unit}]')
        ax_hist.set_xlabel(f'{ra_s} − {rb_s}')
        ax_hist.set_ylabel('Count')

        ax_ba.scatter(mean, diff, alpha=0.6, color='steelblue', s=28)
        for level, label, ls, color in [
            (md_,              f'Bias: {md_:.3f}',               '--', 'red'),
            (md_ + 1.96 * sd_, f'+1.96 SD: {md_+1.96*sd_:.3f}', ':',  'gray'),
            (md_ - 1.96 * sd_, f'−1.96 SD: {md_-1.96*sd_:.3f}', ':',  'gray'),
        ]:
            ax_ba.axhline(level, linestyle=ls, color=color, label=label)
        ax_ba.set_title(f'Bland–Altman  (n={len(sub)})')
        ax_ba.set_xlabel(f'Mean of {ra_s} & {rb_s}')
        ax_ba.set_ylabel(f'{ra_s} − {rb_s}  [{unit}]')
        # Keep legend inside plot area so constrained_layout does not clip it
        ax_ba.legend(loc='best', framealpha=0.92)

        save_figure(
            fig,
            f'bland-altman__{slugify(ra_s)}__vs__{slugify(rb_s)}__{slugify(protocol)}',
        )
        plt.close(fig)

"""### 5. Bias Summary — Pooled Bland-Altman Statistics

The numeric counterpart to Section 4: bias and 95% limits-of-agreement (LoA) per
`true_protocol`, computed per rater pair and then pooled. Ratios (CDI, IS) have
`resultUnit = NaN` — handled correctly via `PROTOCOL_META`. Pairs with a large bias
relative to LoA width are flagged as a likely systematic rater offset rather than
random noise.
"""

summary_rows = []
for ra, rb in rater_pairs:
    pair_df = comparison_df.dropna(subset=[f'value_{ra}', f'value_{rb}']).copy()
    if pair_df.empty:
        continue
    pair_df['diff'] = pair_df[f'value_{ra}'] - pair_df[f'value_{rb}']
    for protocol, grp in pair_df.groupby('true_protocol'):
        d    = grp['diff']
        meta = PROTOCOL_META.get(protocol, {})
        summary_rows.append({
            'Protocol':   protocol,
            'Rater pair': f"{ra} vs {rb}",
            'Unit':       meta.get('unit', ''),
            'n':          len(grp),
            'Bias':       round(d.mean(), 4),
            'SD':         round(d.std(),  4),
            'LoA_lower':  round(d.mean() - 1.96 * d.std(), 4),
            'LoA_upper':  round(d.mean() + 1.96 * d.std(), 4),
            'LoA_width':  round(1.96 * 2 * d.std(), 4),
        })

summary_df = pd.DataFrame(summary_rows)
print("Bland-Altman Statistics by True Protocol and Rater Pair:")
display(summary_df)

for _, row in summary_df.iterrows():
    if abs(row['Bias']) > abs(row['LoA_width']) * 0.3:
        print(f"⚠  {row['Protocol']} ({row['Rater pair']}): large bias ({row['Bias']:.3f}) "
              f"relative to LoA width — check for systematic rater offset.")

# ── Pooled (protocol-level only, all pairs combined) ──────────────────────────
print("\nPooled across all rater pairs:")
display(summary_df.groupby('Protocol').agg(
    n_pairs=('Rater pair', 'nunique'),
    mean_abs_bias=('Bias', lambda s: s.abs().mean()),
    mean_LoA_width=('LoA_width', 'mean'),
).round(4).reset_index())

"""---
## Part III — Planar Landmark Agreement

Clinical-value agreement (Part II) tells us whether the *final number* is reproducible,
but a protocol can produce a stable angle from two raters who clicked in noticeably
different places if their errors happen to cancel out geometrically. This part asks the
finer-grained question directly: how consistent are the raw **(x, y) landmark clicks**
themselves, in the imaging plane?

**Scope note — planar only.** Every landmark in `stepPointsMmJson` also carries a `z`
(slice index) in `pointsJson`, but Z is not analyzed anywhere in this notebook. A rater's
slice choice is accepted as-is; only the in-plane (x, y) position is scored. This is a
deliberate simplification, not an oversight — it isolates "did they click the same spot
on the slice they chose" from "did they choose the same slice," which is a separate
question this version does not address.

**Key implementation facts (verified against real export):**
- **v4:** all `step_measurement` rows are endpoint-standardized and sulcus condyle
  lines are anatomically relabeled (Section 1.5) *before* any planar statistics.
- Merge key: `patientId + laterality + true_protocol + stepId` — not just `stepId`,
  because `condyle-line` appears in both `tt-tg` and `patellar-tilt`, and `lateral-line` /
  `medial-line` appear in both `sulcus-angle` and `sulcus-angle-3cm`.
- `pointCount = 3` for `distance` type: pt[0], pt[1] are the annotated endpoints;
  pt[2] is the foot-of-perpendicular auto-computed by the app (~0.2 mm from pt[1]).
  **Only pt[0] and pt[1] are used for planar error.**
- `pointCount = 2` for `perpendicular` type (trochlear-groove, tibial-tubercle):
  pt[0] = anchor on reference line, pt[1] = landmark. Both points included.
- `pointCount = 1` for `joint-line` (sagittal point, sulcus-angle-3cm only): a single
  point has no pairing partner for a planar-distance calculation and is excluded here.
- Coordinates in `stepPointsMmJson` are in **physical mm**, within the slice plane.
- With N raters, every step is compared across all $\\binom{N}{2}$ pairs, then pooled.

### 6. Planar Coordinate Variability and ICC

Two complementary views of the same question:
1. **Pairwise planar distance** (mm) between matched landmarks, per step — concrete and
   interpretable in millimetres, pooled across all rater pairs.
2. **Planar ICC** on the (x, y) magnitude — a single reliability coefficient per the
   usual ICC convention, computed on the balanced subset of landmarks every rater
   annotated.

Landmarks are matched between raters by the Hungarian algorithm (minimum-cost bipartite
matching on Euclidean XY distance) rather than by click order, since raters need not
click points in the same sequence. After Section 1.5 standardization, sulcus condyle
lines and line directions are already aligned — Hungarian matching remains useful for
perpendicular anchor points and any residual ordering ambiguity.
"""

from scipy.optimize import linear_sum_assignment


def parse_points(val):
    """Alias for Section 1.5 parser (used throughout Part III)."""
    return parse_points_json(val)


def effective_points(pts, point_count, meas_type):
    """Planar points actually used for comparison (drops the auto-computed foot-of-perpendicular)."""
    return pts[:2] if (meas_type == 'distance' and len(pts) == 3) else pts


def match_points_xy(pts_a, pts_b):
    """
    Pair two point sets by minimizing total Euclidean XY distance (Hungarian algorithm),
    so comparisons are robust to raters clicking landmarks in a different order.
    """
    n = len(pts_a)
    if n == 0 or n != len(pts_b):
        return pts_b

    a_xy = np.array([[p['x'], p['y']] for p in pts_a])
    b_xy = np.array([[p['x'], p['y']] for p in pts_b])

    cost_matrix = np.linalg.norm(a_xy[:, np.newaxis, :] - b_xy[np.newaxis, :, :], axis=2)
    row_ind, col_ind = linear_sum_assignment(cost_matrix)
    return [pts_b[i] for i in col_ind]


# ── Build per-rater step_measurement frames ──────────────────────────────────
step_cols = ['patientId', 'laterality', 'true_protocol', 'stepId', 'stepLabel',
             'plane', 'sliceIndex', 'measurementType', 'pointCount',
             'stepPointsMmJson', 'pointsJson']
step_frames = {
    rk: dataframes[rk][dataframes[rk]['recordType'] == 'step_measurement'][step_cols].copy()
    for rk in rater_keys
}
STEP_MERGE_KEYS = ['patientId', 'laterality', 'true_protocol', 'stepId']


def planar_distance_for_pair(ra, rb):
    """Per-landmark planar (XY) distance between two raters, for every shared step."""
    merged = step_frames[ra].merge(step_frames[rb], on=STEP_MERGE_KEYS, suffixes=('_a', '_b'))
    rows = []
    for _, row in merged.iterrows():
        mtype, pc = row['measurementType_a'], row['pointCount_a']
        if pc == 1:
            continue  # single-point steps have no planar pairing partner

        pts_a = effective_points(parse_points(row['stepPointsMmJson_a']), pc, mtype)
        pts_b = effective_points(parse_points(row['stepPointsMmJson_b']), pc, mtype)
        if not pts_a or not pts_b or len(pts_a) != len(pts_b):
            continue

        pts_b_matched = match_points_xy(pts_a, pts_b)
        for i, (p_a, p_b) in enumerate(zip(pts_a, pts_b_matched)):
            dist = np.linalg.norm([p_a['x'] - p_b['x'], p_a['y'] - p_b['y']])
            rows.append({
                'rater_a': ra, 'rater_b': rb,
                'patientId': row['patientId'], 'true_protocol': row['true_protocol'],
                'stepId': row['stepId'], 'stepLabel': row['stepLabel_a'],
                'pointIndex': i, 'dist_mm': dist,
            })
    return pd.DataFrame(rows)


pairwise_planar_dfs = {(ra, rb): planar_distance_for_pair(ra, rb) for ra, rb in rater_pairs}
planar_variability_df = (
    pd.concat(pairwise_planar_dfs.values(), ignore_index=True)
    if pairwise_planar_dfs else pd.DataFrame()
)

print("Planar coordinate variability (Hungarian-matched landmarks, all rater pairs pooled):")
if not planar_variability_df.empty:
    display(planar_variability_df.groupby('stepId')['dist_mm'].agg(['mean', 'std', 'max']).round(2))
    n_steps = planar_variability_df['stepId'].nunique()
    fig_w = max(12, 0.85 * n_steps + 3)
    fig, ax = plt.subplots(figsize=(fig_w, 6.5), constrained_layout=True)
    sns.barplot(
        data=planar_variability_df, x='stepId', y='dist_mm',
        errorbar='sd', ax=ax, color='steelblue',
    )
    ax.set_xticks(ax.get_xticks())
    ax.set_xticklabels(ax.get_xticklabels(), rotation=40, ha='right', rotation_mode='anchor')
    ax.set_title('Planar Coordinate Variability by Step (Hungarian-Matched)')
    ax.set_xlabel('Step')
    ax.set_ylabel('Planar Distance Error (mm)')
    save_figure(fig, 'planar-variability-by-step')
    plt.close(fig)
else:
    print('No overlapping data.')

# ── Planar ICC on the balanced (all-raters-present) subset ─────────────────
planar_icc_records = []
for rk in rater_keys:
    df = step_frames[rk]
    for _, row in df.iterrows():
        pts = effective_points(parse_points(row['stepPointsMmJson']), row['pointCount'], row['measurementType'])
        if not pts:
            continue
        for i, pt in enumerate(pts):
            planar_icc_records.append({
                'subject': f"{row['patientId']}_{row['laterality']}_{row['true_protocol']}_{row['stepId']}_pt{i}",
                'rater': rk.split(' | ')[0],
                'pos_magnitude': np.sqrt(pt['x'] ** 2 + pt['y'] ** 2),
            })

planar_long_df = pd.DataFrame(planar_icc_records)
# Collapse duplicate runs within the same rater/subject to one value (median) before pivoting.
planar_long_df = planar_long_df.groupby(['subject', 'rater'], as_index=False)['pos_magnitude'].median()

# Balanced subset: landmarks annotated by every rater.
planar_pivot_df = planar_long_df.pivot(index='subject', columns='rater', values='pos_magnitude').dropna()

if not planar_pivot_df.empty:
    print(f"\nPlanar ICC on a balanced subset of {len(planar_pivot_df)} landmark points "
          f"(all {len(rater_keys)} raters present):")

    balanced_long = planar_pivot_df.reset_index().melt(id_vars='subject', value_name='pos_magnitude')

    try:
        planar_icc_results = pg.intraclass_corr(
            data=balanced_long, targets='subject', raters='rater', ratings='pos_magnitude'
        )
        display(planar_icc_results)

        # Pingouin labels absolute agreement as 'ICC2' / 'ICC(A,1)' depending on version.
        agreement_row = planar_icc_results[
            planar_icc_results['Type'].str.contains(r'ICC\(A,1\)|ICC2', regex=True)
        ]
        consistency_row = planar_icc_results[
            planar_icc_results['Type'].str.contains(r'ICC\(C,1\)|ICC3', regex=True)
        ]

        if not agreement_row.empty:
            print(f"\nOverall Planar ICC (Absolute Agreement): {agreement_row['ICC'].values[0]:.3f}")
        if not consistency_row.empty:
            print(f"Overall Planar ICC (Consistency):        {consistency_row['ICC'].values[0]:.3f}")
        if agreement_row.empty and consistency_row.empty:
            print("Could not isolate a specific ICC type from the results table above.")
        else:
            print("\nInterpretation: agreement on (x, y) landmark position alone, by construction "
                  "blind to which slice (Z) the rater chose.")
    except Exception as e:
        print(f"Error calculating planar ICC on the balanced subset: {e}")
else:
    print("\nNo landmarks were found that all raters annotated — cannot compute a balanced planar ICC.")

"""### 7. Outlier Triage — Largest Planar Disagreements

Surfaces the specific landmarks with the largest planar error, so they can be reviewed
manually (mislabeled laterality, wrong anatomical structure, genuine ambiguity, etc.).
This is purely descriptive — it does not feed back into the ICC or summary statistics
above.
"""

PLANAR_OUTLIER_THRESHOLD_MM = 100

extreme_outliers = planar_variability_df[
    planar_variability_df['dist_mm'] > PLANAR_OUTLIER_THRESHOLD_MM
].copy()

if not extreme_outliers.empty:
    print(f"Found {len(extreme_outliers)} landmarks with planar error > {PLANAR_OUTLIER_THRESHOLD_MM} mm.")
    outlier_summary = extreme_outliers.sort_values('dist_mm', ascending=False).head(20)
    display(outlier_summary)

    n_steps = extreme_outliers['stepId'].nunique()
    fig_w = max(10, 0.9 * n_steps + 3)
    fig, ax = plt.subplots(figsize=(fig_w, 5.5), constrained_layout=True)
    sns.stripplot(
        data=extreme_outliers, x='stepId', y='dist_mm',
        hue='stepId', legend=False, ax=ax, size=6, jitter=0.25,
    )
    ax.set_xticks(ax.get_xticks())
    ax.set_xticklabels(ax.get_xticklabels(), rotation=40, ha='right', rotation_mode='anchor')
    ax.set_title(f'Outlier Landmarks (planar error > {PLANAR_OUTLIER_THRESHOLD_MM} mm)')
    ax.set_xlabel('Step')
    ax.set_ylabel('Planar Distance Error (mm)')
    save_figure(fig, 'planar-outliers-by-step')
    plt.close(fig)
else:
    print(f"No extreme outliers (> {PLANAR_OUTLIER_THRESHOLD_MM} mm) found in the current matching set.")

"""---
## Part IV — Ground Truth and Readiness

### 8. ML Ground Truth — Averaged Clinical Values

Averages **all raters'** clinical measurements (row-wise mean, ignoring missing raters)
into a single ground-truth label per case, weighted by that protocol's ICC from Part II.
This label is the clinical scalar (angle/ratio/mm) the protocol ultimately produces —
no per-landmark coordinates or Z information are involved, so it carries over unchanged
from a Z-aware version of this notebook.
"""

if comparison_df.empty:
    print("comparison_df is empty — run Section 3 first.")
else:
    ml_data = comparison_df.copy()
    ml_data['ground_truth'] = ml_data[value_cols].mean(axis=1, skipna=True)
    ml_data['ground_truth_std'] = ml_data[value_cols].std(axis=1, skipna=True)

    if not icc_df.empty:
        icc_map = icc_df.set_index('Protocol')['ICC2,1'].to_dict()
        ml_data['gt_icc_weight'] = ml_data['true_protocol'].map(icc_map).fillna(1.0)
    else:
        ml_data['gt_icc_weight'] = 1.0

    output_file = os.path.join(project_path, 'ml_ready_annotations.csv')
    ml_data.to_csv(output_file, index=False)

    display(ml_data[['patientId', 'laterality', 'true_protocol', 'n_raters_present',
                      'ground_truth', 'ground_truth_std', 'gt_icc_weight']].head())
    print(f"\nSaved to: {output_file}")
    print(f"Cases with all {len(rater_keys)} raters present: "
          f"{(ml_data['n_raters_present'] == len(rater_keys)).sum()} / {len(ml_data)}")

"""### 9. Annotation Versioning and Duplicate-Run Checks

The README flags a production gap: neither CSV export includes `annotationVersion`,
`correctionOf`, or `modelVersion`. This section detects missing columns and flags
potential unversioned duplicate annotations, across all raters.
"""

RECOMMENDED_COLS = ['annotationVersion', 'correctionOf', 'modelVersion']
versioning_report = []
for rk in rater_keys:
    df = dataframes[rk]
    missing = [c for c in RECOMMENDED_COLS if c not in df.columns]
    present = [c for c in RECOMMENDED_COLS if c in df.columns]
    versioning_report.append({
        'Rater': rk,
        'Present': ', '.join(present) or 'none',
        'Missing': ', '.join(missing),
    })
display(pd.DataFrame(versioning_report))
if any(r['Missing'] for r in versioning_report):
    print("\n⚠  Add to sessionAnnotationCsv.ts and protocolMeasurementCsv.ts:")
    print("   annotationVersion : int, monotonically increasing")
    print("   correctionOf      : UUID of previous annotationId")
    print("   modelVersion      : model version that pre-populated this annotation")

# Duplicate detection: same patientId + laterality + true_protocol within ONE rater
print("\nChecking for duplicate protocol runs (same patient + laterality + true_protocol, within rater)...")
for rk in rater_keys:
    res = dataframes[rk][dataframes[rk]['recordType'] == 'protocol_result']
    dups = res.duplicated(subset=['patientId', 'laterality', 'true_protocol'], keep=False)
    n = dups.sum()
    print(f"  {rk}: {n} duplicate runs" + (" ← may be revised annotations" if n else " ✓"))
    if n:
        display(res[dups][['patientId', 'laterality', 'true_protocol', 'groupId', 'resultValue']]
                .sort_values('true_protocol').head(8))

# Timestamp check
print("\nTimestamp ranges:")
for rk in rater_keys:
    df = dataframes[rk]
    if 'timestamp' in df.columns:
        ts = pd.to_datetime(df['timestamp'], errors='coerce')
        print(f"  {rk}: {ts.min()} → {ts.max()}  ({ts.isna().sum()} unparseable)")
    else:
        print(f"  {rk}: no timestamp column")

# ── Self-consistency: foot-of-perpendicular check (per rater) ────────────────
# pt[2] for 3-point 'distance' steps is auto-computed by the app and should sit
# almost exactly on pt[1]; large deviations indicate an export inconsistency.
redundancy_checks = []
for rk in rater_keys:
    step = dataframes[rk][dataframes[rk]['recordType'] == 'step_measurement']
    for _, row in step[step['pointCount'] == 3].iterrows():
        pts = parse_points(row['stepPointsMmJson'])
        if len(pts) == 3:
            d12 = np.linalg.norm([pts[1]['x'] - pts[2]['x'], pts[1]['y'] - pts[2]['y']])
            redundancy_checks.append({
                'rater': rk, 'stepId': row['stepId'], 'dist_pt1_pt2_mm': d12
            })

redundancy_df = pd.DataFrame(redundancy_checks)
print("\nFoot-of-perpendicular check (expect dist ≈ 0), all raters:")
display(redundancy_df.groupby(['stepId'])['dist_pt1_pt2_mm'].describe().round(4))
large = redundancy_df[redundancy_df['dist_pt1_pt2_mm'] > 1.0]
if len(large):
    print(f"\n⚠ {len(large)} rows with pt[1]–pt[2] > 1 mm — possible export inconsistency:")
    display(large)
else:
    print("\n✓ All pt[1]–pt[2] distances ≤ 1 mm, across all raters.")

"""### 10. Per-Protocol ML Readiness Summary

Counts per `true_protocol` (from `groupId`), summed across **all raters** — the only way
to correctly separate `sulcus-angle` from `sulcus-angle-3cm`, and to credit every
annotator's contribution regardless of how many files they exported.
"""

PROTOCOL_DEFS = {
    'tt-tg':            {'plane': 'axial',    'n_landmarks': 3, 'min_studies': 300},
    'insall-salvati':   {'plane': 'sagittal', 'n_landmarks': 2, 'min_studies': 300},
    'patellar-tilt':    {'plane': 'axial',    'n_landmarks': 2, 'min_studies': 300},
    'sulcus-angle':     {'plane': 'axial',    'n_landmarks': 2, 'min_studies': 300},
    'sulcus-angle-3cm': {'plane': 'axial',    'n_landmarks': 3, 'min_studies': 500,
                         'note': 'cross-plane; joint-line on sagittal + 2 lines on axial'},
    'caton-deschamps':  {'plane': 'sagittal', 'n_landmarks': 2, 'min_studies': 500,
                         'note': 'hardest; articular cartilage boundary'},
}

readiness_rows = []
for rk in rater_keys:
    df   = dataframes[rk]
    res  = df[df['recordType'] == 'protocol_result']
    step = df[df['recordType'] == 'step_measurement']
    for proto_id, info in PROTOCOL_DEFS.items():
        grp      = res[res['true_protocol'] == proto_id]
        step_grp = step[step['true_protocol'] == proto_id]
        n_studies = grp['patientId'].nunique()
        n_sides   = len(grp)
        n_slices  = step_grp['sliceIndex'].nunique() if 'sliceIndex' in step_grp.columns else 0
        status    = ('✓ Feasibility' if n_studies >= 100 else
                     '⚠ Pre-feasibility' if n_studies >= 50 else
                     '✗ Insufficient')
        readiness_rows.append({
            'Protocol':         proto_id,
            'Plane':            info['plane'],
            'Rater':            rk,
            'Unique patients':  n_studies,
            'Sides annotated':  n_sides,
            'Unique slices':    n_slices,
            'Unique steps':     step_grp['stepId'].nunique(),
            'Min target':       info['min_studies'],
            'Status':           status,
            'Notes':            info.get('note', ''),
        })

readiness_df = pd.DataFrame(readiness_rows)
print(f"Per-Protocol ML Readiness across {len(rater_keys)} rater(s) (true_protocol from groupId):")
display(readiness_df)

readiness_agg = (
    readiness_df.groupby('Protocol')['Unique patients']
    .sum().reset_index()
    .rename(columns={'Unique patients': 'Total patients (all raters)'})
)
readiness_agg['Status'] = readiness_agg['Total patients (all raters)'].apply(
    lambda n: '✓ Feasibility' if n >= 100 else ('⚠ Pre-feasibility' if n >= 50 else '✗ Insufficient')
)
print(f"\nCombined across all {len(rater_keys)} rater(s):")
display(readiness_agg)
