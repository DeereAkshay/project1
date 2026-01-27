
import csv
import math
from io import StringIO
from pathlib import Path
from typing import Any, Dict, List

import numpy as np
import pandas as pd
from fastapi import FastAPI, Query, HTTPException
from fastapi.responses import HTMLResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from starlette.requests import Request


# ---------------------------------------------------
# PATHS
# ---------------------------------------------------
BASE_DIR = Path(__file__).resolve().parent
TEMPLATE_DIR = BASE_DIR / "template"
STATIC_DIR = BASE_DIR / "static"
DATA_DIR = BASE_DIR / "data"

CSV_PATH = DATA_DIR / "company_data.csv"
XLSX_PATH = DATA_DIR / "company_data.xlsx"

app = FastAPI(title="Dataset Explorer (CSV/Excel Search + Export)")

app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")
templates = Jinja2Templates(directory=str(TEMPLATE_DIR))

# ---------------------------------------------------
# DATA CACHE
# ---------------------------------------------------
_df_cache = {"mtime": None, "path": None, "df": None}


def _normalize_columns(df: pd.DataFrame) -> pd.DataFrame:
    df.columns = [str(c).strip() for c in df.columns]
    return df


def load_data() -> pd.DataFrame:
    """Load CSV (preferred) or XLSX with caching by file modified time."""
    if CSV_PATH.exists():
        path = CSV_PATH
    elif XLSX_PATH.exists():
        path = XLSX_PATH
    else:
        raise FileNotFoundError(
            f"No dataset found. Put file in {DATA_DIR} as company_data.csv or company_data.xlsx"
        )

    mtime = path.stat().st_mtime
    if _df_cache["df"] is None or _df_cache["mtime"] != mtime or _df_cache["path"] != str(path):
        if path.suffix.lower() == ".csv":
            try:
                df = pd.read_csv(path, encoding="utf-8", low_memory=False)
            except UnicodeDecodeError:
                df = pd.read_csv(path, encoding="latin1", low_memory=False)
        else:
            df = pd.read_excel(path, engine="openpyxl")

        df = _normalize_columns(df)
        _df_cache["df"] = df
        _df_cache["mtime"] = mtime
        _df_cache["path"] = str(path)

    return _df_cache["df"]


# ---------------------------------------------------
# SAFE CONTAINS (handles duplicate column names too)
# ---------------------------------------------------
def safe_contains_any(obj, text: str) -> pd.Series:
    t = str(text).lower()

    # if df[col] returns DataFrame (duplicate header), OR across all of them
    if isinstance(obj, pd.DataFrame):
        mask_df = obj.astype(str).apply(lambda s: s.str.lower().str.contains(t, na=False))
        return mask_df.any(axis=1)

    return obj.astype(str).str.lower().str.contains(t, na=False)


# ---------------------------------------------------
# JSON SANITIZER (fix for NaN / Inf / numpy types)
# ---------------------------------------------------
def _json_safe_value(v: Any) -> Any:
    """Convert values to JSON-safe types (NaN/Inf -> None, numpy scalars -> python scalars)."""
    if v is None:
        return None

    # pandas NA / numpy nan
    try:
        if pd.isna(v):
            return None
    except Exception:
        pass

    # Python float nan/inf
    if isinstance(v, float):
        if math.isnan(v) or math.isinf(v):
            return None
        return v

    # numpy float/int
    if isinstance(v, (np.floating, np.integer)):
        vv = v.item()
        if isinstance(vv, float) and (math.isnan(vv) or math.isinf(vv)):
            return None
        return vv

    # timestamps -> string
    if isinstance(v, (pd.Timestamp, np.datetime64)):
        try:
            return pd.to_datetime(v).isoformat()
        except Exception:
            return str(v)

    return v


def df_to_json_safe(df: pd.DataFrame) -> (List[str], List[Dict[str, Any]]):
    """
    Convert DF -> (columns, rows) where rows are JSON-safe dicts.
    This guarantees no NaN/Inf remains.
    """
    if df is None or df.empty:
        return [], []

    # Force object dtype so None can exist even for float columns
    cleaned = df.replace([np.inf, -np.inf], np.nan).astype(object)
    cleaned = cleaned.where(pd.notnull(cleaned), None)

    # Convert to dict and then sanitize values recursively
    records = cleaned.to_dict(orient="records")
    safe_records = []
    for r in records:
        safe_records.append({k: _json_safe_value(v) for k, v in r.items()})

    return cleaned.columns.tolist(), safe_records


# ---------------------------------------------------
# UI ROUTE
# ---------------------------------------------------
@app.get("/", response_class=HTMLResponse)
def home(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})


@app.get("/health")
def health():
    df = load_data()
    return {
        "status": "ok",
        "rows": len(df),
        "columns": df.columns.tolist(),
        "file": _df_cache["path"],
    }


# ---------------------------------------------------
# SEARCH: MACHINE
# ---------------------------------------------------
@app.get("/api/search/machine")
def search_machine(
    machine_id: str = Query(...),
    limit: int = Query(50, ge=1, le=500),
):
    df = load_data()

    if "native_pin" not in df.columns:
        raise HTTPException(400, "Column 'native_pin' not found in dataset.")

    mid = machine_id.strip()

    # exact match first
    mask = df["native_pin"].astype(str).str.strip().eq(mid)
    if int(mask.sum()) == 0:
        mask = safe_contains_any(df["native_pin"], mid)

    out = df.loc[mask].head(limit)
    cols, rows = df_to_json_safe(out)

    return {
        "query": mid,
        "matched_rows": int(mask.sum()),
        "returned_rows": len(out),
        "columns": cols,
        "rows": rows,
    }


# ---------------------------------------------------
# SEARCH: LOCATION (Country/State/City)
# ---------------------------------------------------
@app.get("/api/search/location")
def search_location(
    q: str = Query(...),
    limit: int = Query(50, ge=1, le=500),
):
    df = load_data()
    query = q.strip()

    # Detect Country/State/City case-insensitively (your CSV has these exact)
    cols_lower = {c.lower(): c for c in df.columns}
    country_col = cols_lower.get("country")
    state_col = cols_lower.get("state")
    city_col = cols_lower.get("city")

    cols = [c for c in [country_col, state_col, city_col] if c is not None]
    if not cols:
        raise HTTPException(400, "Country/State/City columns not found in dataset.")

    mask = None
    for col in cols:
        m = safe_contains_any(df[col], query)
        mask = m if mask is None else (mask | m)

    out = df.loc[mask].head(limit)
    cols_out, rows_out = df_to_json_safe(out)

    return {
        "query": q,
        "matched_rows": int(mask.sum()),
        "returned_rows": len(out),
        "columns": cols_out,
        "rows": rows_out,
    }


# ---------------------------------------------------
# CSV STREAM HELPER
# ---------------------------------------------------
def stream_df_as_csv(df: pd.DataFrame, filename: str):
    def generate():
        buffer = StringIO()
        writer = csv.writer(buffer)

        writer.writerow(df.columns.tolist())
        yield buffer.getvalue()
        buffer.seek(0)
        buffer.truncate(0)

        # Optional: replace inf/-inf with blank and NaN with blank in export
        df2 = df.replace([np.inf, -np.inf], np.nan)

        for row in df2.itertuples(index=False, name=None):
            # Convert nan -> "" for nicer CSV
            row_out = [("" if (isinstance(v, float) and (math.isnan(v) or math.isinf(v))) else v) for v in row]
            writer.writerow(row_out)
            yield buffer.getvalue()
            buffer.seek(0)
            buffer.truncate(0)

    headers = {"Content-Disposition": f'attachment; filename="{filename}"'}
    return StreamingResponse(generate(), media_type="text/csv", headers=headers)


# ---------------------------------------------------
# EXPORT ALL MATCHED (Machine + Location)
# ---------------------------------------------------
@app.get("/api/export/machine")
def export_machine(machine_id: str = Query(...)):
    df = load_data()

    if "native_pin" not in df.columns:
        raise HTTPException(400, "Column 'native_pin' not found in dataset.")

    mid = machine_id.strip()

    mask = df["native_pin"].astype(str).str.strip().eq(mid)
    if int(mask.sum()) == 0:
        mask = safe_contains_any(df["native_pin"], mid)

    out_df = df.loc[mask]
    filename = f"machine_{mid}_matched_{len(out_df)}.csv".replace(" ", "_")
    return stream_df_as_csv(out_df, filename)


@app.get("/api/export/location")
def export_location(q: str = Query(...)):
    df = load_data()
    query = q.strip()

    cols_lower = {c.lower(): c for c in df.columns}
    country_col = cols_lower.get("country")
    state_col = cols_lower.get("state")
    city_col = cols_lower.get("city")

    cols = [c for c in [country_col, state_col, city_col] if c is not None]
    if not cols:
        raise HTTPException(400, "Country/State/City columns not found in dataset.")

    mask = None
    for col in cols:
        m = safe_contains_any(df[col], query)
        mask = m if mask is None else (mask | m)

    out_df = df.loc[mask]
    filename = f"location_{q}_matched_{len(out_df)}.csv".replace(" ", "_")
    return stream_df_as_csv(out_df, filename)
