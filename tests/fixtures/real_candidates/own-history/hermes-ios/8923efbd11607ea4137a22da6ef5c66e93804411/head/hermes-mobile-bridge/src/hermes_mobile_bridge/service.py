import asyncio
import base64
import contextlib
import json
import mimetypes
import os
import stat
import uuid
from pathlib import Path
from . import __version__
from .core import ACTIVE, TERMINAL, Problem, identifier, message, now, opaque, only, task, usage
from .store import Store
from .upstream import Backend


class Service:
    def __init__(self, cfg):
        self.cfg = cfg
        self.store = Store(cfg)
        self.backends = {name: Backend(name, b, self.event, self.health_changed) for name, b in cfg["backends"].items()}
        self.locks = {}
        self.changed = asyncio.Condition()
        self.maintenance = set()
        self.worker = None
        self.board_workers = []
        self.started = now()

    async def start(self):
        for backend in self.backends.values():
            await backend.start()
        self.worker = asyncio.create_task(self.monitor())
        for profile, backend in self.backends.items():
            for board in backend.cfg["boards"]:
                self.board_workers.append(asyncio.create_task(self.board_events(profile, board)))

    async def close(self):
        for worker in [self.worker, *self.board_workers]:
            if worker:
                worker.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await worker
        for pending in list(self.maintenance):
            pending.cancel()
        if self.maintenance:
            await asyncio.gather(*self.maintenance, return_exceptions=True)
        for backend in self.backends.values():
            await backend.close()
        self.store.close()

    def require(self, auth, profile, scope="read"):
        if profile not in self.backends or profile not in auth["profiles"] or scope not in auth["scopes"]:
            raise Problem(403, "forbidden", "Credential does not permit this profile/action")
        return self.backends[profile]

    def profiles(self, auth):
        return [p for p in self.backends if p in auth["profiles"]]

    def conversation(self, auth, cid, scope="read"):
        row = self.store.get("conversations", cid)
        self.require(auth, row["profile"], scope)
        return row

    def run(self, auth, rid, scope="read"):
        row = self.store.get("runs", identifier(rid))
        self.require(auth, row["profile"], scope)
        return row

    def run_view(self, row):
        b = self.backends[row["profile"]]
        controls = b.connected and row["state"] in ACTIVE - {"unknown"} and bool(row["live_id"])
        return {"id": row["id"], "conversation_id": row["conversation_id"], "profile": row["profile"], "task_id": None, "origin": "desktop_rpc", "snapshot_cursor": self.store.run_cursor(row["id"]), "state": row["state"], "created_at": row["created"], "updated_at": row["updated"], "controls": {"stop": controls, "steer": controls and row["state"] != "stop_requested", "retry": row["state"] in {"failed", "cancelled"} and bool(row["data"].get("prompt"))}, **only(row["data"], "assistant_text usage coverage_gap reason parent_run_id steering_ack projection_truncated")}

    def conversation_view(self, row):
        return {"id": row["id"], "profile": row["profile"], "owned": bool(row["owned"]), **only(row["data"], "title model provider reasoning_effort cwd source archived started_at message_count")}

    def observe_conversation(self, profile, raw):
        sid = raw.get("session_id") or raw.get("id")
        existing = self.store.db.execute("SELECT conversation_id FROM aliases WHERE profile=? AND stored_id=?", (profile, sid)).fetchone()
        cid = existing[0] if existing else opaque(profile, sid)
        old = self.store.db.execute("SELECT live_id FROM conversations WHERE id=?", (cid,)).fetchone()
        self.store.save_conversation(cid, profile, sid, old[0] if old else None, data=only(raw, "title source model provider started_at message_count archived cwd"))
        return self.conversation_view(self.store.get("conversations", cid))

    async def emit(self, profile, kind, payload, run=None, raw=None, dedup=None):
        evt = self.store.append(profile, kind, payload, run["id"] if run else None, run["conversation_id"] if run else None, raw, dedup)
        if evt:
            async with self.changed:
                self.changed.notify_all()
        return evt

    async def activity(self, profile):
        backend = self.backends[profile]
        if not backend.connected:
            return []
        raw = await backend.rpc("session.active_list")
        items = []
        for item in raw.get("sessions", []):
            sid = item.get("id")
            run = self.live_run(profile, sid)
            alias = self.store.db.execute("SELECT conversation_id FROM aliases WHERE profile=? AND stored_id=?", (profile, item.get("session_key"))).fetchone()
            items.append({"id": opaque(profile, "live." + sid), "profile": profile, "conversation_id": alias[0] if alias else None, "bridge_run_id": run["id"] if run else None, **only(item, "status title model last_active message_count"), "coverage": "this_desktop_backend_only"})
        return items

    def live_run(self, profile, sid):
        rows = self.store.db.execute("SELECT id FROM runs WHERE profile=? AND live_id=? ORDER BY created DESC LIMIT 1", (profile, sid)).fetchall()
        return self.store.get("runs", rows[0][0]) if rows else None

    async def event(self, profile, event):
        sid, kind, payload = event.get("session_id"), event.get("type"), event.get("payload") or {}
        if not isinstance(payload, dict):
            return
        if kind == "session.info":
            conv = self.store.db.execute("SELECT id FROM conversations WHERE profile=? AND live_id=?", (profile, sid)).fetchone()
            if conv:
                row = self.store.get("conversations", conv[0])
                stored = payload.get("session_key") or row["stored_id"]
                self.store.save_conversation(row["id"], profile, stored, sid, True, only(payload, "model provider reasoning_effort cwd"))
            return
        run = self.live_run(profile, sid)
        if not run:
            return
        rid = run["id"]
        if run["state"] in TERMINAL and kind != "message.start":
            return  # late/replayed frames cannot revive a finished execution
        if kind == "message.start":
            if run["state"] in TERMINAL:
                run = self.store.run(run["conversation_id"], profile, sid, "", parent=rid)
                rid = run["id"]
                await self.emit(profile, "run.started", self.run_view(run), run)
            stop_intent = self.store.get("runs", rid)["data"].get("stop_intent", False)
            state = "stop_requested" if stop_intent else "running"
            run = self.store.update_run(rid, state)
            if stop_intent:
                self.schedule_stop(rid, self.backends[profile].generation)
            await self.emit(profile, "run.status", {"state": state}, run, event)
        elif kind == "message.delta":
            text = payload.get("text", "")
            if not isinstance(text, str) or not text:
                return
            self.store.update_run(rid, assistant_text=(run["data"].get("assistant_text", "") + text)[-1000000:], projection_truncated=len(run["data"].get("assistant_text", "")) + len(text) > 1000000)
            await self.emit(profile, "assistant.delta", {"text": text}, run, event)
        elif kind == "message.complete":
            # Completion replaces the partial text, it is never appended again.
            text = payload.get("text") or ""
            if not isinstance(text, str):
                text = str(text)
            state = {"complete": "complete", "interrupted": "cancelled", "error": "failed"}.get(payload.get("status"), "unknown")
            run = self.store.update_run(rid, state, assistant_text=text[-1000000:], projection_truncated=len(text) > 1000000, usage=usage(payload.get("usage") or {}))
            await self.emit(profile, "assistant.completed", only(payload, "status warning") | {"text": text}, run, event)
            await self.emit(profile, "run." + {"complete": "completed", "failed": "failed", "cancelled": "cancelled"}.get(state, "status"), {"state": state, "usage": run["data"]["usage"]}, run)
            await self.invalidate_attention(rid, "uncertain")
        elif kind in {"tool.start", "tool.complete"}:
            if kind == "tool.start":
                self.store.update_run(rid, active_tool_id=payload.get("tool_id"))
            normalized = only(payload, "tool_id name context args_text args result duration_s summary todos")
            result = payload.get("result")
            failed = kind == "tool.complete" and isinstance(result, dict) and bool(result.get("error"))
            await self.emit(profile, "tool.started" if kind == "tool.start" else "tool.failed" if failed else "tool.completed", normalized, run, event, dedup=f"{rid}:{kind}:{payload['tool_id']}" if payload.get("tool_id") else None)
            if kind == "tool.complete":
                await self.invalidate_attention(rid, "uncertain")
            if kind == "tool.complete" and isinstance(result, dict):
                for key in ("file_path", "image_path", "artifact_path"):
                    if isinstance(result.get(key), str):
                        self.register_artifact(run["conversation_id"], profile, result[key], rid)
        elif kind in {"approval.request", "clarify.request", "sudo.request", "secret.request", "terminal.read.request"}:
            # Resume may replay a pending exact prompt. Reuse the original
            # observation/expiry; a reconnect cannot make it safe/fresh again.
            if payload.get("request_id"):
                for existing in self.store.db.execute("SELECT data FROM attention WHERE run_id=?", (rid,)).fetchall():
                    if json.loads(existing[0]).get("request_id") == payload["request_id"]:
                        return
            if kind == "approval.request":
                for existing in self.store.db.execute("SELECT data FROM attention WHERE run_id=?", (rid,)).fetchall():
                    item = json.loads(existing[0])
                    if item["kind"] == "approval" and item["state"] == "pending" and item["generation"] == self.backends[profile].generation and item["details"] == only(payload, "command description pattern_key pattern_keys allow_permanent question choices"):
                        return
            aid = uuid.uuid4().hex
            exact = kind == "clarify.request" and bool(payload.get("request_id"))
            item = {"id": aid, "run_id": rid, "conversation_id": run["conversation_id"], "profile": profile, "kind": "clarification" if exact else "approval" if kind == "approval.request" else "local_terminal_input" if kind == "terminal.read.request" else "local_secret_input", "state": "pending", "observed_at": now(), "expires_at": now() + 290, "can_respond": exact, "limitation": None if exact else "upstream_fifo_without_exact_target" if kind == "approval.request" else "local_terminal_buffer_required" if kind == "terminal.read.request" else "local_only_secret_input", "details": only(payload, "command description pattern_key pattern_keys allow_permanent question choices"), "request_id": payload.get("request_id"), "generation": self.backends[profile].generation}
            self.store.db.execute("INSERT INTO attention VALUES (?,?,?,?)", (aid, rid, profile, json.dumps(item)))
            self.store.db.commit()
            latest = self.store.get("runs", rid)
            stopping = latest["data"].get("stop_intent", False)
            self.store.update_run(rid, "stop_requested" if stopping else "waiting_for_input")
            if stopping:
                self.schedule_stop(rid, self.backends[profile].generation)
            await self.emit(profile, "approval.requested", self.attention_view(item), run, event)
        elif kind == "error":
            run = self.store.update_run(rid, "failed", reason="hermes_execution_error")
            await self.emit(profile, "run.failed", {"state": "failed", "reason": "hermes_execution_error"}, run, event)

    def attention_view(self, item):
        if item["can_respond"]:
            run = self.store.get("runs", item["run_id"])
            backend = self.backends[item["profile"]]
            item = item | {"can_respond": item["state"] == "pending" and item["expires_at"] > now() and backend.connected and backend.generation == item["generation"] and run["state"] == "waiting_for_input" and not run["data"].get("stop_intent")}
        return {k: v for k, v in item.items() if k not in {"request_id", "generation"}}

    async def invalidate_attention(self, rid, state):
        for row in self.store.db.execute("SELECT * FROM attention WHERE run_id=?", (rid,)).fetchall():
            item = json.loads(row["data"])
            if item["state"] == "pending":
                item.update(state=state, can_respond=False)
                self.store.db.execute("UPDATE attention SET data=? WHERE id=?", (json.dumps(item), item["id"]))
                await self.emit(item["profile"], "approval.resolved", {"id": item["id"], "state": state, "evidence": "no_exact_upstream_resolution_event"}, self.store.get("runs", rid))
        self.store.db.commit()

    async def health_changed(self, profile, connected):
        await self.emit(profile, "studio.connection", {"connected": connected})
        if connected:
            await self.reconcile(profile, recover=True)
        else:
            for row in self.store.runs([profile]):
                if row["state"] not in TERMINAL:
                    row = self.store.update_run(row["id"], "unknown", coverage_gap=True, reason="upstream_disconnected")
                    await self.emit(profile, "run.status", {"state": "unknown", "coverage_gap": True}, row)
                    await self.invalidate_attention(row["id"], "uncertain")

    async def reconcile(self, profile, recover=False):
        backend = self.backends[profile]
        try:
            active = (await backend.rpc("session.active_list")).get("sessions", [])
        except Problem:
            return
        # Detect compression lineage changes from canonical history, keeping
        # the bridge conversation ID stable across rotated stored IDs.
        for convrow in self.store.db.execute("SELECT id FROM conversations WHERE profile=? AND owned=1", (profile,)).fetchall():
            conv = self.store.get("conversations", convrow[0])
            live = next((a for a in active if a.get("id") == conv["live_id"]), None)
            if live and live.get("session_key") != conv["stored_id"]:
                try:
                    history = await backend.rest("GET", f"/api/sessions/{conv['stored_id']}/messages", query={"profile": profile})
                    if history.get("session_id") == live.get("session_key"):
                        self.store.save_conversation(conv["id"], profile, live["session_key"], conv["live_id"], True)
                except Problem:
                    pass
        for row in self.store.runs([profile]):
            if row["state"] in TERMINAL:
                continue
            conv = self.store.get("conversations", row["conversation_id"])
            match = next((a for a in active if a.get("id") == row["live_id"] and a.get("session_key") == conv["stored_id"]), None)
            if not match:
                if row["state"] != "unknown":
                    row = self.store.update_run(row["id"], "unknown", coverage_gap=True, reason="upstream_handle_missing")
                    await self.emit(profile, "run.status", {"state": "unknown", "reason": "upstream_handle_missing"}, row)
                continue
            if recover and match.get("status") in {"working", "starting", "waiting"}:
                # Only reconnect to the SAME previously owned live handle. Do
                # not build a replacement agent or automatically replay a prompt.
                try:
                    res = await backend.rpc("session.resume", {"session_id": conv["stored_id"]})
                except Problem:
                    continue
                if res.get("session_id") != row["live_id"]:
                    continue
                state = "waiting_for_input" if match["status"] == "waiting" else "running"
                fields = {"coverage_gap": True}
                if row["data"].get("stop_intent"):
                    state = "stop_requested"
                    self.schedule_stop(row["id"], backend.generation)
                if isinstance(res.get("inflight"), dict):
                    fields["assistant_text"] = res["inflight"].get("assistant", "")
                row = self.store.update_run(row["id"], state, **fields)
                await self.emit(profile, "run.status", {"state": state, "coverage_gap": True, "hydrate": True}, row)
            elif match.get("status") == "idle" and row["state"] not in {"starting", "unknown"}:
                row = self.store.update_run(row["id"], "unknown", coverage_gap=True, reason="completion_not_observed")
                await self.emit(profile, "run.status", {"state": "unknown", "reason": "completion_not_observed"}, row)

    async def monitor(self):
        while True:
            await asyncio.sleep(5)
            for profile, backend in self.backends.items():
                if backend.connected:
                    await self.reconcile(profile)
            for row in self.store.db.execute("SELECT data FROM attention").fetchall():
                item = json.loads(row[0])
                if item["state"] == "pending" and item["expires_at"] < now():
                    await self.invalidate_attention(item["run_id"], "expired")

    async def ensure_live(self, conv):
        backend = self.backends[conv["profile"]]
        if conv["data"].get("deleted"):
            raise Problem(410, "conversation_deleted", "Conversation was deleted")
        if not backend.connected:
            raise Problem(503, "upstream_unavailable", "Hermes is offline")
        active = (await backend.rpc("session.active_list")).get("sessions", [])
        matching = [a for a in active if a.get("session_key") == conv["stored_id"]]
        if matching and (not conv["owned"] or matching[0].get("id") != conv["live_id"]):
            raise Problem(409, "ownership_conflict", "Conversation is active outside bridge ownership")
        if matching and matching[0].get("status") not in {"idle", "starting"}:
            raise Problem(409, "conversation_busy", "Conversation is executing or awaiting input")
        if matching:
            return conv["live_id"]
        result = await backend.rpc("session.resume", {"session_id": conv["stored_id"]})
        stored = result.get("session_key") or conv["stored_id"]
        self.store.save_conversation(conv["id"], conv["profile"], stored, result["session_id"], True, only(result.get("info", {}), "model provider reasoning_effort cwd"))
        return result["session_id"]

    async def create(self, profile, body):
        backend = self.backends[profile]
        params = only(body, "title model provider reasoning_effort") | {"source": "mobile", "close_on_disconnect": False}
        if body.get("workspace"):
            params["cwd"] = backend.cfg["workspaces"][body["workspace"]]
        result = await backend.rpc("session.create", params)
        cid = opaque(profile, result["stored_session_id"])
        self.store.save_conversation(cid, profile, result["stored_session_id"], result["session_id"], True, only(result.get("info", {}), "model provider reasoning_effort cwd") | only(body, "title"))
        return self.conversation_view(self.store.get("conversations", cid))

    async def start_run(self, conv, text, parent=None):
        lock = self.locks.setdefault(conv["id"], asyncio.Lock())
        async with lock:
            pending = [r for r in self.store.runs([conv["profile"]]) if r["conversation_id"] == conv["id"] and r["state"] not in TERMINAL]
            if pending:
                raise Problem(409, "conversation_busy", "Existing run is active or has an uncertain outcome", run_id=pending[0]["id"])
            sid = await self.ensure_live(conv)
            current = self.store.get("conversations", conv["id"])
            refs = current["data"].get("pending_file_refs", [])
            if refs:
                text += "\n\n" + "\n".join(refs)
                self.store.save_conversation(conv["id"], conv["profile"], current["stored_id"], sid, True, {"pending_file_refs": []})
            run = self.store.run(conv["id"], conv["profile"], sid, text, parent)
            await self.emit(conv["profile"], "run.started", self.run_view(run), run)
            try:
                await self.backends[conv["profile"]].rpc("prompt.submit", {"session_id": sid, "text": text})
            except Problem as err:
                state = "unknown" if err.code in {"upstream_uncertain", "upstream_unavailable"} else "failed"
                run = self.store.update_run(run["id"], state, reason=err.code)
                await self.emit(conv["profile"], "run.status" if state == "unknown" else "run.failed", {"state": state, "reason": err.code}, run)
                raise
            return self.run_view(self.store.get("runs", run["id"]))

    async def control(self, run, action, text=None):
        if not self.run_view(run)["controls"].get(action):
            raise Problem(409, "control_unavailable", "Run has no safe live control handle")
        backend = self.backends[run["profile"]]
        # Reject stale handles immediately before sending a control.
        active = (await backend.rpc("session.active_list")).get("sessions", [])
        conv = self.store.get("conversations", run["conversation_id"])
        if not any(a.get("id") == run["live_id"] and a.get("session_key") == conv["stored_id"] and a.get("status") in {"starting", "working", "waiting"} for a in active):
            raise Problem(409, "control_unavailable", "Hermes no longer reports this execution as active")
        if action == "stop":
            self.store.update_run(run["id"], stop_intent=True)
            result = await backend.rpc("session.interrupt", {"session_id": run["live_id"]})
            latest = self.store.get("runs", run["id"])
            if latest["state"] not in TERMINAL:
                self.store.update_run(run["id"], "stop_requested")
            await self.invalidate_attention(run["id"], "uncertain")
            await self.emit(run["profile"], "run.status", {"state": self.store.get("runs", run["id"])["state"], "stop_acknowledged": True}, run)
            return {"acknowledged": True, "termination_confirmed": False, "run": self.run_view(self.store.get("runs", run["id"]))}
        result = await backend.rpc("session.steer", {"session_id": run["live_id"], "text": text})
        status = result.get("status")
        self.store.update_run(run["id"], steering_ack=status)
        await self.emit(run["profile"], "steering.accepted" if status == "queued" else "steering.rejected", {"status": status, "consumed": False}, run)
        return {"status": status, "consumed": False}

    def schedule_stop(self, rid, generation):
        # An approval can be enqueued AFTER Hermes's interrupt cleared the
        # session FIFO. Reassert the authorized whole-run stop once that
        # newly observed wait exists; never answer an individual FIFO entry.
        async def reassert():
            row = self.store.get("runs", rid)
            backend = self.backends[row["profile"]]
            if backend.connected and backend.generation == generation and row["state"] not in TERMINAL and row["data"].get("stop_intent"):
                try:
                    await backend.rpc("session.interrupt", {"session_id": row["live_id"]})
                except Problem:
                    pass
        pending = asyncio.create_task(reassert())
        self.maintenance.add(pending)
        pending.add_done_callback(self.maintenance.discard)

    def artifact_open(self, profile, path):
        target = Path(path)
        if not target.is_absolute():
            raise Problem(403, "artifact_denied", "Artifact must be in a configured root")
        for rawroot in self.backends[profile].cfg["artifact_roots"]:
            root = Path(rawroot)
            try:
                relative = target.relative_to(root)
            except ValueError:
                continue
            if not relative.parts or any(p in {"..", "."} for p in relative.parts):
                continue
            fd = None
            try:
                # Walk from / using directory descriptors: no symlink component
                # (including configured roots) and no check/open TOCTOU window.
                fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
                parts = target.parts[1:]
                for index, part in enumerate(parts):
                    nxt = os.open(part, os.O_RDONLY | os.O_NOFOLLOW | (os.O_DIRECTORY if index < len(parts) - 1 else os.O_NONBLOCK), dir_fd=fd)
                    os.close(fd)
                    fd = nxt
                st = os.fstat(fd)
                if not stat.S_ISREG(st.st_mode) or st.st_size > self.cfg["artifact_limit"] or st.st_nlink != 1:
                    raise OSError()
                return os.fdopen(fd, "rb"), st
            except OSError:
                if fd is not None:
                    os.close(fd)
        raise Problem(403, "artifact_denied", "Artifact is outside safe roots, oversized, linked, or unavailable")

    def register_artifact(self, cid, profile, path, run_id=None):
        try:
            f, st = self.artifact_open(profile, path)
            f.close()
        except Problem:
            return None
        aid = uuid.uuid4().hex
        item = {"id": aid, "conversation_id": cid, "run_id": run_id, "profile": profile, "name": Path(path).name, "size": st.st_size, "content_type": mimetypes.guess_type(path)[0] or "application/octet-stream", "path": path, "device": st.st_dev, "inode": st.st_ino, "mtime_ns": st.st_mtime_ns}
        self.store.db.execute("INSERT INTO artifacts VALUES (?,?,?,?)", (aid, cid, profile, json.dumps(item)))
        self.store.db.commit()
        return self.artifact_view(item)

    def artifact_view(self, item):
        return only(item, "id conversation_id run_id profile name size content_type")

    async def board_events(self, profile, board):
        backend = self.backends[profile]
        key = f"board:{profile}:{board}"
        while True:
            try:
                cursor = self.store.db.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
                since = int(cursor[0]) if cursor else 0
                async with backend.http.ws_connect(backend.cfg["url"].rstrip("/") + "/api/plugins/kanban/events", params={"token": backend.cfg["token"], "board": board, "since": str(since)}, heartbeat=15) as ws:
                    async for msg in ws:
                        if msg.type != 1:
                            continue
                        frame = msg.json()
                        for event in frame.get("events", []):
                            await self.emit(profile, "task.activity", {"board": board, "task_id": opaque(profile, board + "." + event["task_id"]) if event.get("task_id") else None, "attempt_id": event.get("run_id"), "kind": event.get("kind"), "created_at": event.get("created_at"), "details": only(event.get("payload") or {}, "status from to reason summary assignee")}, dedup=f"kanban:{profile}:{board}:{event['id']}")
                        self.store.db.execute("INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, str(frame.get("cursor", since))))
                        self.store.db.commit()
            except asyncio.CancelledError:
                raise
            except Exception:
                pass
            await asyncio.sleep(5)
