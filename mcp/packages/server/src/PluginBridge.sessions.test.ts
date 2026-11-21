import assert from "node:assert/strict";
import { once } from "node:events";
import { afterEach, beforeEach, mock, test } from "node:test";
import { WebSocket } from "ws";
import { HEARTBEAT_REQUEST_INTERVAL_MS, PluginBridge } from "./PluginBridge";
import { PluginTask } from "./PluginTask";
import type { PenpotMcpServer } from "./PenpotMcpServer";
import { ListConnectionsTool } from "./tools/ListConnectionsTool";

let bridge: PluginBridge;
let port = 17_600;
let userToken: string | undefined;
let multiUser: boolean;
let sockets: WebSocket[];

beforeEach(() => {
    port++;
    userToken = "alice";
    multiUser = true;
    sockets = [];
    bridge = new PluginBridge(
        {
            host: "127.0.0.1",
            isMultiUserMode: () => multiUser,
            getSessionContext: () => ({ userToken }),
        } as PenpotMcpServer,
        port,
        1
    );
});

afterEach(async () => {
    for (const socket of sockets) socket.terminate();
    await bridge.close();
});

async function connect(sessionId: string, token = "alice", fileName = "Design", reply = sessionId, fileId = "file-1") {
    const socket = new WebSocket(`ws://127.0.0.1:${port}?userToken=${token}`);
    sockets.push(socket);
    await once(socket, "open");
    // answer tasks from the start, since one may arrive right behind the initialization
    socket.on("message", (raw) => {
        const request = JSON.parse(raw.toString());
        if (request.type !== "initialized" && request.type !== "heartbeat-request") {
            socket.send(JSON.stringify({ id: request.id, success: true, data: reply }));
        }
    });
    const initialized = once(socket, "message", { signal: AbortSignal.timeout(1500) });
    socket.send(JSON.stringify({ type: "initialize", session: { sessionId, fileId, fileName } }));
    const [message] = await initialized;
    assert.equal(JSON.parse(message.toString()).type, "initialized");
    return socket;
}

test("asks each plugin for a heartbeat at a fixed interval", async () => {
    mock.timers.enable({ apis: ["setInterval"] });
    try {
        const socket = await connect("tab-1");
        const requested = once(socket, "message", { signal: AbortSignal.timeout(1500) });
        mock.timers.tick(HEARTBEAT_REQUEST_INTERVAL_MS);
        const [message] = await requested;
        assert.deepEqual(JSON.parse(message.toString()), { type: "heartbeat-request" });
    } finally {
        mock.timers.reset();
    }
});

test("keeps two tabs for the same file and dispatches to the selected session", async () => {
    await connect("tab-1");
    await connect("tab-2");
    const result = await bridge.executePluginTask(new PluginTask("test", {}), "tab-2");
    assert.equal(result.data, "tab-2");
});

test("requires user selection when more than one session is connected", async () => {
    await connect("tab-1", "alice", "First design");
    await connect("tab-2", "alice", "Second design");
    await assert.rejects(bridge.executePluginTask(new PluginTask("test", {})), (error: Error) => {
        assert.match(error.message, /Ask the user/);
        assert.match(error.message, /tab-1.*First design/);
        assert.match(error.message, /tab-2.*Second design/);
        return true;
    });
});

test("implicitly selects the only session belonging to the requesting user", async () => {
    await connect("alice-tab");
    await connect("bob-tab", "bob");
    const result = await bridge.executePluginTask(new PluginTask("test", {}));
    assert.equal(result.data, "alice-tab");
});

test("does not dispatch to another user's session", async () => {
    await connect("alice-tab");
    await connect("bob-tab", "bob");
    await assert.rejects(bridge.executePluginTask(new PluginTask("test", {}), "bob-tab"), /not connected/);
});

test("reports no sessions when no plugin has initialized", async () => {
    await assert.rejects(bridge.executePluginTask(new PluginTask("test", {})), /No Penpot.*connected/);
});

test("regular plugins without user tokens can select among multiple sessions", async () => {
    multiUser = false;
    await connect("first", "");
    await connect("second", "");
    await assert.rejects(bridge.executePluginTask(new PluginTask("test", {})), /Ask the user/);
    assert.equal((await bridge.executePluginTask(new PluginTask("test", {}), "second")).data, "second");
});

test("disconnecting one session leaves its sibling available for implicit selection", async () => {
    const first = await connect("first");
    await connect("second");
    const closed = once(first, "close");
    first.close();
    await closed;
    assert.equal((await bridge.executePluginTask(new PluginTask("test", {}))).data, "second");
    await assert.rejects(bridge.executePluginTask(new PluginTask("test", {}), "first"), /not connected/);
});

test("a reconnect with the same session ID replaces the previous connection", async () => {
    const previous = await connect("tab", "alice", "Design", "previous");
    const closed = once(previous, "close");
    await connect("tab", "alice", "Design", "current");
    const [code] = await closed;
    assert.equal(code, 1008);
    assert.equal((await bridge.executePluginTask(new PluginTask("test", {}))).data, "current");
    assert.equal((await bridge.executePluginTask(new PluginTask("test", {}), "tab")).data, "current");
});

test("a half-open previous connection does not block a reconnect with the same session ID", async () => {
    const previous = await connect("tab", "alice", "Design", "previous");
    // stop answering, as a socket whose network path is gone would
    previous.pause();
    await connect("tab", "alice", "Design", "current");
    assert.equal((await bridge.executePluginTask(new PluginTask("test", {}), "tab")).data, "current");
});

test("replacing a session does not affect another user's session with the same ID", async () => {
    await connect("tab", "bob", "Design", "bob");
    await connect("tab", "alice", "Design", "alice");
    userToken = "bob";
    assert.equal((await bridge.executePluginTask(new PluginTask("test", {}), "tab")).data, "bob");
});

test("uninitialized sockets are not candidates for discovery", async () => {
    await connect("ready");
    const pending = new WebSocket(`ws://127.0.0.1:${port}?userToken=alice`);
    sockets.push(pending);
    await once(pending, "open");
    assert.equal((await bridge.executePluginTask(new PluginTask("test", {}))).data, "ready");
});

test("invalid initialization metadata cannot register a session", async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}?userToken=alice`);
    sockets.push(socket);
    await once(socket, "open");
    const closed = once(socket, "close");
    socket.send(JSON.stringify({ type: "initialize", session: { sessionId: "bad", fileId: 42 } }));
    assert.equal((await closed)[0], 1008);
    await assert.rejects(bridge.executePluginTask(new PluginTask("test", {})), /No Penpot sessions/);
});

test("a dashboard session remains routable while its workspace metadata changes", async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}?userToken=alice`);
    sockets.push(socket);
    await once(socket, "open");
    const initialized = once(socket, "message");
    socket.send(
        JSON.stringify({
            type: "initialize",
            session: { sessionId: "tab", fileId: null, fileName: null, workspaceState: "none" },
        })
    );
    await initialized;
    socket.on("message", (raw) => {
        const request = JSON.parse(raw.toString());
        socket.send(JSON.stringify({ id: request.id, success: true, data: "ok" }));
    });
    for (const context of [
        { fileId: "file-1", fileName: "Design", workspaceState: "ready" },
        { fileId: null, fileName: null, workspaceState: "none" },
    ]) {
        socket.send(JSON.stringify({ type: "context-update", context }));
        assert.equal((await bridge.executePluginTask(new PluginTask("test", {}), "tab")).data, "ok");
        const [session] = bridge.getUserConnections("alice")!.getSessions();
        assert.deepEqual(session, { sessionId: "tab", ...context, connectedAt: session.connectedAt });
    }
});

test("a task fails at once when its plugin connection closes before answering", async () => {
    const plugin = new WebSocket(`ws://127.0.0.1:${port}?userToken=alice`);
    sockets.push(plugin);
    await once(plugin, "open");
    const initialized = once(plugin, "message");
    plugin.send(JSON.stringify({ type: "initialize", session: { sessionId: "tab", fileId: null, fileName: null } }));
    await initialized;
    // the socket closes once the task reaches it
    plugin.on("message", () => plugin.terminate());
    const started = Date.now();
    await assert.rejects(
        bridge.executePluginTask(new PluginTask("test", {}), "tab"),
        /connection closed before the task finished/
    );
    // well within the 1s task timeout of these tests
    assert.ok(Date.now() - started < 500);
});

/** Connects two tabs with different files, as `connect` would for each. */
async function connectTwoFiles() {
    await connect("tab-1", "alice", "Components", "tab-1", "file-a");
    await connect("tab-2", "alice", "Screens", "tab-2", "file-b");
}

function run(sessionId?: string, file?: string) {
    return bridge.executePluginTask(new PluginTask("test", {}), sessionId, file);
}

test("a file argument selects the session by file ID", async () => {
    await connectTwoFiles();
    assert.equal((await run(undefined, "file-b")).data, "tab-2");
});

test("a file argument selects the session by exact file name", async () => {
    await connectTwoFiles();
    assert.equal((await run(undefined, "Components")).data, "tab-1");
});

test("a file argument falls back to a case-insensitive file name", async () => {
    await connectTwoFiles();
    assert.equal((await run(undefined, "screens")).data, "tab-2");
});

test("an exact file name match wins over a case-insensitive one", async () => {
    await connect("tab-1", "alice", "design", "tab-1", "file-a");
    await connect("tab-2", "alice", "Design", "tab-2", "file-b");
    assert.equal((await run(undefined, "Design")).data, "tab-2");
    // a session ID still selects a tab matched only case-insensitively
    assert.equal((await run("tab-1", "Design")).data, "tab-1");
});

test("a file argument and a session ID that agree select that session", async () => {
    await connectTwoFiles();
    assert.equal((await run("tab-2", "Screens")).data, "tab-2");
});

test("a file argument and a session ID that disagree fail", async () => {
    await connectTwoFiles();
    await assert.rejects(run("tab-1", "Screens"), (error: Error) => {
        assert.match(error.message, /"tab-1" does not have file "Screens" open/);
        assert.match(error.message, /tab-2: "Screens" \(file file-b\)/);
        return true;
    });
});

test("a file argument matching no session lists the connected sessions", async () => {
    await connectTwoFiles();
    await assert.rejects(run(undefined, "Missing"), (error: Error) => {
        assert.match(error.message, /No connected Penpot session has file "Missing" open/);
        assert.match(error.message, /tab-1: "Components" \(file file-a\)/);
        assert.match(error.message, /tab-2: "Screens" \(file file-b\)/);
        return true;
    });
});

test("a file open in several sessions asks for a session ID", async () => {
    await connect("tab-1", "alice", "Design", "tab-1", "file-a");
    await connect("tab-2", "alice", "Design", "tab-2", "file-a");
    await connect("tab-3", "alice", "Other", "tab-3", "file-c");
    await assert.rejects(run(undefined, "Design"), (error: Error) => {
        assert.match(
            error.message,
            /open in several Penpot sessions\. Ask the user to select one, then retry with its sessionId/
        );
        assert.match(error.message, /tab-1/);
        assert.match(error.message, /tab-2/);
        assert.doesNotMatch(error.message, /tab-3/);
        return true;
    });
    assert.equal((await run("tab-1", "Design")).data, "tab-1");
});

test("without a file argument the only session is still selected implicitly", async () => {
    await connect("tab-1", "alice", "Components", "tab-1", "file-a");
    assert.equal((await run()).data, "tab-1");
});

test("without a file argument several sessions still require a selection", async () => {
    await connectTwoFiles();
    await assert.rejects(run(), /Ask the user/);
});

test("a file argument follows a session that switches files", async () => {
    const socket = await connect("tab-1", "alice", "Components", "tab-1", "file-a");
    socket.send(JSON.stringify({ type: "context-update", context: { fileId: "file-b", fileName: "Screens" } }));
    // a task round trip on the same socket ensures the server has applied the update
    await run("tab-1");
    assert.equal((await run(undefined, "Screens")).data, "tab-1");
    await assert.rejects(run(undefined, "Components"), /No connected Penpot session has file "Components" open/);
});

test("list_connections reports each session's file and connection time", async () => {
    const tool = new ListConnectionsTool({ pluginBridge: bridge } as unknown as PenpotMcpServer);
    const [empty] = (await tool.execute({})).content as { text: string }[];
    assert.equal(empty.text, "No Penpot sessions are connected.");
    await connectTwoFiles();
    const [response] = (await tool.execute({})).content as { text: string }[];
    const sessions = JSON.parse(response.text);
    assert.deepEqual(
        sessions.map(({ sessionId, fileId, fileName }: Record<string, string>) => ({ sessionId, fileId, fileName })),
        [
            { sessionId: "tab-1", fileId: "file-a", fileName: "Components" },
            { sessionId: "tab-2", fileId: "file-b", fileName: "Screens" },
        ]
    );
    for (const session of sessions) assert.ok(!Number.isNaN(Date.parse(session.connectedAt)));
});
