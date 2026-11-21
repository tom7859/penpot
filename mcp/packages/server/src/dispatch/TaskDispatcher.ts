import type { PenpotSession } from "@penpot/mcp-common";
import type { PenpotConnection } from "../PenpotConnection";
import type { AbstractPluginTask } from "../PluginTask";
import type { UserPenpotConnections } from "../UserPenpotConnections";

/** Local connection access and tracked task execution provided by PluginBridge. */
export interface TaskDispatchHost {
    getUserConnections(userToken: string | null): UserPenpotConnections | undefined;
    sendLocalTask(task: AbstractPluginTask, connection: PenpotConnection): void;
    sendRemoteTask(task: AbstractPluginTask, userToken: string, sessionId: string): void;
    displaceConnection(connection: PenpotConnection): void;
}

/** Session discovery, task routing, and connection subscription lifecycle. */
export abstract class TaskDispatcher {
    abstract discoverSessions(userToken: string | null): Promise<PenpotSession[]>;
    abstract dispatch(
        task: AbstractPluginTask,
        userToken: string | null,
        sessionId?: string,
        file?: string
    ): Promise<void>;
    abstract onNewConnection(connection: PenpotConnection): Promise<void>;
    abstract onConnectionClosed(connection: PenpotConnection): Promise<void>;
    abstract close(): Promise<void>;

    /**
     * Resolves the target session, discovering sessions unless a session ID alone decides it.
     *
     * A file matches a ready tab by exact file ID, else by exact file name, else by case-insensitive
     * file name, and only the first tier with any match counts; a session ID given with it must be one
     * of those matches. A task routed by file carries the file's ID for the plugin to check.
     */
    protected async resolveSessionId(
        task: AbstractPluginTask,
        userToken: string | null,
        sessionId?: string,
        file?: string
    ): Promise<string> {
        if (file === undefined) {
            return sessionId ?? this.selectOnlySession(await this.discoverSessions(userToken));
        }
        const sessions = await this.discoverSessions(userToken);
        const ready = sessions.filter((session) => session.workspaceState === "ready");
        const lowerCaseFile = file.toLowerCase();
        const matchers = [
            (session: PenpotSession) => session.fileId === file,
            (session: PenpotSession) => session.fileName === file,
            (session: PenpotSession) => session.fileName?.toLowerCase() === lowerCaseFile,
        ];
        const matches = matchers.map((matcher) => ready.filter(matcher)).find((found) => found.length) ?? [];
        let target: PenpotSession | undefined;
        if (sessionId !== undefined) {
            if (!sessions.some((session) => session.sessionId === sessionId)) {
                throw new Error(
                    `Penpot session ${JSON.stringify(sessionId)} is not connected. ` +
                        `Connected sessions:\n${describeSessions(sessions)}`
                );
            }
            target = matches.find((session) => session.sessionId === sessionId);
            if (!target) {
                throw new Error(
                    `Penpot session ${JSON.stringify(sessionId)} does not have file ${JSON.stringify(file)} open and ready. ` +
                        `Connected sessions:\n${describeSessions(sessions)}`
                );
            }
        } else if (matches.length === 1) {
            target = matches[0];
        } else if (matches.length === 0) {
            throw new Error(
                `No connected Penpot session has file ${JSON.stringify(file)} open and ready. ` +
                    `Connected sessions:\n${describeSessions(sessions)}`
            );
        } else {
            throw new Error(
                `File ${JSON.stringify(file)} is open in several Penpot sessions. Ask the user to select one, ` +
                    `then retry with its sessionId:\n${describeSessions(matches)}`
            );
        }
        task.expectedFileId = target.fileId ?? undefined;
        return target.sessionId;
    }

    /** Selects the sole session from a complete discovery result. */
    protected selectOnlySession(sessions: PenpotSession[]): string {
        if (sessions.length === 0) {
            throw new Error("No Penpot sessions are connected. Please connect the Penpot MCP plugin and retry.");
        }
        if (sessions.length !== 1) {
            throw new Error(
                "Multiple Penpot sessions are connected. Ask the user to select one of the active sessions, " +
                    "then retry with its sessionId, or with the file it has open as `file`:\n" +
                    describeSessions(sessions)
            );
        }
        return sessions[0].sessionId;
    }
}

/** Lists sessions one per line, with the file each has open. */
function describeSessions(sessions: PenpotSession[]): string {
    if (sessions.length === 0) return "(none)";
    return sessions
        .map(
            (session) =>
                `${session.sessionId}: ${session.fileId ? `${JSON.stringify(session.fileName)} (file ${session.fileId}${session.workspaceState === "loading" ? ", loading" : ""})` : "no active workspace"}`
        )
        .join("\n");
}

/** Error returned when discovery cannot establish the complete set of sessions. */
export class SessionDiscoveryError extends Error {
    constructor() {
        super("Penpot session discovery failed. This may be due to temporary server load. You can retry the request.");
        this.name = "SessionDiscoveryError";
    }
}
