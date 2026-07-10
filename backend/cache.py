import sqlite3
import json
import os
from datetime import datetime, timedelta
from typing import Optional, Dict, Any, List

DB_PATH = os.path.join(os.path.dirname(__file__), "github_cache.db")
CACHE_EXPIRATION_HOURS = 24

def get_db_connection():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    """Initializes the SQLite database tables if they do not exist."""
    conn = get_db_connection()
    cursor = conn.cursor()
    
    # Profile Cache Table
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS profiles (
            username TEXT PRIMARY KEY,
            data_json TEXT NOT NULL,
            cached_at TEXT NOT NULL
        )
    """)
    
    # Repositories Cache Table
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS repositories (
            username TEXT,
            repo_name TEXT,
            data_json TEXT NOT NULL,
            cached_at TEXT NOT NULL,
            PRIMARY KEY (username, repo_name)
        )
    """)
    
    conn.commit()
    conn.close()

def is_expired(cached_time_str: str) -> bool:
    """Checks if the cached data has expired."""
    try:
        cached_time = datetime.fromisoformat(cached_time_str)
        return datetime.now() - cached_time > timedelta(hours=CACHE_EXPIRATION_HOURS)
    except Exception:
        return True

def get_cached_profile(username: str) -> Optional[Dict[str, Any]]:
    """Retrieves the cached profile if it exists and is not expired."""
    username = username.lower().strip()
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT data_json, cached_at FROM profiles WHERE username = ?", (username,))
    row = cursor.fetchone()
    conn.close()
    
    if row and not is_expired(row["cached_at"]):
        return json.loads(row["data_json"])
    return None

def set_cached_profile(username: str, profile_data: Dict[str, Any]):
    """Caches profile data."""
    username = username.lower().strip()
    conn = get_db_connection()
    cursor = conn.cursor()
    now_str = datetime.now().isoformat()
    cursor.execute(
        "INSERT OR REPLACE INTO profiles (username, data_json, cached_at) VALUES (?, ?, ?)",
        (username, json.dumps(profile_data), now_str)
    )
    conn.commit()
    conn.close()

def get_cached_repos(username: str) -> Optional[List[Dict[str, Any]]]:
    """Retrieves cached repository data for a user if it exists and is not expired."""
    username = username.lower().strip()
    conn = get_db_connection()
    cursor = conn.cursor()
    
    # Check if there is any repo and if it's expired by checking the first match
    cursor.execute("SELECT data_json, cached_at FROM repositories WHERE username = ? LIMIT 1", (username,))
    first_row = cursor.fetchone()
    
    if not first_row or is_expired(first_row["cached_at"]):
        conn.close()
        return None
        
    cursor.execute("SELECT data_json FROM repositories WHERE username = ?", (username,))
    rows = cursor.fetchall()
    conn.close()
    
    return [json.loads(row["data_json"]) for row in rows]

def set_cached_repos(username: str, repos_data: List[Dict[str, Any]]):
    """Caches a list of repositories for a user."""
    username = username.lower().strip()
    conn = get_db_connection()
    cursor = conn.cursor()
    now_str = datetime.now().isoformat()
    
    # Clear old entries first
    cursor.execute("DELETE FROM repositories WHERE username = ?", (username,))
    
    for repo in repos_data:
        repo_name = repo.get("name", "")
        cursor.execute(
            "INSERT OR REPLACE INTO repositories (username, repo_name, data_json, cached_at) VALUES (?, ?, ?, ?)",
            (username, repo_name, json.dumps(repo), now_str)
        )
    conn.commit()
    conn.close()

def clear_cache(username: str):
    """Clears cache for a given user."""
    username = username.lower().strip()
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("DELETE FROM profiles WHERE username = ?", (username,))
    cursor.execute("DELETE FROM repositories WHERE username = ?", (username,))
    conn.commit()
    conn.close()

# Initialize on import
init_db()
