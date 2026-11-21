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
     * A file matches by exact file ID, else by exact file name, else by case-insensitive file name;
     * a session ID given with it must name a session that has the file open.
     */
    protected async resolveSessionId(userToken: string | null, sessionId?: string, file?: string): Promise<string> {
        if (file === undefined) {
            return sessionId ?? this.selectOnlySession(await this.discoverSessions(userToken));
        }
        const sessions = await this.discoverSessions(userToken);
        const lowerCaseFile = file.toLowerCase();
        const matchers = [
            (session: PenpotSession) => session.fileId === file,
            (session: PenpotSession) => session.fileName === file,
            (session: PenpotSession) => session.fileName?.toLowerCase() === lowerCaseFile,
        ];
        if (sessionId !== undefined) {
            const session = sessions.find((candidate) => candidate.sessionId === sessionId);
            if (session && matchers.some((matcher) => matcher(session))) return sessionId;
            throw new Error(
                `Penpot session ${JSON.stringify(sessionId)} does not have file ${JSON.stringify(file)} open. ` +
                    `Connected sessions:\n${describeSessions(sessions)}`
            );
        }
        const matches = matchers.map((matcher) => sessions.filter(matcher)).find((found) => found.length) ?? [];
        if (matches.length === 0) {
            throw new Error(
                `No connected Penpot session has file ${JSON.stringify(file)} open. ` +
                    `Connected sessions:\n${describeSessions(sessions)}`
            );
        }
        if (matches.length > 1) {
            throw new Error(
                `File ${JSON.stringify(file)} is open in several Penpot sessions. Ask the user to select one, ` +
                    `then retry with its sessionId:\n${describeSessions(matches)}`
            );
        }
        return matches[0].sessionId;
    }

    /** Selects the sole session from a complete discovery result. */
    protected selectOnlySession(sessions: PenpotSession[]): string {
        if (sessions.length === 0) {
            throw new Error("No Penpot sessions are connected. Please connect the Penpot MCP plugin and retry.");
        }
        if (sessions.length !== 1) {
            throw new Error(
                "Multiple Penpot sessions are connected. Ask the user to select one of the active sessions, " +
                    "then retry with its sessionId:\n" +
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
                `${session.sessionId}: ${session.fileId ? `${JSON.stringify(session.fileName)} (file ${session.fileId})` : "no active workspace"}`
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
