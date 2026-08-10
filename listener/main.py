from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

app = FastAPI(title="Workflow http_request listener")

received: list[dict[str, Any]] = []


@app.post("/hooks/workflow")
async def receive(req: Request) -> JSONResponse:
    try:
        payload = await req.json()
    except Exception:
        payload = {"_raw": (await req.body()).decode(errors="replace")}

    entry = {
        "id": len(received) + 1,
        "received_at": datetime.now(timezone.utc).isoformat(),
        "headers": {k: v for k, v in req.headers.items()},
        "payload": payload,
    }
    received.append(entry)

    return JSONResponse({"ok": True, "id": entry["id"], "count": len(received)})


@app.get("/last")
async def last() -> JSONResponse:
    if not received:
        return JSONResponse({"ok": True, "count": 0, "entry": None})
    return JSONResponse({"ok": True, "count": len(received), "entry": received[-1]})


@app.get("/all")
async def all_entries() -> JSONResponse:
    return JSONResponse({"ok": True, "count": len(received), "entries": received})


@app.post("/reset")
async def reset() -> JSONResponse:
    received.clear()
    return JSONResponse({"ok": True, "count": 0})
