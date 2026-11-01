import os
import sys
import re
import uuid
import socket
import sqlite3
import shutil
import urllib.parse
import subprocess
import threading
import atexit
from datetime import datetime
from typing import List, Dict, Any, Optional

# Ensure UTF-8 stdout/stderr on Windows consoles to support Russian and emojis
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

# Global state for Cloudflare Tunnel
TUNNEL_URL = None
TUNNEL_PROCESS = None

import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, UploadFile, File, Form, HTTPException, Header, Query
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware

# Setup directories
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
UPLOADS_DIR = os.path.join(BASE_DIR, "uploads")
DATA_DIR = os.path.join(BASE_DIR, "data")
STATIC_DIR = os.path.join(BASE_DIR, "static")
DB_PATH = os.path.join(DATA_DIR, "history.db")

os.makedirs(UPLOADS_DIR, exist_ok=True)
os.makedirs(DATA_DIR, exist_ok=True)
os.makedirs(STATIC_DIR, exist_ok=True)

# Database Initialization
def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    with get_db() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS texts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT,
                content TEXT NOT NULL,
                sender_device TEXT DEFAULT 'Неизвестно',
                target_device TEXT DEFAULT 'Всем',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS files (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                filename TEXT NOT NULL,
                original_name TEXT NOT NULL,
                file_size INTEGER NOT NULL,
                content_type TEXT DEFAULT 'application/octet-stream',
                sender_device TEXT DEFAULT 'Неизвестно',
                target_device TEXT DEFAULT 'Всем',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT
            )
        """)
        # Initialize default PIN '7777'
        row = conn.execute("SELECT value FROM settings WHERE key = 'pin'").fetchone()
        if not row:
            conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('pin', '7777')")
        conn.commit()

init_db()

# PIN Security Helpers
def get_current_pin() -> str:
    env_pin = os.environ.get("APP_PIN")
    if env_pin:
        return env_pin.strip()
    with get_db() as conn:
        row = conn.execute("SELECT value FROM settings WHERE key = 'pin'").fetchone()
        return row["value"] if row else "7777"

def verify_pin(provided_pin: Optional[str]) -> bool:
    if not provided_pin:
        return False
    return provided_pin.strip() == get_current_pin()

def check_auth(x_app_pin: Optional[str] = None, pin: Optional[str] = None):
    val = x_app_pin or pin
    if not verify_pin(val):
        raise HTTPException(status_code=401, detail="Неверный PIN-код доступа")
    return True

# Network Helpers
def get_local_ips() -> List[str]:
    ips = []
    # Primary gateway-connected IP
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        primary_ip = s.getsockname()[0]
        s.close()
        ips.append(primary_ip)
    except Exception:
        pass

    # All network interfaces
    try:
        hostname = socket.gethostname()
        for ip in socket.gethostbyname_ex(hostname)[2]:
            if ip not in ips and not ip.startswith("127."):
                # Prioritize Wi-Fi / Local ranges
                if ip.startswith(("192.168.", "10.", "172.16.", "172.20.", "172.31.")):
                    ips.insert(1, ip)
                else:
                    ips.append(ip)
    except Exception:
        pass

    if not ips:
        ips = ["127.0.0.1"]
    return ips

# WebSocket Connection Manager
class ConnectionManager:
    def __init__(self):
        self.active_connections: Dict[str, WebSocket] = {}
        self.device_info: Dict[str, Dict[str, Any]] = {}

    async def connect(self, client_id: str, websocket: WebSocket, device_data: Dict[str, Any]):
        await websocket.accept()
        self.active_connections[client_id] = websocket
        self.device_info[client_id] = device_data
        await self.broadcast_peers()

    def disconnect(self, client_id: str):
        if client_id in self.active_connections:
            del self.active_connections[client_id]
        if client_id in self.device_info:
            del self.device_info[client_id]

    async def broadcast_peers(self):
        peers = list(self.device_info.values())
        payload = {"type": "peers_update", "peers": peers}
        await self.broadcast(payload)

    async def broadcast(self, message: Dict[str, Any]):
        dead_clients = []
        for client_id, connection in self.active_connections.items():
            try:
                await connection.send_json(message)
            except Exception:
                dead_clients.append(client_id)
        for client_id in dead_clients:
            self.disconnect(client_id)

manager = ConnectionManager()

# FastAPI App
app = FastAPI(title="AirTransfer - Fast PC & iPhone Sync")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Static and Upload mounts
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
app.mount("/uploads", StaticFiles(directory=UPLOADS_DIR), name="uploads")

@app.get("/", response_class=HTMLResponse)
async def serve_index():
    index_file = os.path.join(STATIC_DIR, "index.html")
    if os.path.exists(index_file):
        with open(index_file, "r", encoding="utf-8") as f:
            return f.read()
    return "<h1>AirTransfer: static/index.html not found</h1>"

def start_tunnel_worker(port: int = 8000, loop = None):
    global TUNNEL_URL, TUNNEL_PROCESS
    cloudflared_path = os.path.join(BASE_DIR, "cloudflared.exe")
    if not os.path.exists(cloudflared_path):
        return

    try:
        cmd = [cloudflared_path, "tunnel", "--url", f"http://127.0.0.1:{port}"]
        TUNNEL_PROCESS = subprocess.Popen(
            cmd,
            stderr=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            text=True,
            encoding="utf-8",
            errors="replace"
        )

        for line in TUNNEL_PROCESS.stderr:
            m = re.search(r"https://[a-zA-Z0-9-]+\.trycloudflare\.com", line)
            if m:
                TUNNEL_URL = m.group(0)
                print(f"\n🌍 Публичный интернет-доступ (HTTPS): {TUNNEL_URL}")
                print(f"👉 На iPhone (через 4G / LTE или любую сеть): {TUNNEL_URL}\n")
                
                # Write to data file
                try:
                    with open(os.path.join(DATA_DIR, "tunnel_url.txt"), "w", encoding="utf-8") as f:
                        f.write(TUNNEL_URL)
                except Exception:
                    pass

                # Broadcast to connected clients if loop is running
                if loop and loop.is_running():
                    try:
                        import asyncio
                        asyncio.run_coroutine_threadsafe(
                            manager.broadcast({"type": "tunnel_ready", "tunnel_url": TUNNEL_URL}),
                            loop
                        )
                    except Exception:
                        pass
                break
    except Exception as e:
        print(f"Ошибка запуска туннеля: {e}")

def stop_tunnel():
    global TUNNEL_PROCESS
    if TUNNEL_PROCESS:
        try:
            TUNNEL_PROCESS.terminate()
            TUNNEL_PROCESS.wait(timeout=2)
        except Exception:
            pass

atexit.register(stop_tunnel)

@app.get("/api/info")
async def get_info():
    ips = get_local_ips()
    return {
        "status": "online",
        "primary_ip": ips[0] if ips else "127.0.0.1",
        "all_ips": ips,
        "tunnel_url": TUNNEL_URL,
        "port": 8000,
        "uploads_count": len(os.listdir(UPLOADS_DIR)) if os.path.exists(UPLOADS_DIR) else 0,
        "active_devices_count": len(manager.active_connections)
    }

# Auth & Settings Endpoints
@app.post("/api/auth/verify")
async def verify_auth_pin(data: Dict[str, Any]):
    pin = data.get("pin", "")
    if verify_pin(pin):
        return {"status": "ok", "valid": True}
    raise HTTPException(status_code=401, detail="Неверный PIN-код")

@app.post("/api/settings/pin")
async def change_pin(
    data: Dict[str, Any],
    x_app_pin: Optional[str] = Header(None)
):
    old_pin = data.get("old_pin", "").strip()
    new_pin = data.get("new_pin", "").strip()
    auth_pin = x_app_pin or old_pin

    if not verify_pin(auth_pin):
        raise HTTPException(status_code=401, detail="Старый PIN-код неверен")
    if len(new_pin) < 4:
        raise HTTPException(status_code=400, detail="Новый PIN должен содержать минимум 4 символа")

    with get_db() as conn:
        conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('pin', ?)", (new_pin,))
        conn.commit()

    return {"status": "ok", "message": "PIN-код успешно изменен"}

# Notes / Text Endpoints
@app.get("/api/texts")
async def list_texts(x_app_pin: Optional[str] = Header(None), pin: Optional[str] = Query(None)):
    check_auth(x_app_pin, pin)
    with get_db() as conn:
        rows = conn.execute(
            "SELECT id, title, content, sender_device, target_device, created_at FROM texts ORDER BY id DESC"
        ).fetchall()
        return [dict(row) for row in rows]

@app.post("/api/texts")
async def create_text(
    data: Dict[str, Any],
    x_app_pin: Optional[str] = Header(None),
    pin: Optional[str] = Query(None)
):
    check_auth(x_app_pin, pin)
    title = data.get("title", "").strip()
    content = data.get("content", "").strip()
    sender_device = data.get("sender_device", "Неизвестное устройство").strip()
    target_device = data.get("target_device", "Всем").strip()

    if not content:
        raise HTTPException(status_code=400, detail="Текст заметки не может быть пустым")

    with get_db() as conn:
        cursor = conn.execute(
            "INSERT INTO texts (title, content, sender_device, target_device, created_at) VALUES (?, ?, ?, ?, ?)",
            (title, content, sender_device, target_device, datetime.now().strftime("%Y-%m-%d %H:%M:%S"))
        )
        conn.commit()
        new_id = cursor.lastrowid
        row = conn.execute("SELECT * FROM texts WHERE id = ?", (new_id,)).fetchone()
        item = dict(row)

    await manager.broadcast({"type": "new_text", "item": item})
    return item

@app.delete("/api/texts/{text_id}")
async def delete_text(
    text_id: int,
    x_app_pin: Optional[str] = Header(None),
    pin: Optional[str] = Query(None)
):
    check_auth(x_app_pin, pin)
    with get_db() as conn:
        conn.execute("DELETE FROM texts WHERE id = ?", (text_id,))
        conn.commit()
    await manager.broadcast({"type": "delete_text", "id": text_id})
    return {"status": "deleted", "id": text_id}

# Files Endpoints
@app.get("/api/files")
async def list_files(x_app_pin: Optional[str] = Header(None), pin: Optional[str] = Query(None)):
    check_auth(x_app_pin, pin)
    with get_db() as conn:
        rows = conn.execute(
            "SELECT id, filename, original_name, file_size, content_type, sender_device, target_device, created_at FROM files ORDER BY id DESC"
        ).fetchall()
        return [dict(row) for row in rows]

@app.post("/api/upload")
async def upload_files(
    files: List[UploadFile] = File(...),
    sender_device: str = Form("Неизвестное устройство"),
    target_device: str = Form("Всем"),
    x_app_pin: Optional[str] = Header(None),
    pin: Optional[str] = Form(None)
):
    check_auth(x_app_pin, pin)
    saved_items = []
    with get_db() as conn:
        for file in files:
            orig_name = file.filename or "file"
            # Generate unique safe filename
            file_ext = os.path.splitext(orig_name)[1]
            safe_basename = os.path.splitext(orig_name)[0][:40].replace(" ", "_")
            unique_filename = f"{datetime.now().strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:6]}_{safe_basename}{file_ext}"
            file_path = os.path.join(UPLOADS_DIR, unique_filename)

            # Stream save file to disk (chunked for large 4k video files)
            file_size = 0
            with open(file_path, "wb") as buffer:
                while chunk := await file.read(1024 * 1024):  # 1MB chunk
                    buffer.write(chunk)
                    file_size += len(chunk)

            content_type = file.content_type or "application/octet-stream"

            cursor = conn.execute(
                """INSERT INTO files 
                   (filename, original_name, file_size, content_type, sender_device, target_device, created_at) 
                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (unique_filename, orig_name, file_size, content_type, sender_device, target_device, datetime.now().strftime("%Y-%m-%d %H:%M:%S"))
            )
            conn.commit()
            new_id = cursor.lastrowid
            row = conn.execute("SELECT * FROM files WHERE id = ?", (new_id,)).fetchone()
            item = dict(row)
            saved_items.append(item)
            await manager.broadcast({"type": "new_file", "item": item})

    return {"status": "ok", "uploaded": saved_items}

@app.get("/api/download/{filename}")
async def download_file(
    filename: str,
    x_app_pin: Optional[str] = Header(None),
    pin: Optional[str] = Query(None)
):
    check_auth(x_app_pin, pin)
    file_path = os.path.join(UPLOADS_DIR, filename)
    if not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail="Файл не найден")

    # Find original name
    with get_db() as conn:
        row = conn.execute("SELECT original_name, content_type FROM files WHERE filename = ?", (filename,)).fetchone()
        original_name = row["original_name"] if row else filename
        content_type = row["content_type"] if row else "application/octet-stream"

    # RFC 5987 encoded header for Russian / UTF-8 names in Safari & Chrome
    quoted_name = urllib.parse.quote(original_name)
    headers = {
        "Content-Disposition": f"attachment; filename=\"{quoted_name}\"; filename*=UTF-8''{quoted_name}"
    }
    return FileResponse(file_path, media_type=content_type, headers=headers)

@app.delete("/api/files/{file_id}")
async def delete_file(
    file_id: int,
    x_app_pin: Optional[str] = Header(None),
    pin: Optional[str] = Query(None)
):
    check_auth(x_app_pin, pin)
    with get_db() as conn:
        row = conn.execute("SELECT filename FROM files WHERE id = ?", (file_id,)).fetchone()
        if row:
            filename = row["filename"]
            file_path = os.path.join(UPLOADS_DIR, filename)
            if os.path.exists(file_path):
                try:
                    os.remove(file_path)
                except Exception:
                    pass
            conn.execute("DELETE FROM files WHERE id = ?", (file_id,))
            conn.commit()

    await manager.broadcast({"type": "delete_file", "id": file_id})
    return {"status": "deleted", "id": file_id}

@app.post("/api/clear-history")
async def clear_history(
    x_app_pin: Optional[str] = Header(None),
    pin: Optional[str] = Query(None)
):
    check_auth(x_app_pin, pin)
    with get_db() as conn:
        conn.execute("DELETE FROM texts")
        # Remove all files
        rows = conn.execute("SELECT filename FROM files").fetchall()
        for r in rows:
            p = os.path.join(UPLOADS_DIR, r["filename"])
            if os.path.exists(p):
                try:
                    os.remove(p)
                except Exception:
                    pass
        conn.execute("DELETE FROM files")
        conn.commit()

    await manager.broadcast({"type": "clear_all"})
    return {"status": "cleared"}

# WebSocket Endpoint
@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    client_id = str(uuid.uuid4())
    try:
        # Check PIN from query params or auth payload
        query_pin = websocket.query_params.get("pin")
        await websocket.accept()
        init_data = await websocket.receive_json()

        auth_pin = query_pin or init_data.get("pin")
        if not verify_pin(auth_pin):
            await websocket.send_json({"type": "auth_error", "message": "Неверный PIN-код"})
            await websocket.close(code=1008)
            return

        device_name = init_data.get("device_name", "Браузер")
        device_type = init_data.get("device_type", "desktop")  # 'ios', 'android', 'desktop'
        
        device_info = {
            "id": client_id,
            "name": device_name,
            "type": device_type,
            "connected_at": datetime.now().strftime("%H:%M:%S")
        }

        manager.active_connections[client_id] = websocket
        manager.device_info[client_id] = device_info
        await manager.broadcast_peers()

        while True:
            data = await websocket.receive_json()
            # Echo or process incoming commands if any
            if data.get("type") == "ping":
                await websocket.send_json({"type": "pong"})
    except WebSocketDisconnect:
        manager.disconnect(client_id)
        await manager.broadcast_peers()
    except Exception:
        manager.disconnect(client_id)
        await manager.broadcast_peers()

import threading
import webbrowser

def open_browser():
    try:
        import time
        time.sleep(1.2)
        webbrowser.open("http://localhost:8000")
    except Exception:
        pass

def run_server(host="0.0.0.0", port=None):
    if port is None:
        port = int(os.environ.get("PORT", 8000))

    ips = get_local_ips()
    primary_ip = ips[0]
    print("\n" + "="*62)
    print("🚀  AirTransfer — Сервер успешно запущен!")
    print(f"👉  На ПК (открывается в браузере): http://localhost:{port}")
    print(f"👉  На iPhone (откройте в Safari):  http://{primary_ip}:{port}")
    if len(ips) > 1:
        print("\nДругие доступные IP-адреса сети (Wi-Fi / Кабель):")
        for ip in ips[1:]:
            print(f"   • http://{ip}:{port}")
    print("="*62 + "\n")
    print("💡 Подсказка: на iPhone просто наведите камеру на QR-код на экране!")
    print("Нажмите Ctrl + C для остановки сервера.\n")
    
    # Auto-open browser on local Windows PC
    if sys.platform == "win32" and not os.environ.get("RENDER"):
        threading.Thread(target=open_browser, daemon=True).start()

    # Start Cloudflare Tunnel in background if local executable is present
    threading.Thread(target=start_tunnel_worker, args=(port,), daemon=True).start()

    uvicorn.run(app, host=host, port=port, log_level="info")

if __name__ == "__main__":
    run_server()
